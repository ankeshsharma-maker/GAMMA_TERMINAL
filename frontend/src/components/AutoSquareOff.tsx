import { useEffect, useState } from "react";
import { api, type BrokerBracket } from "../lib/api";
import { nf } from "../lib/format";

/** Profit Guard + portfolio-level auto square-off for live broker positions, as a compact trigger
 *  and popover. Server-side, so it works with the app closed. Profit Guard watches the day's PEAK
 *  P&L: lock part of it once it's big enough, warn when it starts slipping, and exit (or only
 *  alert) when too much has been given back. The older rupee SL / target / trail / floor stay. */
export function AutoSquareOff() {
  const [open, setOpen] = useState(false);
  const [bracket, setBracket] = useState<BrokerBracket | null>(null);
  const [slAmt, setSlAmt] = useState("");
  const [tgtAmt, setTgtAmt] = useState("");
  const [trailAmt, setTrailAmt] = useState("");
  const [floorAmt, setFloorAmt] = useState("");
  const [bBasis, setBBasis] = useState<"today" | "mtm">("today");
  // Profit Guard
  const [lockAfter, setLockAfter] = useState("3000");
  const [lockPct, setLockPct] = useState("50");
  const [giveback, setGiveback] = useState("");
  const [warnPct, setWarnPct] = useState("25");
  const [action, setAction] = useState<"alert" | "squareoff">("alert");

  useEffect(() => {
    let alive = true;
    const load = () => api.brokerBracket().then((b) => alive && setBracket(b), () => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const n = (v: string) => parseFloat(v) || 0;
  const guardParts = [
    n(lockAfter) > 0 ? (n(lockPct) > 0 ? `keep ${n(lockPct)}% of the peak once it reaches ₹${nf(n(lockAfter), 0)}` : `never below breakeven once it reaches ₹${nf(n(lockAfter), 0)}`) : "",
    n(giveback) > 0 ? `exit after giving back ${n(giveback)}% of the peak` : "",
    n(warnPct) > 0 ? `warn at ${n(warnPct)}% given back` : "",
  ].filter(Boolean);
  const oldParts = [
    n(slAmt) > 0 ? `≤ −₹${nf(n(slAmt), 0)}` : "",
    n(trailAmt) > 0 ? `₹${nf(n(trailAmt), 0)} back off its peak` : "",
    n(floorAmt) > 0 ? `back down to ₹${nf(n(floorAmt), 0)} (once above it)` : "",
    n(tgtAmt) > 0 ? `≥ +₹${nf(n(tgtAmt), 0)}` : "",
  ].filter(Boolean);
  const anything = guardParts.length > 0 || oldParts.length > 0;

  const armBracket = async () => {
    if (!anything) return;
    const lbl = bBasis === "today" ? "today's P&L" : "open MTM";
    const what =
      action === "alert"
        ? "ALERT you (app + Telegram) — nothing is sold or bought"
        : "flatten ALL broker positions with MARKET orders";
    const cond = [...guardParts, ...oldParts.map((p) => `${lbl} ${p}`)].join("; ");
    if (!window.confirm(`Profit Guard on ${lbl}:\n${cond}\n\nWhen a level is hit it will ${what}.\nRuns on the server. Turn it on?`)) return;
    try {
      setBracket(
        await api.brokerBracketSet({
          enabled: true,
          slAmount: n(slAmt),
          targetAmount: n(tgtAmt),
          trailAmount: n(trailAmt),
          floorAmount: n(floorAmt),
          basis: bBasis,
          lockAfter: n(lockAfter),
          lockPct: n(lockPct),
          givebackPct: n(giveback),
          warnPct: n(warnPct),
          action,
        })
      );
    } catch (e: any) {
      alert(String(e?.message || e));
    }
  };
  const disarmBracket = async () => {
    try {
      setBracket(await api.brokerBracketClear());
    } catch (e: any) {
      alert(String(e?.message || e));
    }
  };

  const armed = !!bracket?.enabled;
  const b = bracket;
  const statusLine = armed
    ? `ON — ${b!.action === "alert" ? "alerts you" : "flattens ALL"} at ${
        b!.stopLevel != null ? `₹${nf(b!.stopLevel, 0)}` : "the levels you set"
      }${b!.peakPnl != null ? ` · peak ₹${nf(b!.peakPnl, 0)}` : ""}${b!.lastPnl != null ? ` · now ₹${nf(b!.lastPnl, 0)}` : ""}`
    : b?.triggeredAt
    ? `⚠ ${b.lastReason}`
    : "Watches your live positions on the server, even with the app closed.";

  const inp = "num w-14 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-term-text outline-none focus:border-term-accent";
  const numOnly = (f: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => f(e.target.value.replace(/[^\d.]/g, ""));
  const preset = (label: string, set: () => void) => (
    <button key={label} type="button" onClick={set} className="chipbtn">
      {label}
    </button>
  );

  return (
    <div className="relative ml-auto">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 rounded border px-2 py-1 text-2xs font-semibold ${
          armed
            ? "border-up/50 bg-up/15 text-up"
            : b?.triggeredAt
            ? "border-amber-500/50 bg-amber-500/15 text-amber-400"
            : "border-term-dim/70 text-term-dim hover:bg-term-border"
        }`}
        title={statusLine}
      >
        ⛨ Profit guard {armed ? `· ON${b?.stopLevel != null ? ` @ ₹${nf(b.stopLevel, 0)}` : ""}` : b?.triggeredAt ? "· ⚠" : ""}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-[360px] max-w-[calc(100vw-16px)] space-y-2.5 rounded-lg border border-term-border bg-term-panel p-3 text-2xs shadow-2xl">
            {/* ---- protect a profit that is slipping away ---- */}
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-term-dim">Protect my profit</div>
              <div className="flex flex-wrap gap-1">
                {preset("Breakeven after ₹2,000", () => {
                  setLockAfter("2000");
                  setLockPct("0");
                })}
                {preset("Keep 50% after ₹3,000", () => {
                  setLockAfter("3000");
                  setLockPct("50");
                })}
                {preset("Exit at 40% given back", () => setGiveback("40"))}
                {preset("Warn at 25%", () => setWarnPct("25"))}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-term-dim">
                <span>once profit reaches ₹</span>
                <input value={lockAfter} onChange={numOnly(setLockAfter)} placeholder="0" className={inp} />
                <span>keep</span>
                <input value={lockPct} onChange={numOnly(setLockPct)} placeholder="0" className={`${inp} w-10`} />
                <span>% of the peak (0 = breakeven)</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-term-dim">
                <span>exit after giving back</span>
                <input value={giveback} onChange={numOnly(setGiveback)} placeholder="off" className={`${inp} w-10`} />
                <span>% · warn at</span>
                <input value={warnPct} onChange={numOnly(setWarnPct)} placeholder="off" className={`${inp} w-10`} />
                <span>%</span>
              </div>
            </div>

            {/* ---- the fixed rupee levels (unchanged) ---- */}
            <div className="space-y-1.5 border-t border-term-border pt-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-term-dim">Fixed ₹ levels (optional)</div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-term-dim">
                <label className="flex items-center gap-1">
                  SL ₹
                  <input value={slAmt} onChange={numOnly(setSlAmt)} placeholder="0" className={inp} />
                </label>
                <label className="flex items-center gap-1">
                  Target ₹
                  <input value={tgtAmt} onChange={numOnly(setTgtAmt)} placeholder="0" className={inp} />
                </label>
                <label className="flex items-center gap-1" title="Stop rises with the peak P&L and fires this many rupees off it">
                  Trail ₹
                  <input value={trailAmt} onChange={numOnly(setTrailAmt)} placeholder="0" className={inp} />
                </label>
                <label className="flex items-center gap-1" title="Once P&L first rises above this, exits if it ever drops back down to it">
                  Floor ₹
                  <input value={floorAmt} onChange={numOnly(setFloorAmt)} placeholder="0" className={inp} />
                </label>
              </div>
            </div>

            {/* ---- what to do, and on which P&L ---- */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-term-border pt-2">
              <span className="text-term-dim">when hit</span>
              <div className="seg">
                <button type="button" className={action === "alert" ? "on" : ""} onClick={() => setAction("alert")}>
                  Alert me
                </button>
                <button type="button" className={action === "squareoff" ? "on" : ""} onClick={() => setAction("squareoff")}>
                  Square off all
                </button>
              </div>
              <div className="seg">
                {(["today", "mtm"] as const).map((x) => (
                  <button key={x} onClick={() => setBBasis(x)} className={bBasis === x ? "on" : ""}>
                    {x === "today" ? "Today P&L" : "MTM"}
                  </button>
                ))}
              </div>
              {armed ? (
                <button onClick={disarmBracket} className="btn ml-auto font-semibold text-amber-400">
                  Turn off
                </button>
              ) : (
                <button onClick={armBracket} disabled={!anything} className="btn btn-buy ml-auto font-semibold disabled:opacity-40">
                  Turn on
                </button>
              )}
            </div>
            {!armed && anything && (
              <p className="text-[11px] leading-snug text-term-text">
                {[...guardParts, ...oldParts].join("; ")} →{" "}
                <span className={action === "alert" ? "text-amber-400" : "text-down"}>
                  {action === "alert" ? "alert me (no orders)" : "square off everything"}
                </span>
              </p>
            )}
            <p className="text-[10px] leading-snug text-term-dim">{statusLine}</p>
          </div>
        </>
      )}
    </div>
  );
}
