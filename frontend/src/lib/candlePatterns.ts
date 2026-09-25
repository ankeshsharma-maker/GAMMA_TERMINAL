import type { Candle } from "./indicators";

/** A candlestick pattern that completed on the bar at `time`. */
export interface PatternHit {
  time: number;
  name: string;
  /** short label drawn on the chart */
  short: string;
  bias: "bull" | "bear" | "neutral";
}

/** The patterns we look for, with the label drawn on the chart (also the ƒx legend). */
export const PATTERN_LEGEND: { short: string; name: string; bias: PatternHit["bias"] }[] = [
  { short: "MS", name: "Morning star", bias: "bull" },
  { short: "ES", name: "Evening star", bias: "bear" },
  { short: "3WS", name: "Three white soldiers", bias: "bull" },
  { short: "3BC", name: "Three black crows", bias: "bear" },
  { short: "BE", name: "Bullish engulfing", bias: "bull" },
  { short: "BE", name: "Bearish engulfing", bias: "bear" },
  { short: "PL", name: "Piercing line", bias: "bull" },
  { short: "DC", name: "Dark cloud cover", bias: "bear" },
  { short: "HR", name: "Bullish harami", bias: "bull" },
  { short: "HR", name: "Bearish harami", bias: "bear" },
  { short: "H", name: "Hammer", bias: "bull" },
  { short: "IH", name: "Inverted hammer", bias: "bull" },
  { short: "HM", name: "Hanging man", bias: "bear" },
  { short: "SS", name: "Shooting star", bias: "bear" },
  { short: "D", name: "Doji (after a move)", bias: "neutral" },
];

/** how far (in typical bar ranges) price must have moved into a reversal pattern */
const MOVE = 1.2;

const hit = (time: number, name: string, bias: PatternHit["bias"]): PatternHit => ({
  time,
  name,
  bias,
  short: PATTERN_LEGEND.find((p) => p.name === name || p.name.startsWith(name))?.short ?? name,
});

/**
 * Classic candlestick patterns on `cs` (oldest first), at most one per bar -- the
 * strongest wins (3-bar > 2-bar > 1-bar). Reversal patterns need the move they
 * reverse: a hammer only counts after a fall, a shooting star only after a rise,
 * so a quiet sideways tape doesn't fill the chart with symbols. Pass CLOSED bars
 * only: a pattern on the bar still forming would appear and vanish with the price.
 */
export function detectPatterns(cs: Candle[]): PatternHit[] {
  const out: PatternHit[] = [];
  if (cs.length < 6) return out;
  const body = (c: Candle) => Math.abs(c.close - c.open);
  const range = (c: Candle) => c.high - c.low;
  const upper = (c: Candle) => c.high - Math.max(c.open, c.close);
  const lower = (c: Candle) => Math.min(c.open, c.close) - c.low;
  const bull = (c: Candle) => c.close > c.open;
  const bear = (c: Candle) => c.close < c.open;
  const mid = (c: Candle) => (c.open + c.close) / 2;

  for (let i = 5; i < cs.length; i++) {
    const c = cs[i];
    const p = cs[i - 1];
    const q = cs[i - 2];
    // typical body / range of the 10 bars before this one
    let sb = 0;
    let sr = 0;
    let n = 0;
    for (let j = Math.max(0, i - 10); j < i; j++) {
      sb += body(cs[j]);
      sr += range(cs[j]);
      n++;
    }
    const avgB = sb / n || 1e-9;
    const avgR = sr / n || 1e-9;
    // the move into this bar: the 4 bars before it (before the 3 bars of a 3-bar pattern)
    const moveInto = (k: number) => cs[k - 1].close - cs[Math.max(0, k - 5)].close;
    const downInto = (k: number) => moveInto(k) < -MOVE * avgR;
    const upInto = (k: number) => moveInto(k) > MOVE * avgR;
    const big = (x: Candle) => body(x) >= avgB;
    const small = (x: Candle) => body(x) <= 0.35 * avgB;
    const t = c.time as number;

    // ---- 3-bar ----
    if (downInto(i - 2) && bear(q) && big(q) && small(p) && bull(c) && c.close > mid(q)) {
      out.push(hit(t, "Morning star", "bull"));
      continue;
    }
    if (upInto(i - 2) && bull(q) && big(q) && small(p) && bear(c) && c.close < mid(q)) {
      out.push(hit(t, "Evening star", "bear"));
      continue;
    }
    const soldier = (x: Candle, prev: Candle) =>
      bull(x) && body(x) >= 0.6 * avgB && x.close > prev.close && x.open >= prev.open && x.open <= prev.close && upper(x) <= 0.4 * body(x);
    if (bull(q) && body(q) >= 0.6 * avgB && soldier(p, q) && soldier(c, p) && !upInto(i - 2)) {
      out.push(hit(t, "Three white soldiers", "bull"));
      continue;
    }
    const crow = (x: Candle, prev: Candle) =>
      bear(x) && body(x) >= 0.6 * avgB && x.close < prev.close && x.open <= prev.open && x.open >= prev.close && lower(x) <= 0.4 * body(x);
    if (bear(q) && body(q) >= 0.6 * avgB && crow(p, q) && crow(c, p) && !downInto(i - 2)) {
      out.push(hit(t, "Three black crows", "bear"));
      continue;
    }

    // ---- 2-bar ----
    const down = downInto(i - 1);
    const up = upInto(i - 1);
    if (down && bear(p) && bull(c) && c.open <= p.close && c.close >= p.open && body(c) > body(p)) {
      out.push(hit(t, "Bullish engulfing", "bull"));
      continue;
    }
    if (up && bull(p) && bear(c) && c.open >= p.close && c.close <= p.open && body(c) > body(p)) {
      out.push(hit(t, "Bearish engulfing", "bear"));
      continue;
    }
    if (down && bear(p) && big(p) && bull(c) && c.open <= p.close && c.close > mid(p) && c.close < p.open) {
      out.push(hit(t, "Piercing line", "bull"));
      continue;
    }
    if (up && bull(p) && big(p) && bear(c) && c.open >= p.close && c.close < mid(p) && c.close > p.open) {
      out.push(hit(t, "Dark cloud cover", "bear"));
      continue;
    }
    const inside = Math.max(c.open, c.close) <= Math.max(p.open, p.close) && Math.min(c.open, c.close) >= Math.min(p.open, p.close);
    if (down && bear(p) && big(p) && bull(c) && inside && body(c) <= 0.5 * body(p)) {
      out.push(hit(t, "Bullish harami", "bull"));
      continue;
    }
    if (up && bull(p) && big(p) && bear(c) && inside && body(c) <= 0.5 * body(p)) {
      out.push(hit(t, "Bearish harami", "bear"));
      continue;
    }

    // ---- 1-bar (needs a real candle, not a flat tick) ----
    const r = range(c);
    if (r < 0.6 * avgR) continue;
    const b = body(c);
    const downC = downInto(i);
    const upC = upInto(i);
    const longLower = lower(c) >= 2 * b && upper(c) <= 0.25 * r && b >= 0.05 * r;
    const longUpper = upper(c) >= 2 * b && lower(c) <= 0.25 * r && b >= 0.05 * r;
    if (longLower && downC) out.push(hit(t, "Hammer", "bull"));
    else if (longLower && upC) out.push(hit(t, "Hanging man", "bear"));
    else if (longUpper && downC) out.push(hit(t, "Inverted hammer", "bull"));
    else if (longUpper && upC) out.push(hit(t, "Shooting star", "bear"));
    else if (b <= 0.05 * r && (downC || upC)) out.push(hit(t, "Doji", "neutral"));
  }
  return out;
}
