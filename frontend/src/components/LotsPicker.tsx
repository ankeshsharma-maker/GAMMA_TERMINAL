import { useEffect, useRef, useState } from "react";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Fast lots entry for the order sheets: type the number, tap a preset, or hold + / − and it speeds up
 *  (one tap = 1 lot; held: 1 lot at a time, then 2, then 5), instead of tapping + once per lot. */
export function LotsPicker({
  lots,
  setLots,
  chips,
  min = 1,
  max = 500,
}: {
  lots: number;
  setLots: (n: number) => void;
  /** presets under the stepper: [label, lots] */
  chips: readonly (readonly [string, number])[];
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cur = useRef(lots);
  cur.current = lots;
  const timer = useRef<number | null>(null);
  const held = useRef(0);
  const stop = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    held.current = 0;
  };
  useEffect(() => stop, []);
  const step = (dir: 1 | -1) => {
    const inc = held.current >= 14 ? 5 : held.current >= 6 ? 2 : 1;
    setDraft(null); // the buttons win over a half-typed number
    setLots(clamp(cur.current + dir * inc, min, max));
  };
  const start = (dir: 1 | -1) => (e: React.PointerEvent) => {
    e.preventDefault();
    stop();
    step(dir); // the tap itself
    const loop = () => {
      held.current += 1;
      step(dir);
      timer.current = window.setTimeout(loop, 90);
    };
    timer.current = window.setTimeout(loop, 420);
  };
  const btn = "flex h-11 w-12 shrink-0 select-none items-center justify-center rounded-lg border border-term-border bg-term-panel2 text-xl font-bold text-term-text active:bg-term-accent/30";

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <button type="button" aria-label="fewer lots" className={btn} onPointerDown={start(-1)} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop} style={{ touchAction: "none" }}>
          −
        </button>
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          aria-label="lots"
          value={draft ?? String(lots)}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const d = e.target.value.replace(/\D/g, "").slice(0, 3);
            setDraft(d);
            if (d !== "") setLots(clamp(parseInt(d, 10), min, max));
          }}
          onBlur={() => setDraft(null)}
          className="num h-11 min-w-0 flex-1 rounded-lg border border-term-border bg-term-bg text-center text-lg font-bold text-term-text outline-none focus:border-term-accent"
        />
        <button type="button" aria-label="more lots" className={btn} onPointerDown={start(1)} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop} style={{ touchAction: "none" }}>
          +
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {chips.map(([label, v]) => (
          <button
            key={label}
            type="button"
            onClick={() => {
              setDraft(null);
              setLots(clamp(v, min, max));
            }}
            className={`rounded-md border px-2.5 py-1 text-[12px] font-semibold tabular-nums ${
              lots === v ? "border-term-accent bg-term-accent/20 text-term-text" : "border-term-border text-term-dim hover:text-term-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
