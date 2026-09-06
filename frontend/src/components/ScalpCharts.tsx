import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { MiniChart } from "./MiniChart";

const TF: [string, number][] = [
  ["1m", 60],
  ["3m", 180],
  ["5m", 300],
  ["15m", 900],
  ["30m", 1800],
  ["1h", 3600],
  ["1D", 86400],
];

type Pane = { sym: string; tf: number };

/** Scalper view: three synced candlestick panes — watch one symbol on three
 *  timeframes, or three different symbols, side by side. Each pane picks its
 *  own symbol + timeframe. */
export function ScalpCharts() {
  const storeSym = useStore((s) => s.symbol);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const symClassOk = useStore((s) => s.symClassOk);
  const symClass = useStore((s) => s.symClass);

  const [choices, setChoices] = useState<string[]>([]);
  useEffect(() => {
    api.symbols().then(
      (d) =>
        setChoices(
          [...new Set([...(d.indices ?? []), ...(d.fo ?? []), ...(d.defaults ?? [])])].sort()
        ),
      () => {}
    );
  }, []);
  const symOptions = useMemo(
    () =>
      [...new Set([storeSym, ...choices])]
        .filter(Boolean)
        .filter((s) => s === storeSym || symClassOk(s))
        .sort(),
    [storeSym, choices, symClass, symClassOk]
  );

  const [panes, setPanes] = useState<Pane[]>([
    { sym: storeSym, tf: 60 },
    { sym: storeSym, tf: 300 },
    { sym: storeSym, tf: 900 },
  ]);

  // keep panes that still point at the "old" store symbol following it
  const prevSym = useRef(storeSym);
  useEffect(() => {
    setPanes((ps) =>
      ps.map((p) => (p.sym === prevSym.current ? { ...p, sym: storeSym } : p))
    );
    prevSym.current = storeSym;
  }, [storeSym]);

  const setPane = (i: number, patch: Partial<Pane>) =>
    setPanes((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <div className="flex min-h-0 flex-1 flex-col divide-y divide-term-border bg-term-panel2">
      <div className="flex items-center gap-2 border-b border-term-border px-3 py-1 text-2xs text-term-dim">
        <span className="font-semibold uppercase tracking-wide">Scalp charts</span>
        <button
          className="btn px-2 py-0.5"
          onClick={() => setPanes((ps) => ps.map((p) => ({ ...p, sym: storeSym })))}
          title="Point all three panes at the active symbol"
        >
          all → {storeSym}
        </button>
        <span className="ml-auto">one symbol · 3 timeframes, or 3 symbols</span>
      </div>

      {panes.map((p, i) => (
        <div key={i} className="relative flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1.5 border-b border-term-border/60 px-2 py-1 text-[10px]">
            <select
              value={p.sym}
              onChange={(e) => {
                setPane(i, { sym: e.target.value });
                selectSymbol(e.target.value, true);
              }}
              className="rounded border border-term-border bg-term-bg px-1 py-0.5 font-semibold text-term-text outline-none focus:border-term-accent"
            >
              {[...new Set([p.sym, ...symOptions])].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <div className="seg">
              {TF.map(([l, v]) => (
                <button key={v} onClick={() => setPane(i, { tf: v })} className={p.tf === v ? "on" : ""}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <MiniChart symbol={p.sym} instrument="" intervalS={p.tf} label={`${p.sym} · ${labelFor(p.tf)}`} />
          </div>
        </div>
      ))}
    </div>
  );
}

function labelFor(tf: number) {
  return TF.find(([, v]) => v === tf)?.[0] ?? `${tf}s`;
}
