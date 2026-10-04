import { useEffect, useRef, useState } from "react";
import { api, type LabLeg, type LabOption, type LabRepair } from "../lib/api";
import { nf } from "../lib/format";
import { useStore } from "../store";
import { Chips } from "./StockScanTable";

const money = (v: number) => `${v < 0 ? "-" : ""}₹${Math.round(Math.abs(v)).toLocaleString("en-IN")}`;
const signed = (v: number) => `${v >= 0 ? "+" : "-"}₹${Math.round(Math.abs(v)).toLocaleString("en-IN")}`;
const TAG: Record<string, string> = { lowRisk: "Lowest worst case", cheapest: "Cheapest fix", keepsMost: "Keeps the most profit" };
const legText = (l: LabLeg) => `${l.side === "SELL" ? "Sold" : "Bought"} ${l.lots} lot${l.lots > 1 ? "s" : ""} ${nf(l.strike, 0)} ${l.optionType === "PE" ? "put" : "call"}${l.price ? ` @ ${nf(l.price, 2)}` : ""}`;

/** A running position -> the ways to fix it, side by side: what each costs now, the worst case it leaves, what a 1% move does, and how it tested on history. */
export function RepairTool() {
  const selectSymbol = useStore((s) => s.selectSymbol);
  const selectExpiry = useStore((s) => s.selectExpiry);
  const queueBuilderLeg = useStore((s) => s.queueBuilderLeg);
  const setView = useStore((s) => s.setView);

  const orderMode = useStore((s) => s.orderMode);
  // starts on the book that matches the header switch: PAPER -> paper positions, LIVE -> Flattrade positions
  const [source, setSource] = useState<"broker" | "paper">(orderMode === "live" ? "broker" : "paper");
  const [pos, setPos] = useState<{ symbol: string; expiry: string; legs: LabLeg[] } | null>(null);
  const [limit, setLimit] = useState("");
  const [res, setRes] = useState<LabRepair | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState("");

  const find = (p = pos) => {
    if (!p) return;
    setBusy(true);
    setErr("");
    setSent("");
    api
      .tradeLabRepair({ symbol: p.symbol, expiry: p.expiry, legs: p.legs, maxLoss: parseFloat(limit) > 0 ? parseFloat(limit) : null })
      .then(setRes)
      .catch((e) => {
        setRes(null);
        setErr(String(e?.message || e));
      })
      .finally(() => setBusy(false));
  };

  const reqId = useRef(0);
  const load = (src: "broker" | "paper" = source) => {
    const my = ++reqId.current;
    setBusy(true);
    setErr("");
    setRes(null);
    setPos(null);
    (src === "broker" ? api.strategyFromBroker() : api.strategyFromPaper())
      .then((r) => {
        if (my !== reqId.current) return; // the other book was picked meanwhile: show only the one selected
        const p = { symbol: r.symbol, expiry: r.expiry, legs: r.legs.filter((l) => l.optionType !== "FUT") as LabLeg[] };
        setPos(p);
        find(p);
      })
      .catch((e) => {
        if (my !== reqId.current) return;
        setPos(null);
        const m = String(e?.message || e);
        setErr(/no (paper|open broker)/i.test(m) ? `You have no open option positions in ${src === "broker" ? "your live Flattrade account" : "your paper book"} right now.` : m);
        setBusy(false);
      });
  };
  // choosing a book loads THAT book at once (and only that one)
  useEffect(() => {
    load(source);
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  /** to the Build tab: the position's own legs as HELD (so they are not re-sent), then the fix's legs bought-first */
  const toBuild = (o: LabOption) => {
    if (!res || !pos) return;
    selectSymbol(res.symbol, true);
    selectExpiry(res.expiry);
    for (const l of pos.legs) queueBuilderLeg({ optionType: l.optionType, strike: l.strike, side: l.side, lots: l.lots, price: l.price ?? null, held: true }, false);
    const extra = [...o.extra].sort((a, b) => (a.side === "BUY" ? 0 : 1) - (b.side === "BUY" ? 0 : 1));
    for (const l of extra) queueBuilderLeg({ optionType: l.optionType, strike: l.strike, side: l.side, lots: l.lots, price: l.price ?? null }, false);
    setSent(`"${o.name}" sent to the Build tab — your open legs are marked as held, only the new legs are sent when you slide to execute.`);
    setView("builder");
  };

  const sentence = (o: LabOption) => {
    const worst = o.maxLossUnbounded ? "an unlimited loss" : `at most ${money(Math.abs(o.maxLoss))}`;
    const cost = o.kind === "none" ? "" : o.costNow >= 0 ? `Pay ${money(o.costNow)} now. ` : `Receive ${money(-o.costNow)} now. `;
    return `${cost}Worst case after: ${worst}. If the index falls 1% you are ${signed(o.pnlDown1)}, if it rises 1% ${signed(o.pnlUp1)}.`;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-term-bg">
      <div className="space-y-2 border-b border-term-border bg-term-panel2 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-term-dim">
          <Chips<"broker" | "paper"> items={[["broker", "My live positions (Flattrade)"], ["paper", "My paper positions"]]} value={source} onChange={(v) => { setSource(v); setPos(null); setRes(null); setErr(""); }} />
          <button onClick={() => load()} disabled={busy} className="rounded border border-term-accent bg-term-accent/15 px-3 py-1 text-[12px] font-semibold text-term-accent disabled:opacity-40">
            {busy ? "Working…" : "Reload"}
          </button>
        </div>
        {pos && (
          <div className="text-[11px] text-term-dim">
            <div>
              <b className="text-term-text">{pos.symbol}</b> · expiry <b className="text-term-text">{pos.expiry}</b>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3">{pos.legs.map((l, i) => <span key={i}>{legText(l)}</span>)}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span>I want my worst case within ₹</span>
              <input
                value={limit}
                inputMode="numeric"
                placeholder="optional"
                onChange={(e) => setLimit(e.target.value.replace(/[^\d]/g, ""))}
                onBlur={() => find()}
                onKeyDown={(e) => e.key === "Enter" && find()}
                className="w-24 rounded border border-term-dim/70 bg-term-panel px-2 py-1 text-[12px] font-bold text-term-text outline-none focus:border-term-accent"
              />
            </div>
          </div>
        )}
      </div>

      {err ? (
        <div className="p-4 text-center text-[12px] text-down">{err}</div>
      ) : !res ? (
        <div className="p-6 text-center text-[12px] leading-snug text-term-dim">
          {busy ? "Reading your position and the live option chain…" : "Pick your live or paper book above: its open option position loads, and I'll line up the ways to fix it — close the tested leg, roll it, buy protection, add wings, or exit — each with its cost and the risk it leaves."}
        </div>
      ) : (
        <div className="space-y-3 px-3 py-3">
          {sent && <div className="rounded border border-up/50 bg-up/10 px-3 py-2 text-[12px] text-up">{sent}</div>}
          <div className="rounded-md border border-term-border bg-term-panel px-3 py-2 text-[12px] text-term-dim">
            {res.tested.length ? (
              <>
                Tested leg{res.tested.length > 1 ? "s" : ""}: <b className="text-down">{res.tested.map((t) => `${nf(t.strike, 0)} ${t.optionType === "PE" ? "put" : "call"}`).join(", ")}</b> (the index is at or near the
                strike, or its delta is 0.30+). {nf(res.spot, 2)} now · {res.sessions} trading day{res.sessions > 1 ? "s" : ""} left.
              </>
            ) : (
              <>None of your sold legs is tested right now ({nf(res.spot, 2)}, {res.sessions} trading day{res.sessions > 1 ? "s" : ""} left). The fixes below are for protecting the position.</>
            )}
          </div>
          {res.options.map((o, i) => {
            const tags = Object.entries(res.tags).filter(([, n]) => n === o.name).map(([k]) => TAG[k]);
            const within = res.withinLimit.includes(o.name);
            return (
              <div key={i} className={`rounded-md border px-3 py-2 ${o.kind === "none" ? "border-term-border bg-term-panel2" : "border-term-border bg-term-panel"}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-[13px] font-bold text-term-text">
                    {o.name}
                    {tags.map((t) => (
                      <span key={t} className="ml-2 rounded-full border border-up/50 bg-up/10 px-2 py-0.5 text-[10px] font-semibold text-up">{t}</span>
                    ))}
                    {within && <span className="ml-2 rounded-full border border-term-accent/60 bg-term-accent/10 px-2 py-0.5 text-[10px] font-semibold text-term-accent">within your limit</span>}
                  </div>
                  {o.kind !== "none" && o.extra.length > 0 && (
                    <button onClick={() => toBuild(o)} className="rounded border border-term-accent bg-term-accent/15 px-3 py-1 text-[12px] font-semibold text-term-accent" title="Opens the Build tab with your open legs (held) plus this fix's new legs, bought first.">
                      Review in Build ›
                    </button>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-term-dim">{o.why}</div>
                {o.extra.length > 0 && <div className="mt-1 text-[11px] text-term-text">{o.extra.map((l) => `${l.side} ${l.lots}× ${nf(l.strike, 0)} ${l.optionType === "PE" ? "put" : "call"} @ ${nf(l.price ?? 0, 2)}`).join("  ·  ")}</div>}
                <div className="mt-2 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                  <div className="rounded border border-term-border px-1 py-1">
                    <div className="text-[10px] uppercase text-term-dim">{o.costNow >= 0 ? "Pay now" : "Receive now"}</div>
                    <div className="text-[14px] font-bold text-term-text">{o.kind === "none" ? "–" : money(Math.abs(o.costNow))}</div>
                  </div>
                  <div className="rounded border border-down/40 bg-down/10 px-1 py-1">
                    <div className="text-[10px] uppercase text-term-dim">Worst case</div>
                    <div className="text-[14px] font-bold text-down">{o.maxLossUnbounded ? "Unlimited" : money(Math.abs(o.maxLoss))}</div>
                  </div>
                  <div className="rounded border border-up/40 bg-up/10 px-1 py-1">
                    <div className="text-[10px] uppercase text-term-dim">Best case</div>
                    <div className="text-[14px] font-bold text-up">{o.maxProfitUnbounded ? "Unlimited" : money(o.maxProfit)}</div>
                  </div>
                  <div className="rounded border border-term-border px-1 py-1">
                    <div className="text-[10px] uppercase text-term-dim">P&L now</div>
                    <div className={`text-[14px] font-bold ${o.pnlNow >= 0 ? "text-up" : "text-down"}`}>{signed(o.pnlNow)}</div>
                  </div>
                </div>
                <div className="mt-2 text-[12px] leading-snug text-term-dim">
                  {sentence(o)}
                  {o.hist && o.hist.n > 0 ? (
                    <> In the history this position made money <b className="text-term-text">{nf(o.hist.win, 0)}%</b> of the time and averaged <b className={o.hist.avg >= 0 ? "text-up" : "text-down"}>{signed(o.hist.avg)}</b>; the worst 5% lost about {money(Math.abs(o.hist.p5))}.</>
                  ) : null}
                </div>
              </div>
            );
          })}
          <div className="text-[10px] leading-snug text-term-dim">
            Prices: bought at the ask, sold at the bid. "P&L now" and the 1% moves come from the option model (delta / gamma / time), the worst and best cases are at expiry, and the history line replays the position as it would then
            stand over {res.windows ? `${res.windows.toLocaleString("en-IN")} past ${res.sessions}-day stretches` : "no stretches (no history for this symbol)"}. A "worst case" of unlimited means a sold leg is still uncovered on one side.
            Nothing is sent from here — the Build tab is where you slide to execute.
          </div>
        </div>
      )}
    </div>
  );
}
