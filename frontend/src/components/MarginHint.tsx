import { useEffect, useState } from "react";
import { useStore } from "../store";
import { isViewer } from "../lib/auth";

const rupee = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** Live orders only: what Flattrade says this order needs (real SPAN, nothing is placed) against the free
 *  margin, before you press the button. When it does not fit, says by how much and offers the most lots
 *  that do, instead of finding out from a rejection. `fetcher` asks the broker for `lots` lots. */
export function MarginHint({
  fetcher,
  lots,
  onSetLots,
  deps,
}: {
  fetcher: (lots: number) => Promise<{ ok: boolean; margin?: number; reason?: string }>;
  lots: number;
  onSetLots: (n: number) => void;
  deps: unknown[];
}) {
  const live = useStore((s) => s.orderMode === "live");
  const funds = useStore((s) => s.brokerFunds);
  const avail = funds?.available ?? null;
  const [need, setNeed] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setNeed(null);
    setNote(null);
    if (!live || isViewer() || lots < 1) return;
    let alive = true;
    // wait for the lots stepper to settle
    const t = window.setTimeout(() => {
      fetcher(lots).then(
        (d) => {
          if (!alive) return;
          if (d.ok && d.margin != null) setNeed(d.margin);
          else setNote(d.reason ?? "the broker could not check the margin");
        },
        (e) => alive && setNote(String(e?.message || e))
      );
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, lots, ...deps]);

  if (!live || isViewer()) return null;
  if (need == null)
    return note ? (
      <div className="mt-2 text-[10px] text-term-dim" title={note}>
        Margin check unavailable — the broker decides
      </div>
    ) : (
      <div className="mt-2 text-[10px] text-term-dim">Checking margin…</div>
    );

  const short = avail != null ? need - avail : null;
  // margin scales close to linearly with the lots for one contract
  const perLot = need / lots;
  const fit = avail != null && perLot > 0 ? Math.floor(avail / perLot) : null;

  if (short != null && short > 0)
    return (
      <div className="mt-2 rounded-md border border-down/60 bg-down/10 px-2.5 py-2 text-[12px] text-down">
        <div className="font-semibold">
          ⚠ Not enough margin: needs {rupee(need)}, {rupee(avail!)} free — short by {rupee(short)}
        </div>
        <div className="mt-0.5 text-[11px] opacity-90">Flattrade would reject this order.</div>
        {fit != null && fit >= 1 ? (
          <button
            type="button"
            onClick={() => onSetLots(fit)}
            className="mt-1.5 rounded border border-down/70 bg-down/20 px-2.5 py-1 text-[12px] font-bold text-white hover:bg-down/40"
          >
            Use {fit} lot{fit === 1 ? "" : "s"} (fits your margin)
          </button>
        ) : (
          <div className="mt-1 text-[11px] font-semibold">Not enough margin even for 1 lot.</div>
        )}
      </div>
    );

  return (
    <div className="mt-2 flex items-center justify-between text-[11px] text-term-dim">
      <span>Margin needed</span>
      <span className="num text-term-text">
        {rupee(need)}
        {avail != null && <span className="text-term-dim"> of {rupee(avail)} free ✓</span>}
      </span>
    </div>
  );
}
