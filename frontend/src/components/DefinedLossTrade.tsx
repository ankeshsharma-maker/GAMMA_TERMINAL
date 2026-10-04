import { useEffect, useState } from "react";
import { api, type LabEntry, type LabTrade } from "../lib/api";
import { nf } from "../lib/format";
import { useStore } from "../store";
import { Chips } from "./StockScanTable";

const INDICES = ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY"] as const;
const money = (v: number) => `${v < 0 ? "-" : ""}₹${Math.round(Math.abs(v)).toLocaleString("en-IN")}`;
const STRUCT: [string, string][] = [["", "All"], ["IC", "Iron condor"], ["IF", "Iron fly"], ["PCS", "Put spread"], ["CCS", "Call spread"]];

/** "I'll risk at most ₹X": the defined-loss trades that fit, priced at the live bid / ask and replayed on the index's own history. */
export function DefinedLossTrade({ initialSymbol }: { initialSymbol: string }) {
  const selectSymbol = useStore((s) => s.selectSymbol);
  const selectExpiry = useStore((s) => s.selectExpiry);
  const queueBuilderLeg = useStore((s) => s.queueBuilderLeg);
  const setView = useStore((s) => s.setView);

  const [symbol, setSymbol] = useState<string>(INDICES.includes(initialSymbol as any) ? initialSymbol : "NIFTY");
  const [expiry, setExpiry] = useState("");
  const [expiries, setExpiries] = useState<string[]>([]);
  const [maxLoss, setMaxLoss] = useState("10000");
  const [struct, setStruct] = useState("");
  const [dist, setDist] = useState(1);
  const [sort, setSort] = useState<"return" | "win" | "credit">("return");
  const [res, setRes] = useState<LabEntry | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState("");

  useEffect(() => {
    let live = true;
    api.chain(symbol).then((c) => live && setExpiries(c.expiries ?? [])).catch(() => {});
    return () => {
      live = false;
    };
  }, [symbol]);

  const run = () => {
    const ml = parseFloat(maxLoss);
    if (!(ml >= 500)) return setErr("Enter the most you are willing to lose, at least ₹500.");
    setBusy(true);
    setErr("");
    setSent("");
    api
      .tradeLabEntry({ symbol, expiry: expiry || undefined, maxLoss: ml, structures: struct ? [struct] : undefined, minDistPct: dist, sort })
      .then((r) => setRes(r))
      .catch((e) => {
        setRes(null);
        setErr(String(e?.message || e));
      })
      .finally(() => setBusy(false));
  };
  useEffect(run, [symbol, expiry, struct, dist, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  /** to the Build tab: the legs go in BUY first (the protection before the short legs), where you review and slide to execute as usual */
  const toBuild = (t: LabTrade) => {
    if (!res) return;
    selectSymbol(res.symbol, true);
    selectExpiry(res.expiry);
    for (const l of t.legs) queueBuilderLeg({ optionType: l.optionType, strike: l.strike, side: l.side, lots: l.lots, price: l.price ?? null }, false);
    setSent(`${t.structure} sent to the Build tab — review it there and slide to execute.`);
    setView("builder");
  };

  const line = (t: LabTrade) => {
    const sells = t.legs.filter((l) => l.side === "SELL").map((l) => `${nf(l.strike, 0)} ${l.optionType === "PE" ? "put" : "call"}`).join(" + ");
    const buys = t.legs.filter((l) => l.side === "BUY").map((l) => nf(l.strike, 0)).join(" / ");
    return `Sell ${sells} · protect with ${buys}`;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-term-bg">
      <div className="space-y-2 border-b border-term-border bg-term-panel2 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Chips<string> items={INDICES.map((i) => [i, i] as [string, string])} value={symbol} onChange={(v) => { setSymbol(v); setExpiry(""); }} />
          {expiries.length > 1 && (
            <select
              value={expiry || expiries[0]}
              onChange={(e) => setExpiry(e.target.value)}
              className="rounded border border-term-dim/70 bg-term-panel px-2 py-1 text-[12px] text-term-text"
            >
              {expiries.slice(0, 6).map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-term-dim">
          <span>The most I can lose</span>
          <span className="text-term-text">₹</span>
          <input
            value={maxLoss}
            inputMode="numeric"
            onChange={(e) => setMaxLoss(e.target.value.replace(/[^\d]/g, ""))}
            onBlur={run}
            onKeyDown={(e) => e.key === "Enter" && run()}
            className="w-24 rounded border border-term-dim/70 bg-term-panel px-2 py-1 text-[13px] font-bold text-term-text outline-none focus:border-term-accent"
          />
          <Chips<string> items={[["5000", "₹5k"], ["10000", "₹10k"], ["25000", "₹25k"], ["50000", "₹50k"]]} value={maxLoss} onChange={(v) => { setMaxLoss(v); setTimeout(run, 0); }} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-term-dim">
          <Chips<string> items={STRUCT} value={struct} onChange={setStruct} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-term-dim">
          <span>Sold strikes at least</span>
          <Chips<number> items={[[0.5, "0.5%"], [1, "1%"], [1.5, "1.5%"], [2, "2%"]]} value={dist} onChange={setDist} />
          <span>away</span>
          <Chips<"return" | "win" | "credit"> items={[["return", "Best return on risk"], ["win", "Highest win rate"], ["credit", "Most credit"]]} value={sort} onChange={setSort} />
        </div>
        {res && (
          <div className="text-[11px] text-term-dim">
            {res.symbol} <b className="text-term-text">{nf(res.spot, 2)}</b> · expiry <b className="text-term-text">{res.expiry}</b> ({res.sessions} trading day{res.sessions > 1 ? "s" : ""} left) · tested on{" "}
            {res.windows ? `${res.windows.toLocaleString("en-IN")} past ${res.sessions}-day stretches` : "no history for this symbol"}
            {busy ? " · searching…" : ""}
          </div>
        )}
      </div>

      {err ? (
        <div className="p-4 text-center text-[12px] text-down">{err}</div>
      ) : !res ? (
        <div className="p-6 text-center text-[12px] text-term-dim">{busy ? "Building the trades from the live option chain…" : "Set a limit and the trades appear here."}</div>
      ) : (
        <div className="space-y-3 px-3 py-3">
          {sent && <div className="rounded border border-up/50 bg-up/10 px-3 py-2 text-[12px] text-up">{sent}</div>}
          {res.note && <div className="rounded border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-400">{res.note}</div>}
          {res.trades.map((t, i) => (
            <div key={i} className="rounded-md border border-term-border bg-term-panel px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="text-[13px] font-bold text-term-text">{t.structure}</span>{" "}
                  <span className="text-[11px] text-term-dim">{t.lots} lot{t.lots > 1 ? "s" : ""} · wings {nf(t.width, 0)} pts wide</span>
                </div>
                <button
                  onClick={() => toBuild(t)}
                  className="rounded border border-term-accent bg-term-accent/15 px-3 py-1 text-[12px] font-semibold text-term-accent"
                  title="Adds these legs to the Build tab (bought legs first). If the Build tab already has legs, they are added to them."
                >
                  Review in Build ›
                </button>
              </div>
              <div className="mt-1 text-[11px] text-term-dim">{line(t)}</div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div className="rounded border border-up/40 bg-up/10 px-1 py-1">
                  <div className="text-[10px] uppercase text-term-dim">You collect</div>
                  <div className="text-[15px] font-bold text-up">{money(t.credit)}</div>
                </div>
                <div className="rounded border border-down/40 bg-down/10 px-1 py-1">
                  <div className="text-[10px] uppercase text-term-dim">Most you can lose</div>
                  <div className="text-[15px] font-bold text-down">{money(t.maxLoss)}</div>
                  {t.costs ? <div className="text-[10px] text-term-dim">+ about {money(t.costs)} costs</div> : null}
                </div>
                <div className="rounded border border-term-border px-1 py-1">
                  <div className="text-[10px] uppercase text-term-dim">Breakevens</div>
                  <div className="text-[12px] font-bold text-term-text">{t.breakevens.map((b) => nf(b, 0)).join(" – ")}</div>
                </div>
              </div>
              <div className="mt-2 text-[12px] leading-snug text-term-dim">
                {t.hist ? (
                  <>
                    In the history this made money <b className="text-term-text">{nf(t.hist.win, 0)}%</b> of the time and averaged <b className={t.hist.avg >= 0 ? "text-up" : "text-down"}>{money(t.hist.avg)}</b> a trade; the worst 5% of
                    stretches lost about <b className="text-down">{money(Math.abs(t.hist.p5))}</b> (costs included).
                  </>
                ) : (
                  <>No history for this symbol, so only today's prices are shown.</>
                )}
                {t.margin != null ? <> Margin about {money(t.margin)}.</> : null}
              </div>
            </div>
          ))}
          <div className="text-[10px] leading-snug text-term-dim">
            The loss is capped <b>at expiry and before it</b>: the bought wings limit it whatever the index does, so no gap can take more than the figure shown (plus costs). Sold legs are priced at the bid and
            bought legs at the ask. {res.cost}. The history replay is the past, not a forecast, and margin is an estimate, not the broker's figure. When you slide to execute, the bought legs go first.
          </div>
        </div>
      )}
    </div>
  );
}
