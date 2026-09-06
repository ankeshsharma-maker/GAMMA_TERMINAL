import { useState } from "react";
import { useStore } from "../store";
import { nf } from "../lib/format";
import type { Position } from "../types";

export function StopEditor({ p }: { p: Position }) {
  const { setStop, clearStop } = useStore();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"points" | "amount">(p.sl?.mode ?? "points");
  const [value, setValue] = useState<number>(p.sl?.value ?? (p.sl?.mode === "amount" ? 2000 : 15));
  const [trail, setTrail] = useState<number>(p.sl?.trailValue ?? 0);
  const [target, setTarget] = useState<number>(p.sl?.targetValue ?? 0);
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    if (!(value > 0) && !(target > 0)) return;
    setBusy(true);
    try {
      await setStop(p.id, mode, value, trail, target);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    if (p.sl) {
      return (
        <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1 text-[10px] text-amber-400">
          <button onClick={() => setOpen(true)} className="font-semibold" title="Edit stop / target">
            {p.sl.stopPrice != null && <>SL {nf(p.sl.stopPrice)}</>}
            {p.sl.targetPrice != null && (
              <span className={p.sl.stopPrice != null ? "ml-1 text-up" : "text-up"}>
                TGT {nf(p.sl.targetPrice)}
              </span>
            )}
            {p.sl.trailValue > 0 && (
              <span className="ml-1 rounded bg-amber-500/30 px-0.5 text-[8px]">TRL {p.sl.trailValue}</span>
            )}
          </button>
          <button onClick={() => clearStop(p.id)} className="hover:text-down" title="Remove stop / target">
            ×
          </button>
        </span>
      );
    }
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded border border-term-border px-1 text-[10px] text-term-dim hover:text-term-text"
        title="Set stop-loss / target"
      >
        + SL / TGT
      </button>
    );
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 rounded border border-amber-500/40 bg-term-panel p-1 text-[10px]">
      <div className="flex overflow-hidden rounded border border-term-border">
        {(["points", "amount"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-1.5 py-0.5 ${mode === m ? "bg-term-accent text-white" : "text-term-dim"}`}
          >
            {m === "points" ? "Pts" : "₹"}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1 text-down">
        SL
        <input
          type="number"
          value={value}
          onChange={(e) => setValue(Math.max(0, Number(e.target.value)))}
          className="w-14 rounded border border-term-border bg-term-bg px-1 py-0.5 num outline-none focus:border-term-accent"
          placeholder={mode === "points" ? "pts" : "₹"}
          title="0 = no stop-loss"
        />
      </label>
      <label className="flex items-center gap-1 text-up">
        TGT
        <input
          type="number"
          value={target}
          onChange={(e) => setTarget(Math.max(0, Number(e.target.value)))}
          className="w-14 rounded border border-term-border bg-term-bg px-1 py-0.5 num outline-none focus:border-term-accent"
          placeholder={mode === "points" ? "pts" : "₹"}
          title="book the trade at this profit — 0 = off"
        />
      </label>
      <label className="flex items-center gap-1 text-term-dim">
        trail
        <input
          type="number"
          value={trail}
          onChange={(e) => setTrail(Math.max(0, Number(e.target.value)))}
          className="w-12 rounded border border-term-border bg-term-bg px-1 py-0.5 num outline-none focus:border-term-accent"
          title="0 = fixed stop"
        />
      </label>
      <button disabled={busy} onClick={apply} className="rounded bg-amber-500/30 px-1.5 py-0.5 text-amber-300">
        Set
      </button>
      <button onClick={() => setOpen(false)} className="px-1 text-term-dim hover:text-term-text">
        ✕
      </button>
    </div>
  );
}
