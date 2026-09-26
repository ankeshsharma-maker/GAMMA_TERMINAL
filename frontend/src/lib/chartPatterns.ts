import type { Candle } from "./indicators";
import { IST_OFFSET_S } from "./istTime";

/** Something drawn on the price pane, in chart units (bar time, price). */
export type Shape =
  | { kind: "line"; t1: number; p1: number; t2: number; p2: number; color: string; dash?: boolean; label?: string }
  | { kind: "box"; t1: number; t2: number; top: number; bottom: number; color: string; label?: string };

/** A breakout / confirmation on one bar -- drawn as a marker on that bar. */
export interface ChartEvent {
  time: number;
  dir: "up" | "down";
  short: string;
  name: string;
}

export interface AutoPatterns {
  shapes: Shape[];
  events: ChartEvent[];
}

const UP = "#16a34a";
const DOWN = "#dc2626";
const RANGE = "#94a3b8";
const TRI = "#22d3ee";
const ORB = "#a78bfa";

/** Wilder-less ATR: the plain average true range over `n` bars, one value per bar. */
function atr(cs: Candle[], n = 14): number[] {
  const tr = cs.map((c, i) =>
    i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - cs[i - 1].close), Math.abs(c.low - cs[i - 1].close))
  );
  const out: number[] = [];
  let s = 0;
  for (let i = 0; i < cs.length; i++) {
    s += tr[i];
    if (i >= n) s -= tr[i - n];
    out.push(s / Math.min(i + 1, n));
  }
  return out;
}

type Pivot = { i: number; price: number; hi: boolean };

/** Swing highs / lows (a bar that is the extreme of the k bars on each side), cut down
 *  to an alternating high-low-high zig-zag where each leg moves at least `minMove` ATRs. */
function zigzag(cs: Candle[], a: number[], k = 3, minMove = 1.2): Pivot[] {
  const raw: Pivot[] = [];
  for (let i = k; i < cs.length - k; i++) {
    let isH = true;
    let isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (cs[j].high > cs[i].high) isH = false;
      if (cs[j].low < cs[i].low) isL = false;
    }
    if (isH) raw.push({ i, price: cs[i].high, hi: true });
    if (isL) raw.push({ i, price: cs[i].low, hi: false });
  }
  const zz: Pivot[] = [];
  for (const p of raw) {
    const last = zz[zz.length - 1];
    if (!last) {
      zz.push(p);
    } else if (last.hi === p.hi) {
      // same side again: keep the more extreme one
      if ((p.hi && p.price >= last.price) || (!p.hi && p.price <= last.price)) zz[zz.length - 1] = p;
    } else if (Math.abs(p.price - last.price) >= minMove * a[p.i]) {
      zz.push(p);
    }
  }
  return zz;
}

/** Sideways ranges (a run of >= 12 bars inside ~2.2 ATR) and the close that breaks out of
 *  them. Keeps the last 2 that broke out, plus the range price is in right now. */
function ranges(cs: Candle[], a: number[]): AutoPatterns {
  const shapes: Shape[] = [];
  const events: ChartEvent[] = [];
  const MIN = 12;
  const found: { s: number; e: number; top: number; bot: number; bo?: ChartEvent }[] = [];
  let s = 14;
  while (s < cs.length - MIN) {
    const lim = 2.2 * a[s];
    let top = cs[s].high;
    let bot = cs[s].low;
    let e = s;
    while (e + 1 < cs.length) {
      const nt = Math.max(top, cs[e + 1].high);
      const nb = Math.min(bot, cs[e + 1].low);
      if (nt - nb > lim) break;
      top = nt;
      bot = nb;
      e++;
    }
    if (e - s + 1 < MIN) {
      s++;
      continue;
    }
    const nx = cs[e + 1];
    let bo: ChartEvent | undefined;
    if (nx && nx.close > top) bo = { time: nx.time as number, dir: "up", short: "BO", name: `Range breakout above ${top.toFixed(1)}` };
    else if (nx && nx.close < bot) bo = { time: nx.time as number, dir: "down", short: "BD", name: `Range breakdown below ${bot.toFixed(1)}` };
    if (bo || e === cs.length - 1) found.push({ s, e, top, bot, bo });
    s = e + 1;
  }
  const active = found.length && found[found.length - 1].e === cs.length - 1 ? found[found.length - 1] : null;
  const broke = found.filter((r) => r.bo).slice(-2);
  for (const r of active ? [...broke, active] : broke) {
    const color = r.bo ? (r.bo.dir === "up" ? UP : DOWN) : RANGE;
    shapes.push({
      kind: "box",
      t1: cs[r.s].time as number,
      t2: cs[r.e].time as number,
      top: r.top,
      bottom: r.bot,
      color,
      label: `${r.bo ? "" : "in range "}${r.bot.toFixed(0)}–${r.top.toFixed(0)}`,
    });
    if (r.bo) events.push(r.bo);
  }
  return { shapes, events };
}

/** Opening range (09:15-09:30 IST) of the last 2 sessions: its high / low as lines and
 *  the first close beyond each after 09:30. Intraday charts of 15 min or less only. */
function openingRange(cs: Candle[], intervalS: number): AutoPatterns {
  const shapes: Shape[] = [];
  const events: ChartEvent[] = [];
  if (!(intervalS > 0 && intervalS <= 900)) return { shapes, events };
  const OPEN = 9 * 3600 + 15 * 60;
  const OR_END = OPEN + 15 * 60;
  const days = new Map<number, Candle[]>();
  for (const c of cs) {
    const t = (c.time as number) + IST_OFFSET_S;
    const d = Math.floor(t / 86400);
    if (!days.has(d)) days.set(d, []);
    days.get(d)!.push(c);
  }
  const lastDays = [...days.keys()].sort((x, y) => x - y).slice(-2);
  for (const d of lastDays) {
    const bars = days.get(d)!;
    const sod = (c: Candle) => ((c.time as number) + IST_OFFSET_S) % 86400;
    const or = bars.filter((c) => sod(c) >= OPEN && sod(c) < OR_END);
    if (!or.length) continue;
    const hi = Math.max(...or.map((c) => c.high));
    const lo = Math.min(...or.map((c) => c.low));
    const t1 = or[0].time as number;
    const t2 = bars[bars.length - 1].time as number;
    shapes.push({ kind: "line", t1, p1: hi, t2, p2: hi, color: ORB, dash: true, label: `ORH ${hi.toFixed(0)}` });
    shapes.push({ kind: "line", t1, p1: lo, t2, p2: lo, color: ORB, dash: true, label: `ORL ${lo.toFixed(0)}` });
    const after = bars.filter((c) => sod(c) >= OR_END);
    const up = after.find((c) => c.close > hi);
    const dn = after.find((c) => c.close < lo);
    if (up) events.push({ time: up.time as number, dir: "up", short: "ORB", name: `Opening-range breakout above ${hi.toFixed(1)}` });
    if (dn) events.push({ time: dn.time as number, dir: "down", short: "ORB", name: `Opening-range breakdown below ${lo.toFixed(1)}` });
  }
  return { shapes, events };
}

/** Double top / bottom and head & shoulders (plus inverse) from the zig-zag, confirmed
 *  when a close crosses the neckline; the latest one still waiting for that is drawn
 *  dashed with a "?". */
function reversals(cs: Candle[], a: number[], zz: Pivot[]): AutoPatterns {
  const shapes: Shape[] = [];
  const events: ChartEvent[] = [];
  const t = (i: number) => cs[i].time as number;
  const used = new Set<number>();
  const hits: { end: number; shapes: Shape[]; ev?: ChartEvent }[] = [];

  // a close through `level(j)` in the 40 bars after bar `from`
  const confirm = (from: number, level: (j: number) => number, down: boolean) => {
    for (let j = from + 1; j < Math.min(cs.length, from + 41); j++) {
      if (down ? cs[j].close < level(j) : cs[j].close > level(j)) return j;
    }
    return -1;
  };

  // head & shoulders: shoulder, trough, head, trough, shoulder
  for (let k = 0; k + 4 < zz.length; k++) {
    const [ls, t1, hd, t2, rs] = zz.slice(k, k + 5);
    const top = ls.hi;
    const A = a[hd.i];
    const headOut = top ? hd.price - Math.max(ls.price, rs.price) : Math.min(ls.price, rs.price) - hd.price;
    if (headOut < 0.8 * A || Math.abs(ls.price - rs.price) > 1.5 * A) continue;
    // a real H&S: a near-flat neckline, both shoulders well clear of it, and the
    // two halves of similar length (not three random swings)
    const neckMid = (t1.price + t2.price) / 2;
    const height = Math.abs(hd.price - neckMid);
    if (Math.abs(t1.price - t2.price) > 0.35 * height) continue;
    const clear = (p: Pivot) => (top ? p.price - neckMid : neckMid - p.price) >= 0.35 * height;
    if (!clear(ls) || !clear(rs)) continue;
    const ratio = (rs.i - hd.i) / Math.max(1, hd.i - ls.i);
    if (ratio < 1 / 3 || ratio > 3) continue;
    const slope = (t2.price - t1.price) / (t2.i - t1.i);
    const neck = (j: number) => t1.price + slope * (j - t1.i);
    const j = confirm(rs.i, neck, top);
    const name = top ? "Head & shoulders" : "Inverse head & shoulders";
    const color = top ? DOWN : UP;
    const endI = j >= 0 ? j : cs.length - 1;
    if (j < 0 && rs.i < cs.length - 25) continue; // old and never confirmed: not a pattern
    const s: Shape[] = [
      { kind: "line", t1: t(ls.i), p1: ls.price, t2: t(t1.i), p2: t1.price, color, dash: j < 0 },
      { kind: "line", t1: t(t1.i), p1: t1.price, t2: t(hd.i), p2: hd.price, color, dash: j < 0, label: j < 0 ? `${name}?` : name },
      { kind: "line", t1: t(hd.i), p1: hd.price, t2: t(t2.i), p2: t2.price, color, dash: j < 0 },
      { kind: "line", t1: t(t2.i), p1: t2.price, t2: t(rs.i), p2: rs.price, color, dash: j < 0 },
      { kind: "line", t1: t(t1.i), p1: t1.price, t2: t(endI), p2: neck(endI), color, dash: true, label: "neckline" },
    ];
    hits.push({
      end: endI,
      shapes: s,
      ev: j >= 0 ? { time: t(j), dir: top ? "down" : "up", short: top ? "H&S" : "iH&S", name: `${name} confirmed (neckline broken)` } : undefined,
    });
    [ls, t1, hd, t2, rs].forEach((p) => used.add(p.i));
  }

  // double top / bottom: peak, trough, peak at about the same level
  for (let k = 0; k + 2 < zz.length; k++) {
    const [p1, mid, p2] = zz.slice(k, k + 3);
    if (used.has(p1.i) && used.has(p2.i)) continue;
    const top = p1.hi;
    const A = a[p2.i];
    if (Math.abs(p1.price - p2.price) > 0.6 * A || p2.i - p1.i < 6) continue;
    const depth = top ? Math.min(p1.price, p2.price) - mid.price : mid.price - Math.max(p1.price, p2.price);
    if (depth < 2 * A) continue;
    const j = confirm(p2.i, () => mid.price, top);
    if (j < 0 && p2.i < cs.length - 20) continue;
    const name = top ? "Double top" : "Double bottom";
    const color = top ? DOWN : UP;
    const endI = j >= 0 ? j : cs.length - 1;
    hits.push({
      end: endI,
      shapes: [
        { kind: "line", t1: t(p1.i), p1: p1.price, t2: t(mid.i), p2: mid.price, color, dash: j < 0 },
        { kind: "line", t1: t(mid.i), p1: mid.price, t2: t(p2.i), p2: p2.price, color, dash: j < 0, label: j < 0 ? `${name}?` : name },
        { kind: "line", t1: t(mid.i), p1: mid.price, t2: t(endI), p2: mid.price, color, dash: true, label: "neckline" },
      ],
      ev: j >= 0 ? { time: t(j), dir: top ? "down" : "up", short: top ? "DT" : "DB", name: `${name} confirmed (neckline ${mid.price.toFixed(1)} broken)` } : undefined,
    });
  }

  for (const h of hits.sort((x, y) => x.end - y.end).slice(-2)) {
    shapes.push(...h.shapes);
    if (h.ev) events.push(h.ev);
  }
  return { shapes, events };
}

/** The triangle the latest swings are forming -- ascending (flat highs, rising lows),
 *  descending (falling highs, flat lows) or symmetrical -- and the close that breaks it. */
function triangle(cs: Candle[], a: number[], zz: Pivot[]): AutoPatterns {
  const shapes: Shape[] = [];
  const events: ChartEvent[] = [];
  const last = zz.slice(-5);
  const hs = last.filter((p) => p.hi).slice(-2);
  const ls = last.filter((p) => !p.hi).slice(-2);
  if (hs.length < 2 || ls.length < 2) return { shapes, events };
  const start = Math.min(hs[0].i, ls[0].i);
  const endP = Math.max(hs[1].i, ls[1].i);
  if (endP - start < 10 || start < cs.length - 150) return { shapes, events };
  // both lines must start together -- not a line from last week against one from today
  if (Math.abs(hs[0].i - ls[0].i) > 0.5 * (endP - start)) return { shapes, events };
  const A = a[endP];
  const sH = (hs[1].price - hs[0].price) / (hs[1].i - hs[0].i);
  const sL = (ls[1].price - ls[0].price) / (ls[1].i - ls[0].i);
  const span = endP - start;
  const flat = (s: number) => Math.abs(s * span) <= 0.6 * A;
  let name = "";
  if (flat(sH) && sL > 0 && !flat(sL)) name = "Ascending triangle";
  else if (flat(sL) && sH < 0 && !flat(sH)) name = "Descending triangle";
  else if (sH < 0 && sL > 0 && !flat(sH) && !flat(sL)) name = "Symmetrical triangle";
  if (!name) return { shapes, events };
  const up = (j: number) => hs[0].price + sH * (j - hs[0].i);
  const lo = (j: number) => ls[0].price + sL * (j - ls[0].i);
  let j = endP + 1;
  let ev: ChartEvent | undefined;
  for (; j < cs.length; j++) {
    if (up(j) <= lo(j)) break; // the lines met: no breakout, the pattern is spent
    if (cs[j].close > up(j)) {
      ev = { time: cs[j].time as number, dir: "up", short: "△", name: `${name} breakout (up)` };
      break;
    }
    if (cs[j].close < lo(j)) {
      ev = { time: cs[j].time as number, dir: "down", short: "△", name: `${name} breakdown` };
      break;
    }
  }
  const endI = Math.min(j, cs.length - 1);
  if (!ev && endI < cs.length - 1) return { shapes, events }; // lines met long ago
  const t = (i: number) => cs[i].time as number;
  shapes.push(
    { kind: "line", t1: t(hs[0].i), p1: hs[0].price, t2: t(endI), p2: up(endI), color: TRI, label: ev ? name : `${name} (forming)` },
    { kind: "line", t1: t(ls[0].i), p1: ls[0].price, t2: t(endI), p2: lo(endI), color: TRI }
  );
  if (ev) events.push(ev);
  return { shapes, events };
}

/** Everything auto-detected for the chart. Pass CLOSED bars only. */
export function detectChartPatterns(
  cs: Candle[],
  intervalS: number,
  want: { ranges: boolean; patterns: boolean }
): AutoPatterns {
  const out: AutoPatterns = { shapes: [], events: [] };
  if (cs.length < 30) return out;
  const a = atr(cs);
  const parts: AutoPatterns[] = [];
  if (want.ranges) parts.push(ranges(cs, a), openingRange(cs, intervalS));
  if (want.patterns) {
    const zz = zigzag(cs, a);
    parts.push(reversals(cs, a, zz), triangle(cs, a, zz));
  }
  for (const p of parts) {
    out.shapes.push(...p.shapes);
    out.events.push(...p.events);
  }
  return out;
}
