import { useEffect, useState } from "react";
import { api, type BrokerBracket } from "../lib/api";
import { nf } from "../lib/format";

/** Portfolio-level auto square-off: a compact trigger + popover (moved out of
 *  BrokerTab's own body and into the Positions tab bar to save vertical
 *  space) — server-side MARKET-flattens every open broker position once the
 *  P&L threshold is crossed, works with the app closed. Only rendered while
 *  the Broker Positions sub-tab is active and a broker is connected. */
export function AutoSquareOff() {
  const [open, setOpen] = useState(false);
  const [bracket, setBracket] = useState<BrokerBracket | null>(null);
  const [slAmt, setSlAmt] = useState("");
  const [tgtAmt, setTgtAmt] = useState("");
  const [trailAmt, setTrailAmt] = useState("");
  const [floorAmt, setFloorAmt] = useState("");
  const [bBasis, setBBasis] = useState<"today" | "mtm">("today");

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

  const armBracket = async () => {
    const sl = parseFloat(slAmt) || 0;
    const tgt = parseFloat(tgtAmt) || 0;
    const trail = parseFloat(trailAmt) || 0;
    const floor = parseFloat(floorAmt) || 0;
    if (sl <= 0 && tgt <= 0 && trail <= 0 && floor <= 0) return;
    const lbl = bBasis === "today" ? "today's P&L" : "open MTM";
    const parts = [
      sl > 0 ? `≤ −₹${nf(sl, 0)}` : "",
      trail > 0 ? `₹${nf(trail, 0)} back off its peak` : "",
      floor > 0 ? `back down to ₹${nf(floor, 0)} (once it's gone above that)` : "",
      tgt > 0 ? `≥ +₹${nf(tgt, 0)}` : "",
    ].filter(Boolean);
    const cond = parts.join(" or ");
    if (
      !window.confirm(
        `Auto square-off: flatten ALL broker positions with MARKET orders when ${lbl} is ${cond}.\nRuns on the server. Arm it now?`
      )
    )
      return;
    try {
      setBracket(
        await api.brokerBracketSet({
          enabled: true,
          slAmount: sl,
          targetAmount: tgt,
          trailAmount: trail,
          floorAmount: floor,
          basis: bBasis,
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
  const statusLine = armed
    ? `ARMED — flattens ALL when ${bracket!.basis === "today" ? "today's P&L" : "MTM"} ${[
        bracket!.slAmount > 0 ? `≤ −₹${nf(bracket!.slAmount, 0)}` : "",
        bracket!.trailAmount > 0 ? `₹${nf(bracket!.trailAmount, 0)} back off its peak` : "",
        bracket!.targetAmount > 0 ? `≥ +₹${nf(bracket!.targetAmount, 0)}` : "",
        bracket!.floorAmount > 0 ? `back to ₹${nf(bracket!.floorAmount, 0)} (once above it)` : "",
      ]
        .filter(Boolean)
        .join(" or ")}${
        (bracket!.trailAmount > 0 || bracket!.floorAmount > 0) && bracket!.peakPnl != null
          ? ` · peak ₹${nf(bracket!.peakPnl, 0)}`
          : ""
      }${bracket!.lastPnl != null ? ` · now ₹${nf(bracket!.lastPnl, 0)}` : ""}`
    : bracket?.triggeredAt
    ? `⚠ ${bracket.lastReason}`
    : "server-side: MARKET-flattens every position when the P&L threshold is crossed (works with the app closed).";

  return (
    <div className="relative ml-auto">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 rounded border px-2 py-1 text-2xs font-semibold ${
          armed
            ? "border-up/50 bg-up/15 text-up"
            : bracket?.triggeredAt
            ? "border-amber-500/50 bg-amber-500/15 text-amber-400"
            : "border-term-dim/70 text-term-dim hover:bg-term-border"
        }`}
        title={statusLine}
      >
        ⛨ Auto square-off {armed ? "· ARMED" : bracket?.triggeredAt ? "· ⚠" : ""}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-[340px] space-y-1.5 rounded-lg border border-term-border bg-term-panel p-3 text-2xs shadow-2xl">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <div className="seg">
                {(["today", "mtm"] as const).map((b) => (
                  <button key={b} onClick={() => setBBasis(b)} className={bBasis === b ? "on" : ""}>
                    {b === "today" ? "Today P&L" : "MTM"}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1 text-term-dim">
                SL ₹
                <input
                  value={slAmt}
                  onChange={(e) => setSlAmt(e.target.value.replace(/[^\d.]/g, ""))}
                  placeholder="0"
                  className="num w-16 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-term-text outline-none focus:border-down"
                />
              </label>
              <label className="flex items-center gap-1 text-term-dim">
                Target ₹
                <input
                  value={tgtAmt}
                  onChange={(e) => setTgtAmt(e.target.value.replace(/[^\d.]/g, ""))}
                  placeholder="0"
                  className="num w-16 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-term-text outline-none focus:border-up"
                />
              </label>
              <label className="flex items-center gap-1 text-term-dim">
                Trail ₹
                <input
                  value={trailAmt}
                  onChange={(e) => setTrailAmt(e.target.value.replace(/[^\d.]/g, ""))}
                  placeholder="0"
                  title="Stop rises with the peak P&L and fires this many rupees off it"
                  className="num w-16 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-term-text outline-none focus:border-term-accent"
                />
              </label>
              <label className="flex items-center gap-1 text-term-dim">
                Floor ₹
                <input
                  value={floorAmt}
                  onChange={(e) => setFloorAmt(e.target.value.replace(/[^\d.]/g, ""))}
                  placeholder="0"
                  title="Fixed profit floor — once P&L first rises above this, exits if it ever drops back down to it, no matter how high it peaked"
                  className="num w-16 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-term-text outline-none focus:border-term-accent"
                />
              </label>
              {armed ? (
                <button onClick={disarmBracket} className="btn ml-auto font-semibold text-amber-400">
                  Disarm
                </button>
              ) : (
                <button
                  onClick={armBracket}
                  disabled={!parseFloat(slAmt) && !parseFloat(tgtAmt) && !parseFloat(trailAmt) && !parseFloat(floorAmt)}
                  className="btn btn-sell ml-auto font-semibold disabled:opacity-40"
                >
                  Arm
                </button>
              )}
            </div>
            <p className="text-[10px] leading-snug text-term-dim">{statusLine}</p>
          </div>
        </>
      )}
    </div>
  );
}
