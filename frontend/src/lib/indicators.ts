export interface Pt {
  time: number;
  value: number;
}
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export const ema = (candles: Candle[], period: number): Pt[] => {
  if (candles.length < period) return [];
  const k = 2 / (period + 1);
  const out: Pt[] = [];
  let prev = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  out.push({ time: candles[period - 1].time, value: prev });
  for (let i = period; i < candles.length; i++) {
    prev = candles[i].close * k + prev * (1 - k);
    out.push({ time: candles[i].time, value: prev });
  }
  return out;
};

export const sma = (candles: Candle[], period: number): Pt[] => {
  const out: Pt[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += candles[j].close;
    out.push({ time: candles[i].time, value: s / period });
  }
  return out;
};

export const bollinger = (
  candles: Candle[],
  period = 20,
  mult = 2
): { upper: Pt[]; lower: Pt[]; mid: Pt[] } => {
  const mid: Pt[] = [];
  const upper: Pt[] = [];
  const lower: Pt[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const win = candles.slice(i - period + 1, i + 1).map((c) => c.close);
    const m = win.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / period);
    const t = candles[i].time;
    mid.push({ time: t, value: m });
    upper.push({ time: t, value: m + mult * sd });
    lower.push({ time: t, value: m - mult * sd });
  }
  return { upper, lower, mid };
};

export const rsi = (candles: Candle[], period = 14): Pt[] => {
  if (candles.length <= period) return [];
  const out: Pt[] = [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out.push({ time: candles[period].time, value: 100 - 100 / (1 + gain / (loss || 1e-9)) });
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out.push({ time: candles[i].time, value: 100 - 100 / (1 + gain / (loss || 1e-9)) });
  }
  return out;
};

/** Re-bucket 1-unit candles into a coarser interval (seconds). */
export const resample = (candles: Candle[], intervalS: number): Candle[] => {
  const buckets = new Map<number, Candle>();
  for (const c of candles) {
    const b = Math.floor(c.time / intervalS) * intervalS;
    const cur = buckets.get(b);
    if (!cur) buckets.set(b, { ...c, time: b });
    else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
};

export const macd = (
  candles: Candle[],
  fast = 12,
  slow = 26,
  signal = 9
): { macd: Pt[]; signal: Pt[]; hist: Pt[] } => {
  if (candles.length < slow + signal) return { macd: [], signal: [], hist: [] };
  const emaArr = (period: number): number[] => {
    const k = 2 / (period + 1);
    const out: number[] = [];
    let prev = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
    for (let i = 0; i < candles.length; i++) {
      if (i < period - 1) out.push(NaN);
      else if (i === period - 1) out.push(prev);
      else {
        prev = candles[i].close * k + prev * (1 - k);
        out.push(prev);
      }
    }
    return out;
  };
  const ef = emaArr(fast);
  const es = emaArr(slow);
  const macdLine: Pt[] = [];
  const macdVals: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (Number.isNaN(ef[i]) || Number.isNaN(es[i])) {
      macdVals.push(NaN);
      continue;
    }
    const v = ef[i] - es[i];
    macdVals.push(v);
    macdLine.push({ time: candles[i].time, value: v });
  }
  const start = macdVals.findIndex((v) => !Number.isNaN(v));
  const k = 2 / (signal + 1);
  const sigLine: Pt[] = [];
  const hist: Pt[] = [];
  let prev = NaN;
  for (let i = start; i < candles.length; i++) {
    if (Number.isNaN(macdVals[i])) continue;
    if (Number.isNaN(prev)) {
      const win = macdVals.slice(i, i + signal).filter((v) => !Number.isNaN(v));
      if (win.length < signal) continue;
      prev = win.reduce((a, b) => a + b, 0) / signal;
      i += signal - 1;
      sigLine.push({ time: candles[i].time, value: prev });
      hist.push({ time: candles[i].time, value: macdVals[i] - prev });
      continue;
    }
    prev = macdVals[i] * k + prev * (1 - k);
    sigLine.push({ time: candles[i].time, value: prev });
    hist.push({ time: candles[i].time, value: macdVals[i] - prev });
  }
  return { macd: macdLine, signal: sigLine, hist };
};

export const vwap = (candles: Candle[]): Pt[] => {
  const out: Pt[] = [];
  let cumPV = 0;
  let cumV = 0;
  let day = -1;
  for (const c of candles) {
    const d = Math.floor(c.time / 86400);
    if (d !== day) {
      day = d;
      cumPV = 0;
      cumV = 0;
    }
    const tp = (c.high + c.low + c.close) / 3;
    const v = c.volume ?? 0;
    cumPV += tp * v;
    cumV += v;
    if (cumV > 0) out.push({ time: c.time, value: cumPV / cumV });
  }
  return out;
};

export const atr = (candles: Candle[], period = 14): number[] => {
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) tr.push(candles[i].high - candles[i].low);
    else {
      const c = candles[i];
      const pc = candles[i - 1].close;
      tr.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
    }
  }
  const out: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
};

/** Supertrend line (period=10, mult=3). */
export const supertrend = (candles: Candle[], period = 10, mult = 3): Pt[] => {
  const a = atr(candles, period);
  const out: Pt[] = [];
  let upperPrev = 0;
  let lowerPrev = 0;
  let trendUp = true;
  for (let i = 0; i < candles.length; i++) {
    if (Number.isNaN(a[i])) continue;
    const c = candles[i];
    const mid = (c.high + c.low) / 2;
    let upper = mid + mult * a[i];
    let lower = mid - mult * a[i];
    if (i > 0 && !Number.isNaN(a[i - 1])) {
      upper = upper < upperPrev || candles[i - 1].close > upperPrev ? upper : upperPrev;
      lower = lower > lowerPrev || candles[i - 1].close < lowerPrev ? lower : lowerPrev;
    }
    if (c.close > upperPrev) trendUp = true;
    else if (c.close < lowerPrev) trendUp = false;
    out.push({ time: c.time, value: trendUp ? lower : upper });
    upperPrev = upper;
    lowerPrev = lower;
  }
  return out;
};

/** Heikin-Ashi transform of standard candles. */
export interface Pivots {
  pp: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
}

const calcPivots = (h: number, l: number, c: number): Pivots => {
  const pp = (h + l + c) / 3;
  const range = h - l;
  return {
    pp,
    r1: 2 * pp - l,
    s1: 2 * pp - h,
    r2: pp + range,
    s2: pp - range,
    r3: h + 2 * (pp - l),
    s3: l - 2 * (h - pp),
  };
};

/** classic (floor-trader) pivot points from the PREVIOUS session's OHLC.
 *  Groups the (intraday) candle series by IST calendar day and uses the last
 *  completed day. For a 1D series each candle is a day, so it just uses the
 *  prior candle. null when there isn't a prior session yet. */
export const pivots = (candles: Candle[]): Pivots | null => {
  if (candles.length < 2) return null;
  const dayKey = (t: number) =>
    new Date(t * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const days = new Map<string, { h: number; l: number; c: number }>();
  for (const k of candles) {
    const key = dayKey(k.time);
    const d = days.get(key);
    if (!d) days.set(key, { h: k.high, l: k.low, c: k.close });
    else {
      d.h = Math.max(d.h, k.high);
      d.l = Math.min(d.l, k.low);
      d.c = k.close;
    }
  }
  const keys = [...days.keys()].sort();
  if (keys.length >= 2) {
    const prev = days.get(keys[keys.length - 2])!;
    return calcPivots(prev.h, prev.l, prev.c);
  }
  const k = candles[candles.length - 2];
  return calcPivots(k.high, k.low, k.close);
};

export const heikinAshi = (candles: Candle[]): Candle[] => {
  const out: Candle[] = [];
  let prevO = candles[0]?.open ?? 0;
  let prevC = candles[0]?.close ?? 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = i === 0 ? (c.open + c.close) / 2 : (prevO + prevC) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    out.push({ time: c.time, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: c.volume });
    prevO = haOpen;
    prevC = haClose;
  }
  return out;
};
