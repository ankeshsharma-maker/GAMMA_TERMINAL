import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { adx, ema, supertrend, type Candle } from "../lib/indicators";
import type { FlowDir } from "../types";

/* One trend reading built from signals the app already draws: EMA 9/21 and
   Supertrend(10,3) on 5m / 15m / 1h candles (same functions as the chart's own
   overlays, so the two can't disagree), the price-action STRUCTURE on the same
   candles (higher highs / higher lows vs lower highs / lower lows), ADX(14)
   (+DI vs -DI, once the trend is strong enough to count), plus the
   option-flow direction. It confirms a trend once it is under way; it lags at
   turning points and does not predict them. */

export type Dir = "up" | "down" | "mixed";
export type Overall = "strong-up" | "up" | "mixed" | "down" | "strong-down";

/** price-action structure from the last two confirmed swing highs and lows */
export interface Structure {
  /** what the swings say after any break of the last swing (the vote) */
  dir: Dir;
  /** last swing high vs the one before: higher / lower / equal high */
  hi: "HH" | "LH" | "EH";
  /** last swing low vs the one before: higher / lower / equal low */
  lo: "HL" | "LL" | "EL";
  lastHigh: number;
  lastLow: number;
  /** the latest close is already through the last swing high / low */
  broke: "up" | "down" | null;
}

/** ADX(14): +DI above -DI = up, below = down -- but only once ADX (the
 *  trend's strength) is at least ADX_TREND; weaker than that there is no
 *  trend to follow, so it reads mixed. */
export interface AdxRead {
  adx: number;
  pdi: number;
  mdi: number;
  dir: Dir;
}

export interface TfRead {
  label: string;
  ema: Dir | null;
  st: Dir | null;
  pa: Structure | null;
  adx: AdxRead | null;
}

export interface TrendRead {
  symbol: string;
  tfs: TfRead[];
  flow: Dir | null;
  up: number;
  down: number;
  total: number;
  overall: Overall;
  asOf: number;
}

const TFS: [string, number][] = [
  ["5m", 300],
  ["15m", 900],
  ["1h", 3600],
];
const TTL = 60_000;

const emaDir = (c: Candle[]): Dir | null => {
  const e9 = ema(c, 9);
  const e21 = ema(c, 21);
  if (!e9.length || !e21.length) return null;
  const close = c[c.length - 1].close;
  const f = e9[e9.length - 1].value;
  const s = e21[e21.length - 1].value;
  if (close > s && f > s) return "up";
  if (close < s && f < s) return "down";
  return "mixed";
};

const stDir = (c: Candle[]): Dir | null => {
  const st = supertrend(c, 10, 3);
  if (!st.length) return null;
  return c[c.length - 1].close > st[st.length - 1].value ? "up" : "down";
};

/** a swing high is a candle whose high beats the SWING_N candles on each side
 *  (a swing low the same, lower) -- only confirmed ones, so the last SWING_N
 *  candles can't be swings yet */
const SWING_N = 2;

export function swings(c: Candle[], n = SWING_N) {
  const highs: { t: number; price: number }[] = [];
  const lows: { t: number; price: number }[] = [];
  for (let i = n; i < c.length - n; i++) {
    let isH = true;
    let isL = true;
    for (let k = 1; k <= n; k++) {
      if (!(c[i].high > c[i - k].high && c[i].high >= c[i + k].high)) isH = false;
      if (!(c[i].low < c[i - k].low && c[i].low <= c[i + k].low)) isL = false;
    }
    if (isH) highs.push({ t: c[i].time, price: c[i].high });
    if (isL) lows.push({ t: c[i].time, price: c[i].low });
  }
  return { highs, lows };
}

/** HH·HL = up, LH·LL = down, anything else mixed. A close through the last
 *  swing then confirms the trend (a break the same way) or ends it (a break
 *  against it = mixed, the first sign of a turn); a mixed structure takes the
 *  direction of its break. */
export function structure(c: Candle[]): Structure | null {
  const { highs, lows } = swings(c);
  if (highs.length < 2 || lows.length < 2) return null;
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  const close = c[c.length - 1].close;
  const eps = close * 0.0003; // closer than ~0.03% (7 pts on NIFTY) = equal
  const hi = h2.price > h1.price + eps ? "HH" : h2.price < h1.price - eps ? "LH" : "EH";
  const lo = l2.price > l1.price + eps ? "HL" : l2.price < l1.price - eps ? "LL" : "EL";
  let dir: Dir = hi === "HH" && lo === "HL" ? "up" : hi === "LH" && lo === "LL" ? "down" : "mixed";
  const broke = close > h2.price ? "up" : close < l2.price ? "down" : null;
  if (broke === "up") dir = dir === "down" ? "mixed" : "up";
  if (broke === "down") dir = dir === "up" ? "mixed" : "down";
  return { dir, hi, lo, lastHigh: h2.price, lastLow: l2.price, broke };
}

const ADX_TREND = 20; // ADX under 20 = no real trend

export function adxRead(c: Candle[]): AdxRead | null {
  const r = adx(c, 14);
  if (!r) return null;
  const dir: Dir = r.adx < ADX_TREND ? "mixed" : r.pdi > r.mdi ? "up" : r.mdi > r.pdi ? "down" : "mixed";
  return { ...r, dir };
}

const flowDir = (d: FlowDir | null | undefined): Dir | null =>
  d === "bull" ? "up" : d === "bear" ? "down" : d === "mixed" ? "mixed" : null;

// shared by every strip / the order confirm, so several on screen at once
// still make one set of requests per symbol per minute
const cache = new Map<string, { at: number; p: Promise<TrendRead | null>; v: TrendRead | null }>();

async function build(symbol: string): Promise<TrendRead | null> {
  const [candleSets, flow] = await Promise.all([
    Promise.all(TFS.map(([, s]) => api.chart(symbol, s).then((d) => d.candles as Candle[], () => null))),
    api.flow(symbol, undefined, "15").then((d) => flowDir(d.state?.dir), () => null),
  ]);
  const tfs = TFS.map(([label], i) => {
    const c = candleSets[i];
    return c && c.length
      ? { label, ema: emaDir(c), st: stDir(c), pa: structure(c), adx: adxRead(c) }
      : { label, ema: null, st: null, pa: null, adx: null };
  });
  const votes = [...tfs.flatMap((t) => [t.ema, t.st, t.pa?.dir ?? null, t.adx?.dir ?? null]), flow].filter(
    (v): v is Dir => v != null
  );
  if (!votes.length) return null;
  const up = votes.filter((v) => v === "up").length;
  const down = votes.filter((v) => v === "down").length;
  const total = votes.length;
  const score = up - down;
  const overall: Overall =
    total >= 5 && up >= total - 1
      ? "strong-up"
      : total >= 5 && down >= total - 1
      ? "strong-down"
      : score >= 2
      ? "up"
      : score <= -2
      ? "down"
      : "mixed";
  return { symbol, tfs, flow, up, down, total, overall, asOf: Date.now() };
}

export function readTrend(symbol: string): Promise<TrendRead | null> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const entry = { at: Date.now(), p: build(symbol), v: hit?.v ?? null };
  entry.p.then((v) => {
    if (v) entry.v = v;
  });
  cache.set(symbol, entry);
  return entry.p;
}

export function useTrend(symbol: string | null | undefined): TrendRead | null {
  const [v, setV] = useState<TrendRead | null>(() => (symbol ? cache.get(symbol)?.v ?? null : null));
  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    const load = () => readTrend(symbol).then((r) => alive && r && setV(r), () => {});
    load();
    const id = window.setInterval(() => !document.hidden && load(), TTL);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [symbol]);
  return v && v.symbol === symbol ? v : null;
}

export const isUp = (o: Overall) => o === "up" || o === "strong-up";
export const isDown = (o: Overall) => o === "down" || o === "strong-down";

const LABEL: Record<Overall, string> = {
  "strong-up": "▲▲ STRONG UP",
  up: "▲ UP",
  mixed: "◆ MIXED",
  down: "▼ DOWN",
  "strong-down": "▼▼ STRONG DOWN",
};

const arrow = (d: Dir | null) =>
  d === "up" ? (
    <span className="text-up">▲</span>
  ) : d === "down" ? (
    <span className="text-down">▼</span>
  ) : d === "mixed" ? (
    <span className="text-term-dim">◆</span>
  ) : (
    <span className="text-term-dim">·</span>
  );

// a timeframe cell is tinted only when all its signals agree
const tint = (...d: (Dir | null)[]) =>
  d[0] && d.every((x) => x === d[0]) ? (d[0] === "up" ? "bg-up/10" : d[0] === "down" ? "bg-down/10" : "") : "";

const Cell = ({ className = "", children }: { className?: string; children: ReactNode }) => (
  <span className={`whitespace-nowrap px-1 py-0.5 ${className}`}>{children}</span>
);

export function TrendCompass({ symbol }: { symbol: string }) {
  const t = useTrend(symbol);
  const tone = !t
    ? "text-term-dim"
    : isUp(t.overall)
    ? "bg-up/15 text-up"
    : isDown(t.overall)
    ? "bg-down/15 text-down"
    : "bg-term-border/30 text-term-text";
  return (
    // one row, always: nowrap + sideways scroll on very narrow screens rather
    // than wrapping into a second line that eats chart height
    <div
      className="no-scrollbar flex items-center overflow-x-auto border-b border-term-border bg-term-panel px-1 py-1 text-[10px]"
      title="Trend compass — EMA 9/21 (first arrow), Supertrend (second) and price-action structure (third: higher highs + higher lows = up, lower highs + lower lows = down) and ADX (fourth: +DI vs -DI once ADX is 20+) on 5m, 15m and 1h candles, plus the option-flow direction. Confirms a trend once it's under way; it lags at turning points and does not predict them."
    >
      <div className="num flex shrink-0 divide-x divide-term-border/70 overflow-hidden rounded border border-term-border/70">
        <Cell className="font-semibold uppercase tracking-wide text-term-dim">Trend · {symbol}</Cell>
        <Cell className={`font-bold ${tone}`}>{t ? LABEL[t.overall] : "reading…"}</Cell>
        {t && (
          <>
            <Cell className="text-term-dim">
              {t.up}↑ {t.down}↓ of {t.total}
            </Cell>
            {t.tfs.map((f) => (
              <Cell key={f.label} className={tint(f.ema, f.st, f.pa?.dir ?? null, f.adx?.dir ?? null)}>
                <span className="text-term-dim">{f.label} </span>
                {arrow(f.ema)}
                {arrow(f.st)}
                {arrow(f.pa?.dir ?? null)}
                {arrow(f.adx?.dir ?? null)}
              </Cell>
            ))}
            {t.flow && (
              <Cell>
                <span className="text-term-dim">Flow </span>
                {arrow(t.flow)}
              </Cell>
            )}
          </>
        )}
      </div>
    </div>
  );
}
