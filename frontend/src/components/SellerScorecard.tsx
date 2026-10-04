import { Fragment, useEffect, useMemo, useState } from "react";
import { api, type BuyCard, type SellerCard, type SellerRow, type SellerStats } from "../lib/api";
import { BuyBody } from "./BuyScorecard";
import { nf } from "../lib/format";
import { useStore } from "../store";
import { Chips } from "./StockScanTable";

/** "about 1 time in 10" for a chance in % */
const oneIn = (p: number) => (p < 1 ? "less than 1 time in 100" : `about 1 time in ${Math.max(2, Math.round(100 / p))}`);
/** the whole row in one plain sentence */
function sellLine(r: SellerRow, s: SellerStats | null, lot: number): string {
  if (!s) return "Not enough history to compare this strike.";
  const coll = lot ? `${money(r.premium * lot)} a lot` : nf(r.premium, 2);
  if (s.probItm <= 0) return `Collect ${coll}. In the history it never ended beyond this strike.`;
  const loss = lot ? `${money(s.avgLossX * r.premium * lot)} a lot` : `${nf(s.avgLossX, 1)}x the premium`;
  return `Collect ${coll} · wrong ${oneIn(s.probItm)} · then lose about ${loss} (${nf(s.avgLossX, 1)}x what you collected)`;
}

const INDICES = ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY"] as const;
const money = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;
const pct = (v: number, d = 0) => `${v >= 0 ? "+" : ""}${nf(v, d)}%`;
const V = {
  pays: { label: "Pays", cls: "border-up/60 bg-up/15 text-up", tip: "On the history, the premium covered the average payout with room to spare" },
  thin: { label: "Thin", cls: "border-amber-400/60 bg-amber-400/15 text-amber-400", tip: "The premium covered the average payout, but only just" },
  underpays: { label: "Too cheap", cls: "border-down/60 bg-down/15 text-down", tip: "Historically the average payout was MORE than this premium" },
  "n/a": { label: "–", cls: "border-term-border text-term-dim", tip: "" },
} as const;

/** What a seller needs to know before selling a strike: how often the index finished beyond it (market's price of that vs what the history
 *  did), what the premium kept on average, and how big the loss was when wrong -- in the premium collected and in rupees per lot. */
export function SellerScorecard() {
  const storeSym = useStore((s) => s.symbol);
  const [symbol, setSymbol] = useState<string>(INDICES.includes(storeSym as any) ? storeSym : "NIFTY");
  const [mode, setMode] = useState<"sell" | "buy">("sell"); // what the user is doing: selling or buying options
  const [side, setSide] = useState<"P" | "C">("P");
  const [expiry, setExpiry] = useState<string>("");
  const [basis, setBasis] = useState<"all" | "trend">("all");
  const [simple, setSimple] = useState(true); // simple = one plain sentence per strike; full = the numbers table too
  const [card, setCard] = useState<(SellerCard & BuyCard) | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    let inflight = false; // a refresh that is still running is not started twice (page-visibility flips used to cancel each other)
    const load = () => {
      if (document.hidden || inflight) return;
      inflight = true;
      setBusy(true);
      api
        .sellerScorecard(symbol, side, expiry || undefined, mode)
        .then((r) => {
          if (!live) return;
          if (r.error) {
            setErr(r.error);
            setCard(null);
          } else {
            setErr("");
            setCard(r);
          }
        })
        .catch((e) => live && setErr(String(e?.message || e)))
        .finally(() => {
          inflight = false;
          if (live) setBusy(false);
        });
    };
    load();
    const t = setInterval(load, 20000); // the premiums move
    document.addEventListener("visibilitychange", load); // a tab opened in the background loads the moment you look at it
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", load);
    };
  }, [symbol, side, expiry, mode]);

  const rows = card?.rows ?? [];
  const stat = (r: SellerRow): SellerStats | null => (basis === "trend" ? r.trend : r.all);
  const verdictOf = (r: SellerRow) => (basis === "trend" ? r.verdictTrend : r.verdict);
  const lot = card?.lotSize ?? 0;
  const trendWord = card?.trend === "up" ? "up-trend" : card?.trend === "down" ? "down-trend" : "no clear trend";
  const best = useMemo(() => rows.find((r) => verdictOf(r) === "pays"), [rows, basis]); // rows run from the money outwards: the CLOSEST strike that pays // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-term-bg">
      <div className="space-y-2 border-b border-term-border bg-term-panel2 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-bold text-term-text">Strike scorecard</span>
          <Chips<"sell" | "buy">
            items={[["sell", "I'm selling"], ["buy", "I'm buying"]]}
            value={mode}
            onChange={(m) => {
              setMode(m);
              setSide(m === "buy" ? "C" : "P"); // each side opens on its usual leg
              setCard(null);
            }}
          />
          <Chips<string> items={INDICES.map((i) => [i, i] as [string, string])} value={symbol} onChange={(v) => { setSymbol(v); setExpiry(""); }} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-term-dim">
          <Chips<"P" | "C">
            items={mode === "buy" ? [["C", "Buy calls"], ["P", "Buy puts"]] : [["P", "Sell puts"], ["C", "Sell calls"]]}
            value={side}
            onChange={setSide}
          />
          {card?.expiries && card.expiries.length > 1 && (
            <select
              value={expiry || card.expiry || ""}
              onChange={(e) => setExpiry(e.target.value)}
              className="rounded border border-term-dim/70 bg-term-panel px-2 py-1 text-[12px] text-term-text"
            >
              {card.expiries.slice(0, 6).map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          )}
          <span>History</span>
          <Chips<"all" | "trend"> items={[["all", "All days"], ["trend", "Same trend as today"]]} value={basis} onChange={setBasis} />
          <span>View</span>
          <Chips<"simple" | "full"> items={[["simple", "Simple"], ["full", "Full numbers"]]} value={simple ? "simple" : "full"} onChange={(v) => setSimple(v === "simple")} />
        </div>
        {card && (
          <div className="text-[11px] text-term-dim">
            {card.symbol} <b className="text-term-text">{nf(card.spot, 2)}</b> · expiry <b className="text-term-text">{card.expiry}</b> ({card.sessions} trading day
            {card.sessions > 1 ? "s" : ""} left) · market is in a <b className="text-term-text">{trendWord}</b> · compared with{" "}
            {basis === "trend" ? `${card.trendWindows} past ${card.sessions}-day stretches that started in the same trend` : `${card.windows.toLocaleString("en-IN")} past ${card.sessions}-day stretches`} since {card.from.slice(0, 4)}
            {busy ? " · refreshing…" : ""}
          </div>
        )}
      </div>

      {err ? (
        <div className="p-4 text-center text-[12px] text-down">{err}</div>
      ) : !card ? (
        <div className="p-6 text-center text-[12px] text-term-dim">Loading the option chain and the index's history…</div>
      ) : card.mode === "buy" ? (
        <BuyBody card={card} basis={basis} lot={lot} simple={simple} />
      ) : (
        <>
          {best && (
            <div className="mx-3 mt-3 rounded-md border border-term-border bg-term-panel px-3 py-2 text-[12px] text-term-dim">
              The closest strike that <b className="text-up">pays</b> on this history is <b className="text-term-text">{nf(best.strike, 0)}</b> ({nf(best.pctOtm, 1)}% out): you collect{" "}
              <b className="text-term-text">{nf(best.premium, 2)}</b>
              {lot ? <> ({money(best.premium * lot)} a lot)</> : null}; when it ends beyond the strike the average loss is {nf(stat(best)?.avgLossX ?? 0, 1)}x that
              {lot ? <> ({money((stat(best)?.avgLossX ?? 0) * best.premium * lot)} a lot)</> : null}. Strikes nearer the money kept less than the risk was worth.
            </div>
          )}
          {simple ? (
            <div className="mx-3 my-3 shrink-0 overflow-hidden rounded-md border border-term-border">
              {rows.length === 0 && <div className="p-4 text-center text-[12px] text-term-dim">No strike with a price right now.</div>}
              {rows.map((r) => {
                const s = stat(r);
                const v = V[verdictOf(r)];
                return (
                  <div key={r.strike} className="flex items-start gap-2 border-b border-term-border/50 px-3 py-2 text-[12px] text-term-text last:border-b-0">
                    <div className="w-[84px] shrink-0">
                      <div className="font-bold">{nf(r.strike, 0)}</div>
                      <div className="text-[10px] text-term-dim">{r.pctOtm <= 0.05 ? "at the money" : `${nf(r.pctOtm, 1)}% out`}</div>
                    </div>
                    <div className="min-w-0 flex-1 leading-snug text-term-dim">{sellLine(r, s, lot)}</div>
                    <span title={v.tip} className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${v.cls}`}>{v.label}</span>
                  </div>
                );
              })}
            </div>
          ) : (
          <div className="mx-3 my-3 shrink-0 overflow-x-auto rounded-md border border-term-border">
            <table className="w-full min-w-[640px] text-right text-[12px]">
              <thead className="bg-term-panel text-[10px] uppercase tracking-wide text-term-dim">
                <tr className="border-b border-term-border">
                  <th className="px-2 py-1.5 text-left font-semibold">Strike</th>
                  <th className="px-1 font-semibold">Premium</th>
                  <th className="px-1 font-semibold" title="Chance it ends beyond the strike: what the option market prices (its delta) vs how often it happened">Ends beyond · market / history</th>
                  <th className="px-1 font-semibold" title="Share of the premium a seller kept on average, before costs">You keep</th>
                  <th className="px-1 font-semibold" title="When it does end beyond the strike: the average loss, in multiples of the premium collected (and the worst)">If wrong: avg loss</th>
                  <th className="px-1 font-semibold" title="Wins needed to pay for one loss, vs the wins it actually had per loss">Wins per loss · need / had</th>
                  <th className="px-2 text-center font-semibold">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={7} className="p-4 text-center text-term-dim">No strike with a price right now.</td></tr>
                )}
                {rows.map((r) => {
                  const s = stat(r);
                  const v = V[verdictOf(r)];
                  const had = s && s.probItm > 0 ? (100 - s.probItm) / s.probItm : Infinity;
                  return (
                    <Fragment key={r.strike}>
                    <tr className="border-t border-term-border/50 text-term-text">
                      <td className="px-2 pt-1.5 text-left font-semibold">
                        {nf(r.strike, 0)} <span className="font-normal text-term-dim">{r.pctOtm <= 0.05 ? "ATM" : `${nf(r.pctOtm, 1)}% out`}</span>
                      </td>
                      <td className="px-1 pt-1.5">
                        {nf(r.premium, 2)}
                        {lot ? <div className="text-[10px] text-term-dim">{money(r.premium * lot)}/lot</div> : null}
                      </td>
                      <td className="px-1 pt-1.5">
                        <span className="text-term-dim">{r.impliedItm != null ? `${nf(r.impliedItm, 0)}%` : "–"}</span> / <b>{s ? `${nf(s.probItm, 1)}%` : "–"}</b>
                      </td>
                      <td className={`px-1 pt-1.5 font-bold ${s ? (s.keptPct >= 0 ? "text-up" : "text-down") : ""}`}>{s ? pct(s.keptPct) : "–"}</td>
                      <td className="px-1 pt-1.5">
                        {s && s.probItm > 0 ? (
                          <>
                            {nf(s.avgLossX, 1)}x
                            {lot ? <div className="text-[10px] text-term-dim">{money(s.avgLossX * r.premium * lot)}/lot</div> : null}
                            <div className="text-[10px] text-term-dim">worst {nf(s.worstX, 0)}x</div>
                          </>
                        ) : s ? (
                          <span className="text-term-dim">never wrong</span>
                        ) : (
                          "–"
                        )}
                      </td>
                      <td className="px-1 pt-1.5">
                        {s ? (
                          <span className={had >= s.winsPerLoss ? "text-up" : "text-down"}>
                            {nf(s.winsPerLoss, 1)} / {Number.isFinite(had) ? nf(had, 1) : "∞"}
                          </span>
                        ) : "–"}
                      </td>
                      <td className="px-2 pt-1.5 text-center">
                        <span title={v.tip} className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${v.cls}`}>{v.label}</span>
                      </td>
                    </tr>
                    <tr className="border-b border-term-border/50">
                      <td colSpan={7} className="px-2 pb-1.5 pt-0.5 text-left text-[11px] text-term-dim">{sellLine(r, s, lot)}</td>
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
              <b className="text-term-text">How to read it.</b> For every past stretch of {card.sessions} trading day{card.sessions > 1 ? "s" : ""} I asked: starting from today's price, would this
              strike have ended in the money, and by how much? <b>Ends beyond</b>: the option market's own chance (its delta) next to how often it really happened. <b>You keep</b>: the
              average share of the premium a seller kept after paying out. <b>If wrong</b>: the average payout when it did end beyond the strike, in multiples of the premium (a 5x loss
              erases five winning trades), and the single worst stretch. <b>Wins per loss</b>: how many wins you need to pay for one average loss, against how many it actually had (green =
              the history paid for itself).
            </p>
            <p>
              <b className="text-term-text">Pays</b> = kept ≥ 25% and the win rate beat break-even by 3+ points; <b>Thin</b> = kept something; <b>Too cheap</b> = the average payout was bigger than the premium.
              It is the past, not a forecast: it has no gaps, margin or events the history never saw, and a strike far out looks safest right before the one bad day. Size the loss, not
              the win rate.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
