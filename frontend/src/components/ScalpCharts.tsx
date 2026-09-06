import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { Chart } from "./Chart";
import { MiniChart, MINI_IND_DEFAULT, type MiniInd } from "./MiniChart";

const TF: [string, number][] = [
  ["1m", 60],
  ["3m", 180],
  ["5m", 300],
  ["15m", 900],
  ["30m", 1800],
  ["1h", 3600],
  ["1D", 86400],
];
const IND_KEYS: [keyof MiniInd, string][] = [
  ["ema9", "EMA9"],
  ["ema21", "EMA21"],
  ["ema50", "EMA50"],
  ["vwap", "VWAP"],
  ["boll", "BB"],
  ["supertrend", "Supertrend"],
  ["pivots", "Pivots"],
  ["rsi", "RSI"],
];

type Pane = { sym: string; tf: number; instr: string; ind: MiniInd };

const mkPane = (sym: string, tf: number): Pane => ({
  sym,
  tf,
  instr: "",
  ind: { ...MINI_IND_DEFAULT },
});

/** Scalper view chart area: 1 full chart, or 2 / 3 MiniChart panes — each with
 *  its own symbol, timeframe, instrument (spot / ATM straddle / a strike's
 *  CE|PE) and EMA/VWAP overlays. */
export function ScalpCharts() {
  const storeSym = useStore((s) => s.symbol);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const chain = useStore((s) => s.chain);
  const watch = useStore((s) => s.watch);
  const symClassOk = useStore((s) => s.symClassOk);
  const symClass = useStore((s) => s.symClass);

  const [layout, setLayout] = useState<1 | 2 | 3>(1);

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
    mkPane(storeSym, 60),
    mkPane(storeSym, 300),
    mkPane(storeSym, 900),
  ]);

  const prevSym = useRef(storeSym);
  useEffect(() => {
    setPanes((ps) => ps.map((p) => (p.sym === prevSym.current ? { ...p, sym: storeSym } : p)));
    prevSym.current = storeSym;
  }, [storeSym]);

  const setPane = (i: number, patch: Partial<Pane>) =>
    setPanes((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const toggleInd = (i: number, k: keyof MiniInd) =>
    setPanes((ps) => ps.map((p, j) => (j === i ? { ...p, ind: { ...p.ind, [k]: !p.ind[k] } } : p)));

  // per-pane option legs available for the "derivative" picker
  const legOptions = (sym: string) =>
    watch.filter((w) => w.kind === "option" && w.symbol === sym);
  const strikes = chain?.rows.map((r) => r.strike) ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-term-panel2">
      <div className="flex flex-wrap items-center gap-2 border-b border-term-border px-3 py-1 text-2xs text-term-dim">
        <span className="font-semibold uppercase tracking-wide">Scalp charts</span>
        <span>Layout</span>
        <div className="seg">
          {([1, 2, 3] as const).map((n) => (
            <button key={n} onClick={() => setLayout(n)} className={layout === n ? "on" : ""}>
              {n === 1 ? "Single" : n === 2 ? "Split ×2" : "Split ×3"}
            </button>
          ))}
        </div>
        {layout > 1 && (
          <button
            className="btn px-2 py-0.5"
            onClick={() => setPanes((ps) => ps.map((p) => ({ ...p, sym: storeSym })))}
          >
            all → {storeSym}
          </button>
        )}
        <span className="ml-auto">
          {layout === 1 ? "full chart with indicators & split" : "each pane: symbol · TF · derivative · EMA/VWAP"}
        </span>
      </div>

      {layout === 1 ? (
        <Chart />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col divide-y divide-term-border">
          {panes.slice(0, layout).map((p, i) => (
            <div key={i} className="relative flex min-h-0 flex-1 flex-col">
              <div className="flex flex-wrap items-center gap-1.5 border-b border-term-border/60 px-2 py-1 text-[10px]">
                <select
                  value={p.sym}
                  onChange={(e) => {
                    setPane(i, { sym: e.target.value, instr: "" });
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

                {/* derivative / instrument picker */}
                <select
                  value={p.instr}
                  onChange={(e) => setPane(i, { instr: e.target.value })}
                  className="rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text outline-none focus:border-term-accent"
                  title="Instrument to chart"
                >
                  <option value="">{p.sym} spot</option>
                  <option value="STRADDLE">ATM straddle</option>
                  {p.sym === storeSym &&
                    chain &&
                    strikes.map((k) => (
                      <optgroup key={k} label={`${k}`}>
                        <option value={`${p.sym}|${chain.expiry}|${k}|CE`}>{k} CE</option>
                        <option value={`${p.sym}|${chain.expiry}|${k}|PE`}>{k} PE</option>
                      </optgroup>
                    ))}
                  {legOptions(p.sym).map((w) => (
                    <option key={w.key} value={w.key}>
                      {w.strike} {w.optionType} (watch)
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
                <div className="seg">
                  {IND_KEYS.map(([k, l]) => (
                    <button key={k} onClick={() => toggleInd(i, k)} className={p.ind[k] ? "on" : ""}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-h-0 flex-1">
                <MiniChart
                  symbol={p.sym}
                  instrument={p.instr}
                  intervalS={p.tf}
                  ind={p.ind}
                  label={`${p.sym}${p.instr && p.instr !== "STRADDLE" ? " " + p.instr.split("|").slice(2).join(" ") : p.instr === "STRADDLE" ? " straddle" : ""} · ${TF.find(([, v]) => v === p.tf)?.[0]}`}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
