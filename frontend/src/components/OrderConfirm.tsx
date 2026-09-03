import { useMemo, useState } from "react";
import { useStore } from "../store";
import { nf, sk } from "../lib/format";

export function OrderConfirm() {
  const { pending, chain, confirmPending, cancelPending } = useStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const legs = useMemo(() => {
    if (!pending) return [];
    if (pending.kind === "single")
      return [
        {
          strike: pending.strike,
          optionType: pending.optionType,
          side: pending.side,
          lots: pending.lots,
        },
      ];
    return pending.legs.filter((l) => l.optionType !== "FUT");
  }, [pending]);

  const lotSize = chain?.lotSize ?? 1;
  const priceFor = (strike: number, ot: "CE" | "PE" | "FUT") => {
    const row = chain?.rows.find((r) => r.strike === strike);
    if (!row || ot === "FUT") return 0;
    return (ot === "CE" ? row.call.ltp : row.put.ltp) || 0;
  };
  const net = legs.reduce((s, l) => {
    const px = priceFor(l.strike, l.optionType);
    return s + (l.side === "BUY" ? 1 : -1) * px * l.lots * lotSize;
  }, 0);

  if (!pending) return null;

  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await confirmPending();
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={cancelPending}>
      <div
        className="w-[380px] rounded-lg border-2 border-down/60 bg-term-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded bg-down px-1.5 py-0.5 text-2xs font-bold text-white">LIVE ORDER</span>
          <span className="text-sm font-semibold">
            {pending.symbol} · {pending.expiry}
          </span>
        </div>
        <p className="mb-3 text-2xs text-down">
          This places {legs.length === 1 ? "a real order" : `${legs.length} real orders`} on
          Flattrade with real money. Review carefully.
        </p>

        <div className="mb-3 divide-y divide-term-border rounded border border-term-border">
          {legs.map((l, i) => {
            const px = priceFor(l.strike, l.optionType as "CE" | "PE");
            return (
              <div key={i} className="flex items-center justify-between px-2 py-1.5 text-xs">
                <span className={l.side === "BUY" ? "text-up" : "text-down"}>
                  {l.side} {l.lots}×
                </span>
                <span className="num">
                  {sk(l.strike)} {l.optionType}
                </span>
                <span className="num text-term-dim">
                  {l.lots * lotSize} qty @ ~{nf(px)}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mb-3 flex items-center justify-between text-xs">
          <span className="text-term-dim">Est. {net >= 0 ? "debit" : "credit"} · MKT order</span>
          <span className="num font-semibold">₹{nf(Math.abs(net), 0)}</span>
        </div>

        {err && <p className="mb-2 text-2xs text-down">{err}</p>}

        <div className="grid grid-cols-2 gap-2">
          <button className="btn py-2" onClick={cancelPending} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-sell py-2 font-semibold" onClick={go} disabled={busy}>
            {busy ? "Placing…" : "Place LIVE order"}
          </button>
        </div>
      </div>
    </div>
  );
}
