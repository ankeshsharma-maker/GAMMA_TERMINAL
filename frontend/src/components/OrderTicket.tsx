import { useState } from "react";
import { useStore } from "../store";
import { nf, sk } from "../lib/format";

interface Props {
  strike: number;
  optionType: "CE" | "PE";
  ltp: number;
  onClose: () => void;
}

export function OrderTicket({ strike, optionType, ltp, onClose }: Props) {
  const { symbol, expiry, chain, placeOrder } = useStore();
  const [lots, setLots] = useState(1);
  const [busy, setBusy] = useState(false);
  const lotSize = chain?.lotSize ?? 1;

  const fire = async (side: "BUY" | "SELL") => {
    setBusy(true);
    try {
      await placeOrder({ strike, optionType, side, lots });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-72 rounded-lg border border-term-border bg-term-panel p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-sm font-semibold">
            {symbol} {sk(strike)} {optionType}
          </span>
          <span className="num text-xs text-term-dim">{expiry}</span>
        </div>
        <div className="mb-3 flex items-center justify-between text-xs text-term-dim">
          <span>LTP</span>
          <span className="num text-term-text">{nf(ltp)}</span>
        </div>
        <label className="mb-1 block text-2xs uppercase text-term-dim">Lots (×{lotSize})</label>
        <div className="mb-3 flex items-center gap-2">
          <button className="btn" onClick={() => setLots((l) => Math.max(1, l - 1))}>
            −
          </button>
          <input
            type="number"
            min={1}
            value={lots}
            onChange={(e) => setLots(Math.max(1, Number(e.target.value) || 1))}
            className="w-16 rounded border border-term-border bg-term-bg px-2 py-1 text-center num text-sm outline-none focus:border-term-accent"
          />
          <button className="btn" onClick={() => setLots((l) => l + 1)}>
            +
          </button>
          <span className="ml-auto num text-xs text-term-dim">
            ≈ ₹{nf(ltp * lots * lotSize, 0)}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button disabled={busy} className="btn btn-buy py-2 font-semibold" onClick={() => fire("BUY")}>
            BUY
          </button>
          <button disabled={busy} className="btn btn-sell py-2 font-semibold" onClick={() => fire("SELL")}>
            SELL
          </button>
        </div>
        <p className="mt-2 text-center text-[10px] text-term-dim">Paper order · marked at LTP</p>
      </div>
    </div>
  );
}
