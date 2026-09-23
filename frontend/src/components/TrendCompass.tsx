import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { ema, supertrend, type Candle } from "../lib/indicators";
import type { FlowDir } from "../types";

/* One trend reading built from signals the app already draws: EMA 9/21 and
   Supertrend(10,3) on 5m / 15m / 1h candles (same functions as the chart's own
   overlays, so the two can't disagree), plus the option-flow direction. It
   confirms a trend once it is under way; it lags at turning points and does
   not predict them. */

export type Dir = "up" | "down" | "mixed";
export type Overall = "strong-up" | "up" | "mixed" | "down" | "strong-down";

export interface TfRead {
  label: string;
  ema: Dir | null;
  st: Dir | null;
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
    return c && c.length ? { label, ema: emaDir(c), st: stDir(c) } : { label, ema: null, st: null };
  });
  const votes = [...tfs.flatMap((t) => [t.ema, t.st]), flow].filter((v): v is Dir => v != null);
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

const SYM: Record<Dir, string> = { up: "▲", down: "▼", mixed: "◆" };
const CELL: Record<Dir, string> = {
  up: "bg-up/15 text-up",
  down: "bg-down/15 text-down",
  mixed: "text-term-dim",
};

// border-collapse (not .grid-table) so the row-spanned Flow / Overall cells
// keep clean shared borders
const B = "border border-term-border/70";

const Sig = ({ d, rowSpan, title }: { d: Dir | null; rowSpan?: number; title?: string }) => (
  <td
    rowSpan={rowSpan}
    title={title}
    className={`${B} px-2 py-0.5 text-center text-[11px] font-bold ${d ? CELL[d] : "text-term-dim"}`}
  >
    {d ? SYM[d] : "–"}
  </td>
);

export function TrendCompass({ symbol }: { symbol: string }) {
  const t = useTrend(symbol);
  const tone = !t
    ? "text-term-dim"
    : isUp(t.overall)
    ? "bg-up/15 text-up"
    : isDown(t.overall)
    ? "bg-down/15 text-down"
    : "text-term-text";
  const tfs = t?.tfs ?? TFS.map(([label]) => ({ label, ema: null, st: null }));
  return (
    <div className="border-b border-term-border bg-term-panel px-2 py-1">
      <table
        className="num border-collapse text-[10px]"
        title="Trend compass — EMA 9/21 and Supertrend on 5m, 15m and 1h candles, plus the option-flow direction. Confirms a trend once it's under way; it lags at turning points and does not predict them."
      >
        <thead className="bg-term-panel2 text-term-dim">
          <tr>
            <th className={`${B} px-2 py-0.5 text-left font-semibold uppercase tracking-wide`}>Trend · {symbol}</th>
            {tfs.map((f) => (
              <th key={f.label} className={`${B} px-2 py-0.5 font-semibold`}>
                {f.label}
              </th>
            ))}
            <th className={`${B} px-2 py-0.5 font-semibold`}>Flow</th>
            <th className={`${B} px-2 py-0.5 font-semibold`}>Overall</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className={`${B} px-2 py-0.5 text-term-dim`}>EMA 9/21</td>
            {tfs.map((f) => (
              <Sig key={f.label} d={f.ema} />
            ))}
            <Sig d={t?.flow ?? null} rowSpan={2} title={t?.flow ? "option-flow direction (15 min)" : "option flow not tracked for this symbol"} />
            <td rowSpan={2} className={`${B} px-2 py-0.5 text-center ${tone}`}>
              <div className="whitespace-nowrap font-bold">{t ? LABEL[t.overall] : "reading…"}</div>
              {t && (
                <div className="whitespace-nowrap text-term-dim">
                  {t.up}↑ {t.down}↓ of {t.total}
                </div>
              )}
            </td>
          </tr>
          <tr>
            <td className={`${B} px-2 py-0.5 text-term-dim`}>Supertrend</td>
            {tfs.map((f) => (
              <Sig key={f.label} d={f.st} />
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
