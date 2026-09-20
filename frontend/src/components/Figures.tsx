import type { CSSProperties, ReactNode } from "react";
import { nf } from "../lib/format";

/** Readable result figures for the Auto tab (backtest result + Performance tab).
 *
 *  Three things were wrong with the old tiles: the type was 8-11px, the grid picked its column
 *  count from the WINDOW width (so a 600px panel still got 8 columns), and losses were drawn in
 *  the app's --down red, which is only ~3.2:1 on the dark panel. Here the layout follows the
 *  width of the panel itself (see `.figs` in index.css), labels are 11px and values 14-20px, and
 *  the tone colours are the same hues lifted to >= 5.5:1. */

export type Tone = "up" | "down" | "flat";

export const tone = (v: number | null | undefined): Tone =>
  v == null || Number.isNaN(v) || v === 0 ? "flat" : v > 0 ? "up" : "down";

/** green-500 / red-400 / neutral text; both coloured tones clear 5.5:1 on term-panel */
export const TONE_TEXT: Record<Tone, string> = { up: "text-green-500", down: "text-red-400", flat: "text-term-text" };
const TONE_TILE: Record<Tone, string> = {
  up: "border-green-500/40 bg-green-500/10",
  down: "border-red-400/40 bg-red-400/10",
  flat: "border-term-border bg-term-panel",
};

/** −₹1,61,778 / +₹2,29,120 / ₹0. `sign` puts a + on gains (for P&L); leave it off for plain amounts. */
export function money(v: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (v == null || Number.isNaN(v)) return "–";
  const r = Math.round(v);
  return `${r < 0 ? "−" : opts.sign && r > 0 ? "+" : ""}₹${nf(Math.abs(r), 0)}`;
}

/** x-axis ticks for a trade-count axis: whole numbers only, about six of them */
export function tradeTicks(n: number): number[] {
  const step = Math.max(1, Math.ceil(n / 5));
  return Array.from({ length: Math.floor(n / step) + 1 }, (_, i) => i * step);
}

/** Big number on a tinted tile, with a line underneath saying what it is made of. Its font size is
 *  worked out in CSS from the tile's own width and the number of characters (see `.figs-value`), so a
 *  12-character figure fits the narrowest tile at any window size instead of clipping. */
export function Headline({
  label,
  value,
  sub,
  t = "flat",
  title,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  t?: Tone;
  title?: string;
}) {
  return (
    <div className={`min-w-0 rounded border px-2.5 py-2 ${TONE_TILE[t]}`} title={title}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-term-dim">{label}</div>
      <div
        className={`figs-value num whitespace-nowrap font-semibold leading-tight ${TONE_TEXT[t]}`}
        style={{ "--len": value.length } as CSSProperties}
      >
        {value}
      </div>
      {sub != null && <div className="mt-0.5 text-[11px] leading-snug text-term-dim">{sub}</div>}
    </div>
  );
}

/** A secondary figure: 11px label above a 14px value. */
export function Fig({ label, value, t = "flat", title }: { label: string; value: string; t?: Tone; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[11px] uppercase tracking-wide text-term-dim">{label}</div>
      <div
        className={`figs-cellvalue num whitespace-nowrap font-semibold ${TONE_TEXT[t]}`}
        style={{ "--len": value.length } as CSSProperties}
      >
        {value}
      </div>
    </div>
  );
}

/** The fields both /api/autobot/backtest (summary) and /api/autobot/stats (overall) carry. */
export interface FigSummary {
  total: number;
  totalWin?: number;
  totalLoss?: number;
  count: number;
  wins?: number;
  losses?: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor?: number | null;
  payoff?: number | null;
  expectancy?: number | null;
  maxDrawdown: number;
  maxWinStreak?: number | null;
  maxLossStreak?: number | null;
  best?: number | null;
  worst?: number | null;
  avgHoldMin?: number | null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** a loss figure is always shown as a loss, whatever sign it was stored with */
const asLoss = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? v : -Math.abs(v));

/** The whole figure block: four headline tiles, then the other twelve numbers in a grid. */
export function FigureBoard({
  s,
  gross,
  costs,
  costsLabel = "costs",
}: {
  s: FigSummary;
  /** result before costs; with `costs` it explains how the net figure was reached */
  gross?: number | null;
  costs?: number | null;
  costsLabel?: string;
}) {
  const wins = s.wins ?? 0;
  const losses = s.losses ?? 0;
  const hold = s.avgHoldMin;
  const withCosts = gross != null && costs != null;
  return (
    <div className="figs space-y-2">
      <div className="figs-head">
        <Headline
          label={withCosts ? "Net P&L" : "Total P&L"}
          value={money(s.total, { sign: true })}
          t={tone(s.total)}
          title={withCosts ? "After brokerage, STT, exchange charges, GST and slippage" : "Before any costs"}
          sub={withCosts ? `gross ${money(gross, { sign: true })} − ${costsLabel} ${money(costs)}` : "before costs"}
        />
        <Headline
          label="Total win"
          value={money(s.totalWin ?? 0, { sign: true })}
          t={tone(s.totalWin ?? 0)}
          sub={`from ${plural(wins, "trade")}`}
          title="Sum of every winning trade"
        />
        <Headline
          label="Total loss"
          value={money(asLoss(s.totalLoss ?? 0))}
          t={tone(asLoss(s.totalLoss ?? 0))}
          sub={`from ${plural(losses, "trade")}`}
          title="Sum of every losing trade"
        />
        <Headline
          label="Win rate"
          value={`${nf(s.winRate, 1)}%`}
          sub={`${wins} won · ${losses} lost`}
          title="Share of trades that made money"
        />
      </div>

      <div className="rounded border border-term-border bg-term-bg/30 px-2.5 py-2.5">
        <div className="figs-cells">
          <Fig label="Trades" value={`${s.count}`} />
          <Fig
            label="Profit factor"
            value={s.profitFactor != null ? nf(s.profitFactor, 2) : "–"}
            t={s.profitFactor == null ? "flat" : s.profitFactor >= 1 ? "up" : "down"}
            title="Total won ÷ total lost. Above 1 is profitable."
          />
          <Fig
            label="Expectancy"
            value={money(s.expectancy, { sign: true })}
            t={tone(s.expectancy)}
            title="Average net P&L per trade"
          />
          <Fig
            label="Payoff"
            value={s.payoff != null ? nf(s.payoff, 2) : "–"}
            t={s.payoff == null ? "flat" : s.payoff >= 1 ? "up" : "down"}
            title="Average win ÷ average loss"
          />
          <Fig label="Avg win" value={money(s.avgWin, { sign: true })} t={tone(s.avgWin)} />
          <Fig label="Avg loss" value={money(asLoss(s.avgLoss))} t={tone(asLoss(s.avgLoss))} />
          <Fig label="Best trade" value={money(s.best, { sign: true })} t={tone(s.best)} />
          <Fig label="Worst trade" value={money(s.worst)} t={tone(s.worst)} />
          <Fig label="Drawdown" value={money(asLoss(s.maxDrawdown))} t={tone(asLoss(s.maxDrawdown))} title="Largest fall from a peak in the running P&L" />
          <Fig label="Win streak" value={s.maxWinStreak != null ? `${s.maxWinStreak}` : "–"} title="Most winning trades in a row" />
          <Fig label="Loss streak" value={s.maxLossStreak != null ? `${s.maxLossStreak}` : "–"} title="Most losing trades in a row" />
          <Fig
            label="Avg hold"
            value={hold == null ? "–" : hold >= 90 ? `${nf(hold / 60, 1)} h` : `${nf(hold, 0)} min`}
            title="Average time a trade stayed open"
          />
        </div>
      </div>
    </div>
  );
}
