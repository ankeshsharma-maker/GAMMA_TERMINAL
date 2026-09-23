import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, sk } from "../lib/format";
import { isDown, isUp, useTrend } from "./TrendCompass";

const rupee = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

// +1 = gains if the underlying rises, −1 = gains if it falls
const lean = (ot: "CE" | "PE" | "FUT", side: "BUY" | "SELL") => (ot === "PE" ? -1 : 1) * (side === "BUY" ? 1 : -1);

export function OrderConfirm() {
  const { pending, chain, confirmPending, cancelPending } = useStore();
  const funds = useStore((s) => s.brokerFunds);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [marginEst, setMarginEst] = useState<number | null>(null);
  const trend = useTrend(pending?.symbol);

  const legs = useMemo(() => {
    if (!pending) return [];
    if (pending.kind === "single")
      return [
        {
          strike: pending.strike,
          optionType: pending.optionType,
          side: pending.side,
          lots: pending.lots,
          price: pending.price,
        },
      ];
    return pending.legs.filter((l) => l.optionType !== "FUT");
  }, [pending]);

  const lotSize = chain?.lotSize ?? 1;
  const priceFor = (strike: number, ot: "CE" | "PE" | "FUT", knownPrice?: number | null) => {
    if (ot === "FUT") return knownPrice || 0;
    const row = chain?.rows.find((r) => r.strike === strike);
    if (!row) return 0;
    return (ot === "CE" ? row.call.ltp : row.put.ltp) || 0;
  };
  const net = legs.reduce((s, l) => {
    const px = priceFor(l.strike, l.optionType, l.price);
    return s + (l.side === "BUY" ? 1 : -1) * px * l.lots * lotSize;
  }, 0);

  // rough pre-trade margin check -- not real SPAN, just enough to warn
  // before submitting instead of finding out from a broker rejection after
  useEffect(() => {
    if (!legs.length) {
      setMarginEst(null);
      return;
    }
    let alive = true;
    api
      .marginEstimate(
        legs.map((l) => ({ side: l.side, strike: l.strike, lots: l.lots, price: priceFor(l.strike, l.optionType, l.price) })),
        lotSize
      )
      .then((d) => alive && setMarginEst(d.estimated), () => alive && setMarginEst(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs, lotSize]);

  if (!pending) return null;

  const shortfall =
    marginEst != null && funds?.available != null ? marginEst - funds.available : null;

  // only when every leg leans the wrong way -- a strangle / spread that is
  // deliberately two-sided shouldn't nag
  const leans = legs.map((l) => lean(l.optionType, l.side));
  const against =
    trend && leans.length > 0
      ? isUp(trend.overall) && leans.every((x) => x < 0)
        ? "UP"
        : isDown(trend.overall) && leans.every((x) => x > 0)
        ? "DOWN"
        : null
      : null;

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
            const px = priceFor(l.strike, l.optionType, l.price);
            return (
              <div key={i} className="flex items-center justify-between px-2 py-1.5 text-xs">
                <span className={l.side === "BUY" ? "text-up" : "text-down"}>
                  {l.side} {l.lots}×
                </span>
                <span className="num">
                  {l.optionType === "FUT" ? "FUT" : `${sk(l.strike)} ${l.optionType}`}
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

        {shortfall != null && shortfall > 0 && (
          <div className="mb-3 rounded border border-down/50 bg-down/10 px-2.5 py-2 text-2xs text-down">
            ⚠ Est. margin needed ≈ {rupee(marginEst!)}, but only {rupee(funds!.available!)} is available —
            likely short by ≈ {rupee(shortfall)}. This is a rough estimate (not real SPAN); the broker may
            still accept or reject it, but expect a possible margin rejection.
          </div>
        )}

        {against && trend && (
          <div className="mb-3 rounded border border-amber-500/60 bg-amber-500/10 px-2.5 py-2 text-2xs text-amber-300">
            ⚠ Against the trend: {pending.symbol} reads <b>{against}</b> ({trend.up}↑ {trend.down}↓ of {trend.total}{" "}
            signals across 5m / 15m / 1h + option flow). This order only makes money if the move{" "}
            {against === "UP" ? "stops or reverses down" : "stops or reverses up"} from here.
          </div>
        )}

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
