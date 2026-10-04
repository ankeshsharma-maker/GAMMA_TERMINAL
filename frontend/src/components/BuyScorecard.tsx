import { Fragment } from "react";
import { nf } from "../lib/format";
import type { BuyCard, BuyRow, BuyStats } from "../lib/api";

const money = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;
const pct = (v: number, d = 0) => `${v >= 0 ? "+" : ""}${nf(v, d)}%`;
const V = {
  fair: { label: "Fair", cls: "border-up/60 bg-up/15 text-up", tip: "On the history this strike lost little on average (about 8% of the premium or less)" },
  costly: { label: "Costly", cls: "border-amber-400/60 bg-amber-400/15 text-amber-400", tip: "On the history it lost 8-25% of the premium on average" },
  verycostly: { label: "Very costly", cls: "border-down/60 bg-down/15 text-down", tip: "On the history it lost more than a quarter of the premium on average" },
  "n/a": { label: "–", cls: "border-term-border text-term-dim", tip: "" },
} as const;

/** The BUYER's table: what a strike costs (time value, daily decay, spread), the move needed to break even, and how often / how much it
 *  paid over the index's own history when held to expiry. */
/** the whole row in one plain sentence */
function buyLine(r: BuyRow, s: BuyStats | null, lot: number, call: boolean): string {
  if (!s) return "Not enough history to compare this strike.";
  const pay = lot ? `${money(r.premium * lot)} a lot` : nf(r.premium, 2);
  const move = `${nf(Math.abs(r.breakEvenPct), 2)}% ${call ? "up" : "down"}`;
  return `Pay ${pay} · ${nf(r.timeValuePct, 0)}% of it is time value · needs a ${move} move to break even · made a profit ${nf(s.probProfit, 0)}% of the time, ${s.avgPct >= 0 ? "gaining" : "losing"} ${nf(Math.abs(s.avgPct), 0)}% of the premium on average`;
}

export function BuyBody({ card, basis, lot, simple }: { card: BuyCard; basis: "all" | "trend"; lot: number; simple: boolean }) {
  const rows = card.rows;
  const stat = (r: BuyRow): BuyStats | null => (basis === "trend" ? r.trend : r.all);
  const verdictOf = (r: BuyRow) => (basis === "trend" ? r.verdictTrend : r.verdict);
  const best = rows.find((r) => r.strike === card.advisor);
  const atm = rows.find((r) => r.strike === card.atm);
  const bs = best ? stat(best) : null;
  const as = atm ? stat(atm) : null;
  const call = card.side === "C";

  return (
    <>
      {best && bs && (
        <div className="mx-3 mt-3 rounded-md border border-term-border bg-term-panel px-3 py-2 text-[12px] text-term-dim">
          <b className="text-term-text">★ Best value: {nf(best.strike, 0)}</b> ({nf(best.pctItm, 1)}% in the money). You pay{" "}
          <b className="text-term-text">{nf(best.premium, 2)}</b>
          {lot ? <> ({money(best.premium * lot)} a lot)</> : null}, only {nf(best.timeValuePct, 0)}% of it is time value, and the {call ? "index" : "index"} needs to move just{" "}
          {nf(Math.abs(best.breakEvenPct), 2)}% {call ? "up" : "down"} to break even. Held to expiry it averaged <b className={bs.avgPct >= 0 ? "text-up" : "text-down"}>{pct(bs.avgPct, 1)}</b> of the premium
          {as && atm ? (
            <>
              , against <b className="text-down">{pct(as.avgPct, 1)}</b> for the at-the-money {nf(atm.strike, 0)} (and {nf(bs.lose50, 0)}% of trades lost more than half the premium, against {nf(as.lose50, 0)}%)
            </>
          ) : null}
          . The price of that safety: it costs more per lot and gains less when the index runs.
        </div>
      )}
      {simple ? (
        <div className="mx-3 my-3 shrink-0 overflow-hidden rounded-md border border-term-border">
          {rows.length === 0 && <div className="p-4 text-center text-[12px] text-term-dim">No strike with a price right now.</div>}
          {rows.map((r) => {
            const s = stat(r);
            const v = V[verdictOf(r)];
            const star = r.strike === card.advisor;
            return (
              <div key={r.strike} className={`flex items-start gap-2 border-b border-term-border/50 px-3 py-2 text-[12px] text-term-text last:border-b-0 ${star ? "bg-term-accent/10" : ""}`}>
                <div className="w-[84px] shrink-0">
                  <div className="font-bold">{star ? <span className="mr-0.5 text-amber-400">★</span> : null}{nf(r.strike, 0)}</div>
                  <div className="text-[10px] text-term-dim">{Math.abs(r.pctItm) <= 0.05 ? "at the money" : r.pctItm > 0 ? `${nf(r.pctItm, 1)}% in` : `${nf(-r.pctItm, 1)}% out`}</div>
                </div>
                <div className="min-w-0 flex-1 leading-snug text-term-dim">{buyLine(r, s, lot, call)}</div>
                <span title={v.tip} className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${v.cls}`}>{v.label}</span>
              </div>
            );
          })}
        </div>
      ) : (
      <div className="mx-3 my-3 shrink-0 overflow-x-auto rounded-md border border-term-border">
        <table className="w-full min-w-[760px] text-right text-[12px]">
          <thead className="bg-term-panel text-[10px] uppercase tracking-wide text-term-dim">
            <tr className="border-b border-term-border">
              <th className="px-2 py-1.5 text-left font-semibold">Strike</th>
              <th className="px-1 font-semibold">Premium</th>
              <th className="px-1 font-semibold" title="The part of the premium that is NOT intrinsic value: it decays to zero by expiry">Time value</th>
              <th className="px-1 font-semibold" title="How much of the premium the option loses each day from time decay alone (its theta)">Decay / day</th>
              <th className="px-1 font-semibold" title="Bid-ask gap as % of the price: what you give up on the way in and out">Spread</th>
              <th className="px-1 font-semibold" title="How far the index must move, in the option's direction, for the option to be worth more than you paid at expiry">Break-even move</th>
              <th className="px-1 font-semibold" title="Share of past stretches in which holding to expiry made a profit">Chance of profit</th>
              <th className="px-1 font-semibold" title="Average result of holding to expiry, as % of the premium (before costs)">Avg result</th>
              <th className="px-1 font-semibold" title="Share of past stretches in which more than half the premium was lost">Lost over half</th>
              <th className="px-2 text-center font-semibold">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={10} className="p-4 text-center text-term-dim">No strike with a price right now.</td></tr>
            )}
            {rows.map((r) => {
              const s = stat(r);
              const v = V[verdictOf(r)];
              const star = r.strike === card.advisor;
              return (
                <Fragment key={r.strike}>
                <tr className={`border-t border-term-border/50 text-term-text ${star ? "bg-term-accent/10" : ""}`}>
                  <td className="px-2 py-1.5 text-left font-semibold">
                    {star ? <span className="mr-0.5 text-amber-400">★</span> : null}
                    {nf(r.strike, 0)}{" "}
                    <span className="font-normal text-term-dim">{Math.abs(r.pctItm) <= 0.05 ? "ATM" : r.pctItm > 0 ? `${nf(r.pctItm, 1)}% in` : `${nf(-r.pctItm, 1)}% out`}</span>
                  </td>
                  <td className="px-1">
                    {nf(r.premium, 2)}
                    {lot ? <div className="text-[10px] text-term-dim">{money(r.premium * lot)}/lot</div> : null}
                  </td>
                  <td className={`px-1 ${r.timeValuePct >= 60 ? "text-down" : r.timeValuePct <= 15 ? "text-up" : ""}`}>{nf(r.timeValuePct, 0)}%</td>
                  <td className={`px-1 ${r.decayDayPct != null && r.decayDayPct >= 20 ? "text-down" : ""}`}>{r.decayDayPct != null ? `${nf(r.decayDayPct, 0)}%` : "–"}</td>
                  <td className={`px-1 ${r.spreadPct != null && r.spreadPct > 3 ? "text-down" : ""}`}>{r.spreadPct != null ? `${nf(r.spreadPct, 1)}%` : "–"}</td>
                  <td className="px-1">{nf(Math.abs(r.breakEvenPct), 2)}%{r.breakEvenPct < 0 ? "" : ""}</td>
                  <td className="px-1">{s ? `${nf(s.probProfit, 0)}%` : "–"}</td>
                  <td className={`px-1 font-bold ${s ? (s.avgPct >= 0 ? "text-up" : "text-down") : ""}`}>{s ? pct(s.avgPct, 1) : "–"}</td>
                  <td className="px-1">{s ? `${nf(s.lose50, 0)}%` : "–"}</td>
                  <td className="px-2 text-center">
                    <span title={v.tip} className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${v.cls}`}>{v.label}</span>
                  </td>
                </tr>
                <tr className={`border-b border-term-border/50 ${star ? "bg-term-accent/10" : ""}`}>
                  <td colSpan={10} className="px-2 pb-1.5 pt-0.5 text-left text-[11px] text-term-dim">{buyLine(r, s, lot, call)}</td>
                </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
      <div className="space-y-1 px-3 pb-4 text-[10px] leading-snug text-term-dim">
        <p>
          <b className="text-term-text">How to read it.</b> For every past stretch of {card.sessions} trading day{card.sessions > 1 ? "s" : ""} I held this option to expiry from today's price and
          counted what it would have paid. <b>Time value</b> is the part of the premium that is not intrinsic value; it is gone by expiry whatever the index does. <b>Decay / day</b> is how
          much of the premium time takes each day. <b>Break-even move</b> is how far the index must go your way for the option to pay back what you paid. <b>Avg result</b> is what holding
          to expiry returned on average, in % of the premium. Strikes deeper in the money pay less time value, so they lost less on average — but they cost more per lot and gain less when the
          index runs. The ★ strike is the in-the-money one (delta 0.6+, spread 3% or less) that cost the least on this history.
        </p>
        <p>
          <b className="text-term-text">Limits.</b> Held to expiry only: selling earlier gets back part of the time value, and a change in implied volatility moves the price. It is the past, not a
          forecast, and the history does not tell you which way the index will go — it tells you what each strike cost to be wrong or right.
        </p>
      </div>
    </>
  );
}
