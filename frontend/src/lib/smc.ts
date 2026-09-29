/** Smart Money Concepts drawn on the price chart (the ◈ SMC button), as the same Shape list the
 *  ◇ Patterns overlay uses (autoPatternsPrimitive.ts):
 *   - order blocks  : the last opposite candle before the move that broke a swing (BOS),
 *                     kept until a close through it; "tested" once price has come back into it
 *   - fair value gaps: 3-candle imbalances (candle 1's high below candle 3's low, or the mirror),
 *                     shrinking as price fills them, gone when filled
 *   - liquidity     : equal highs / lows (two swings within ~0.15 ATR) not yet swept
 *   - premium / discount: the recent range split at 50% (equilibrium)
 *   - PDH / PDL / PWH / PWL: previous day / week high and low (IST sessions)
 *  Only closed candles go in; only the most recent few zones come out, so the chart stays readable. */
import type { Shape } from "./chartPatterns";

export type Candle = { time: number; open: number; high: number; low: number; close: number };
export type SmcOpts = {
  ob: boolean;
  fvg: boolean;
  liq: boolean;
  pd: boolean;
  levels: boolean;
  sweep?: boolean;
  struct?: boolean;
};

const C = {
  obBull: "#22c55e",
  obBear: "#ef4444",
  fvgBull: "#2dd4bf",
  fvgBear: "#fb7185",
  liq: "#e879f9",
  prem: "#ef4444",
  disc: "#22c55e",
  eq: "#94a3b8",
  pd: "#a5b4fc",
  pw: "#fbbf24",
  up: "#22c55e",
  down: "#ef4444",
};
const SWING_LEN = 10; // swing structure: pivots with 10 bars each side (internal uses PIVOT = 3)
const KEEP_SWEEP = 4;
const KEEP_EVT = 3; // structure events per kind (swing / internal)
const MAX_BARS = 500;
const PIVOT = 3; // bars each side for a swing high / low
const KEEP_OB = 3; // per side
const KEEP_FVG = 3; // per side
const KEEP_LIQ = 2; // per side
const fmt = (p: number) => p.toLocaleString("en-IN", { maximumFractionDigits: 2 });

function atrSeries(c: Candle[], n = 14): number[] {
  const out: number[] = [];
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? c[i].high - c[i].low : Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    a = i < n ? (a * i + tr) / (i + 1) : (a * (n - 1) + tr) / n;
    out.push(a);
  }
  return out;
}

type Swing = { i: number; p: number };
function swings(c: Candle[], len = PIVOT): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [];
  const lows: Swing[] = [];
  for (let i = len; i < c.length - len; i++) {
    let h = true;
    let l = true;
    for (let k = 1; k <= len; k++) {
      if (!(c[i].high > c[i - k].high && c[i].high >= c[i + k].high)) h = false;
      if (!(c[i].low < c[i - k].low && c[i].low <= c[i + k].low)) l = false;
    }
    if (h) highs.push({ i, p: c[i].high });
    if (l) lows.push({ i, p: c[i].low });
  }
  return { highs, lows };
}

export function detectSmc(all: Candle[], intervalS: number, o: SmcOpts): Shape[] {
  const c = all.slice(-MAX_BARS);
  if (c.length < 20) return [];
  const n = c.length;
  const lastT = c[n - 1].time;
  const atr = atrSeries(c);
  const out: Shape[] = [];
  const sw = swings(c);

  // ---- order blocks: walk the bars; a swing is usable once confirmed (PIVOT bars later) ----
  if (o.ob) {
    type OB = { dir: "bull" | "bear"; k: number; top: number; bottom: number; at: number; tested: boolean };
    const obs: OB[] = [];
    let hi: Swing | null = null;
    let lo: Swing | null = null;
    let hIx = 0;
    let lIx = 0;
    for (let i = 0; i < n; i++) {
      while (hIx < sw.highs.length && sw.highs[hIx].i + PIVOT <= i) hi = sw.highs[hIx++];
      while (lIx < sw.lows.length && sw.lows[lIx].i + PIVOT <= i) lo = sw.lows[lIx++];
      if (hi && c[i].close > hi.p) {
        // bullish break: the move started at the lowest bar since the swing; the OB is the last
        // down candle at / before it
        let m = hi.i;
        for (let j = hi.i; j <= i; j++) if (c[j].low < c[m].low) m = j;
        let k = m;
        while (k > hi.i && !(c[k].close < c[k].open)) k--;
        if (!(c[k].close < c[k].open)) k = m;
        obs.push({ dir: "bull", k, top: c[k].high, bottom: c[k].low, at: i, tested: false });
        hi = null;
      }
      if (lo && c[i].close < lo.p) {
        let m = lo.i;
        for (let j = lo.i; j <= i; j++) if (c[j].high > c[m].high) m = j;
        let k = m;
        while (k > lo.i && !(c[k].close > c[k].open)) k--;
        if (!(c[k].close > c[k].open)) k = m;
        obs.push({ dir: "bear", k, top: c[k].high, bottom: c[k].low, at: i, tested: false });
        lo = null;
      }
    }
    const alive = obs.filter((b) => {
      for (let j = b.at + 1; j < n; j++) {
        if (b.dir === "bull") {
          if (c[j].close < b.bottom) return false; // broken
          if (c[j].low <= b.top) b.tested = true;
        } else {
          if (c[j].close > b.top) return false;
          if (c[j].high >= b.bottom) b.tested = true;
        }
      }
      return true;
    });
    for (const dir of ["bull", "bear"] as const) {
      alive
        .filter((b) => b.dir === dir)
        .slice(-KEEP_OB)
        .forEach((b) =>
          out.push({
            kind: "box",
            t1: c[b.k].time,
            t2: lastT,
            top: b.top,
            bottom: b.bottom,
            color: dir === "bull" ? C.obBull : C.obBear,
            label: `${dir === "bull" ? "Bull" : "Bear"} OB${b.tested ? " · tested" : ""}`,
            labelBelow: dir === "bull",
          })
        );
    }
  }

  // ---- fair value gaps ----
  if (o.fvg) {
    type G = { dir: "bull" | "bear"; t: number; top: number; bottom: number; i: number };
    const gaps: G[] = [];
    for (let i = 2; i < n; i++) {
      const min = atr[i] * 0.25;
      if (c[i].low - c[i - 2].high > min) gaps.push({ dir: "bull", t: c[i - 1].time, top: c[i].low, bottom: c[i - 2].high, i });
      if (c[i - 2].low - c[i].high > min) gaps.push({ dir: "bear", t: c[i - 1].time, top: c[i - 2].low, bottom: c[i].high, i });
    }
    const open = gaps.filter((g) => {
      for (let j = g.i + 1; j < n; j++) {
        if (g.dir === "bull") {
          if (c[j].low <= g.bottom) return false; // filled
          if (c[j].low < g.top) g.top = c[j].low; // part-filled: what's left
        } else {
          if (c[j].high >= g.top) return false;
          if (c[j].high > g.bottom) g.bottom = c[j].high;
        }
      }
      return g.top > g.bottom;
    });
    for (const dir of ["bull", "bear"] as const) {
      open
        .filter((g) => g.dir === dir)
        .slice(-KEEP_FVG)
        .forEach((g) =>
          out.push({
            kind: "box",
            t1: g.t,
            t2: lastT,
            top: g.top,
            bottom: g.bottom,
            color: dir === "bull" ? C.fvgBull : C.fvgBear,
            label: "FVG",
            labelBelow: dir === "bull",
          })
        );
    }
  }

  // ---- liquidity: equal highs / lows, not yet swept ----
  if (o.liq) {
    const tolAt = (i: number) => atr[i] * 0.15;
    const pairs = (list: Swing[], up: boolean) => {
      const found: { a: Swing; b: Swing; lvl: number }[] = [];
      const recent = list.slice(-10);
      for (let x = 0; x < recent.length; x++)
        for (let y = x + 1; y < recent.length; y++) {
          const a = recent[x];
          const b = recent[y];
          if (Math.abs(a.p - b.p) > tolAt(b.i) || b.i - a.i < 3) continue;
          const lvl = up ? Math.max(a.p, b.p) : Math.min(a.p, b.p);
          let swept = false;
          for (let j = b.i + 1; j < n && !swept; j++) swept = up ? c[j].high > lvl : c[j].low < lvl;
          if (!swept) found.push({ a, b, lvl });
        }
      // the most recent distinct levels
      const uniq: typeof found = [];
      for (const f of found.sort((p, q) => q.b.i - p.b.i))
        if (!uniq.some((u) => Math.abs(u.lvl - f.lvl) <= tolAt(f.b.i))) uniq.push(f);
      return uniq.slice(0, KEEP_LIQ);
    };
    for (const f of pairs(sw.highs, true))
      out.push({ kind: "line", t1: c[f.a.i].time, p1: f.lvl, t2: lastT, p2: f.lvl, color: C.liq, dash: true, label: `EQH ${fmt(f.lvl)}` });
    for (const f of pairs(sw.lows, false))
      out.push({ kind: "line", t1: c[f.a.i].time, p1: f.lvl, t2: lastT, p2: f.lvl, color: C.liq, dash: true, label: `EQL ${fmt(f.lvl)}` });
  }

  // ---- premium / discount: the last ~100 bars' range, split at 50% ----
  if (o.pd) {
    const w = c.slice(-Math.min(100, n));
    let hiI = 0;
    let loI = 0;
    w.forEach((k, i) => {
      if (k.high > w[hiI].high) hiI = i;
      if (k.low < w[loI].low) loI = i;
    });
    const top = w[hiI].high;
    const bot = w[loI].low;
    const eq = (top + bot) / 2;
    const t1 = w[Math.min(hiI, loI)].time;
    if (top > bot) {
      out.push({ kind: "box", t1, t2: lastT, top, bottom: eq, color: C.prem, label: "Premium", faint: true });
      out.push({ kind: "box", t1, t2: lastT, top: eq, bottom: bot, color: C.disc, label: "Discount", labelBelow: true, faint: true });
      out.push({ kind: "line", t1, p1: eq, t2: lastT, p2: eq, color: C.eq, dash: true, label: `EQ ${fmt(eq)}` });
    }
  }

  // ---- previous day / week high & low (IST) ----
  if (o.levels && intervalS < 7 * 86400) {
    const dayOf = (t: number) => Math.floor((t + 19800) / 86400);
    const weekOf = (t: number) => Math.floor((dayOf(t) + 3) / 7); // weeks start Monday
    const lastDay = dayOf(lastT);
    const lastWeek = weekOf(lastT);
    const range = (pick: (k: Candle) => boolean) => {
      let h = -Infinity;
      let l = Infinity;
      for (const k of all) if (pick(k)) {
        h = Math.max(h, k.high);
        l = Math.min(l, k.low);
      }
      return h > l ? { h, l } : null;
    };
    // the line runs from the start of today's (this week's) first bar to the latest bar
    const firstOf = (pick: (k: Candle) => boolean) => c.find(pick)?.time ?? lastT;
    if (intervalS < 86400) {
      const prevDay = Math.max(...all.map((k) => dayOf(k.time)).filter((d) => d < lastDay), -Infinity);
      const pd = Number.isFinite(prevDay) ? range((k) => dayOf(k.time) === prevDay) : null;
      if (pd) {
        const t1 = firstOf((k) => dayOf(k.time) === lastDay);
        out.push({ kind: "line", t1, p1: pd.h, t2: lastT, p2: pd.h, color: C.pd, label: `PDH ${fmt(pd.h)}` });
        out.push({ kind: "line", t1, p1: pd.l, t2: lastT, p2: pd.l, color: C.pd, label: `PDL ${fmt(pd.l)}` });
      }
    }
    const prevWeek = Math.max(...all.map((k) => weekOf(k.time)).filter((w) => w < lastWeek), -Infinity);
    const pw = Number.isFinite(prevWeek) ? range((k) => weekOf(k.time) === prevWeek) : null;
    if (pw) {
      const t1 = firstOf((k) => weekOf(k.time) === lastWeek);
      out.push({ kind: "line", t1, p1: pw.h, t2: lastT, p2: pw.h, color: C.pw, dash: true, label: `PWH ${fmt(pw.h)}` });
      out.push({ kind: "line", t1, p1: pw.l, t2: lastT, p2: pw.l, color: C.pw, dash: true, label: `PWL ${fmt(pw.l)}` });
    }
  }
  // ---- liquidity sweeps: a wick through a swing high / low that closes back inside ----
  if (o.sweep) {
    type Sw = { up: boolean; from: number; i: number; p: number };
    const found: Sw[] = [];
    let hi: Swing | null = null;
    let lo: Swing | null = null;
    let hIx = 0;
    let lIx = 0;
    for (let i = 0; i < n; i++) {
      while (hIx < sw.highs.length && sw.highs[hIx].i + PIVOT <= i) hi = sw.highs[hIx++];
      while (lIx < sw.lows.length && sw.lows[lIx].i + PIVOT <= i) lo = sw.lows[lIx++];
      if (hi && c[i].high > hi.p) {
        if (c[i].close < hi.p) found.push({ up: true, from: hi.i, i, p: hi.p }); // took the stops, closed back below
        hi = null; // swept or broken: either way this high is spent
      }
      if (lo && c[i].low < lo.p) {
        if (c[i].close > lo.p) found.push({ up: false, from: lo.i, i, p: lo.p });
        lo = null;
      }
    }
    for (const f of found.slice(-KEEP_SWEEP)) {
      // the swept level (from the swing to the sweep bar) + a tag on the sweeping candle
      out.push({ kind: "line", t1: c[f.from].time, p1: f.p, t2: c[f.i].time, p2: f.p, color: f.up ? C.down : C.up, dash: true });
      out.push({
        kind: "text",
        t: c[f.i].time,
        p: f.up ? c[f.i].high : c[f.i].low,
        text: f.up ? "Sweep ▼" : "Sweep ▲",
        color: f.up ? C.down : C.up,
        above: f.up,
      });
    }
  }

  // ---- swing (big, solid) vs internal (small, dashed) structure: BOS / CHoCH ----
  if (o.struct) {
    const events = (s: { highs: Swing[]; lows: Swing[] }, len: number, internal: boolean) => {
      type E = { up: boolean; from: number; i: number; p: number; kind: "BOS" | "CHoCH" };
      const ev: E[] = [];
      let trend: "up" | "down" | null = null;
      let hi: Swing | null = null;
      let lo: Swing | null = null;
      let hIx = 0;
      let lIx = 0;
      for (let i = 0; i < n; i++) {
        while (hIx < s.highs.length && s.highs[hIx].i + len <= i) hi = s.highs[hIx++];
        while (lIx < s.lows.length && s.lows[lIx].i + len <= i) lo = s.lows[lIx++];
        if (hi && c[i].close > hi.p) {
          ev.push({ up: true, from: hi.i, i, p: hi.p, kind: trend === "down" ? "CHoCH" : "BOS" });
          trend = "up";
          hi = null;
        }
        if (lo && c[i].close < lo.p) {
          ev.push({ up: false, from: lo.i, i, p: lo.p, kind: trend === "up" ? "CHoCH" : "BOS" });
          trend = "down";
          lo = null;
        }
      }
      return ev.slice(-KEEP_EVT).map((e) => ({
        kind: "line" as const,
        t1: c[e.from].time,
        p1: e.p,
        t2: c[e.i].time,
        p2: e.p,
        color: e.up ? C.up : C.down,
        dash: internal,
        label: internal ? `i${e.kind}` : e.kind,
      }));
    };
    out.push(...events(sw, PIVOT, true));
    out.push(...events(swings(c, SWING_LEN), SWING_LEN, false));
  }
  return out;
}
