import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, sk, signColor } from "../lib/format";
import type { ScenarioData, ScenarioPosition } from "../types";

/** Portfolio stress test: everything open (paper and/or broker) repriced under a spot shock
 *  x IV shift x days-forward grid. Click a cell to see which positions make or lose it.
 *  In a narrow panel (a phone) the grid turns on its side -- spot moves down, the 7 IV
 *  shifts across -- and the tables become one block per row, so nothing scrolls sideways. */

type Source = "paper" | "broker" | "all";
const DAYS: [number, string][] = [
  [0, "Now"],
  [1, "+1 day"],
  [2, "+2 days"],
  [5, "+5 days"],
  [-1, "To expiry"],
];

const sign = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "");
/** compact ₹ with lakh / crore shorthand so a big cell still fits */
const short = (v: number) => {
  const a = Math.abs(v);
  if (a < 0.5) return "0";
  if (a >= 1e7) return `${sign(v)}${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${sign(v)}${(a / 1e5).toFixed(2)}L`;
  if (a >= 1e4) return `${sign(v)}${(a / 1e3).toFixed(1)}K`;
  return `${sign(v)}${nf(a, 0)}`;
};
const rupee = (v: number) => `${sign(v)}₹${nf(Math.abs(v), 0)}`;
const pctLabel = (x: number) => (x === 0 ? "0%" : `${sign(x)}${Math.abs(x)}%`);
const ivLabel = (d: number) => (d === 0 ? "IV ±0" : `IV ${sign(d)}${Math.abs(d)}`);

function Stat({ label, value, cls = "", sub, title }: { label: string; value: string; cls?: string; sub?: string; title?: string }) {
  return (
    <div className="flex min-w-[96px] flex-1 flex-col rounded border border-term-border px-2.5 py-1.5" title={title}>
      <span className="text-[9px] uppercase tracking-wide text-term-dim">{label}</span>
      <span className={`num text-sm font-semibold ${cls}`}>{value}</span>
      {sub && <span className="num text-[10px] text-term-dim">{sub}</span>}
    </div>
  );
}

const legName = (p: ScenarioPosition) =>
  p.type === "FUT" ? `${p.symbol} FUT ${p.expiry.slice(0, 6)}` : `${p.symbol} ${sk(p.strike)} ${p.type}`;

export function ScenarioGrid() {
  const orderMode = useStore((s) => s.orderMode);
  const [source, setSource] = useState<Source>(orderMode === "live" ? "broker" : "paper");
  const [days, setDays] = useState(0);
  const [showTotal, setShowTotal] = useState(false);
  const [data, setData] = useState<ScenarioData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<[number, number] | null>(null);
  // narrow = the phone layout; decided by this panel's own width
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 900px)").matches);

  useEffect(() => {
    let alive = true;
    setData(null);
    setErr(null);
    const load = () => {
      setBusy(true);
      return api
        .portfolioScenario(source, days)
        .then((d) => {
          if (!alive) return;
          setData(d);
          setErr(null);
        })
        .catch((e) => alive && setErr(String(e?.message ?? e)))
        .finally(() => alive && setBusy(false));
    };
    load();
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [source, days]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 640));
    ro.observe(el);
    return () => ro.disconnect();
  }, [data == null]);

  const worstIdx = useMemo<[number, number] | null>(() => {
    if (!data?.worst) return null;
    return [data.ivShifts.indexOf(data.worst.iv), data.spotShocks.indexOf(data.worst.spot)];
  }, [data]);
  const cell = sel ?? worstIdx;

  const maxAbs = useMemo(() => Math.max(1, ...(data?.grid.flat().map(Math.abs) ?? [1])), [data]);
  const sigma = useMemo(() => {
    const vals = (data?.byUnderlying ?? []).map((u) => u.sigma1dPct).filter((v): v is number => v != null);
    return vals.length ? Math.max(...vals) : null;
  }, [data]);

  const heat = (v: number) => {
    const a = Math.min(1, Math.abs(v) / maxAbs);
    return v === 0 ? undefined : { background: `rgba(${v > 0 ? "22,163,74" : "220,38,38"},${(0.08 + a * 0.5).toFixed(3)})` };
  };
  const shown = (v: number) => (showTotal && data ? data.current + v : v);

  const controls = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs">
      <div className="flex items-center gap-1.5">
        <span className="text-term-dim">Positions</span>
        <div className="seg">
          {(
            [
              ["paper", "Paper"],
              ["broker", "Live"],
              ["all", "Both"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={source === k ? "on" : ""} onClick={() => setSource(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-term-dim">After</span>
        <div className="seg">
          {DAYS.map(([v, l]) => (
            <button key={v} className={days === v ? "on" : ""} onClick={() => setDays(v)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-term-dim">Show</span>
        <div className="seg">
          <button className={!showTotal ? "on" : ""} onClick={() => setShowTotal(false)} title="P&L change from where you are now">
            Change
          </button>
          <button className={showTotal ? "on" : ""} onClick={() => setShowTotal(true)} title="Total P&L on the position, from entry">
            Total P&amp;L
          </button>
        </div>
      </div>
      <span className="ml-auto text-term-dim">{busy ? "updating…" : ""}</span>
    </div>
  );

  if (!data) {
    return (
      <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
        {controls}
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-[360px] rounded-lg border border-term-dim/70 bg-term-panel/95 px-4 py-3 text-center text-xs">
            {err ? (
              <>
                <div className="font-semibold text-down">Couldn't build the scenario grid</div>
                <div className="mt-1 break-words text-[10px] text-term-dim">{err}</div>
              </>
            ) : (
              <div className="flex items-center justify-center gap-2 text-term-text">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-term-dim/50 border-t-term-accent" />
                Repricing your positions…
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const empty = data.positions.length === 0;
  const selDelta = cell && data.positions.length ? data.grid[cell[0]][cell[1]] : 0;
  const ivRows = data.ivShifts.map((v, i) => [v, i] as const).reverse(); // higher IV on top
  const g = data.greeks;

  const ivCols = data.ivShifts.map((v, i) => [v, i] as const); // low IV left -> high IV right
  const gridCell = (i: number, j: number, dv: number, x: number, pad: string) => {
    const v = data.grid[i][j];
    const isSel = cell && cell[0] === i && cell[1] === j;
    const isNow = dv === 0 && x === 0;
    return (
      <td key={`${i}-${j}`} className="p-0">
        <button
          onClick={() => setSel([i, j])}
          style={heat(v)}
          className={`block w-full rounded text-term-text ${pad} ${
            isSel
              ? "outline outline-2 -outline-offset-1 outline-term-accent"
              : isNow
              ? "outline outline-1 -outline-offset-1 outline-term-dim"
              : ""
          }`}
          title={`${pctLabel(x)} spot, ${ivLabel(dv)}: ${rupee(v)} ${showTotal ? "in total" : "change"}`}
        >
          {short(shown(v))}
        </button>
      </td>
    );
  };
  const in1s = (x: number) => sigma != null && Math.abs(x) <= sigma && x !== 0;

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {controls}

      {empty ? (
        <div className="p-8 text-center text-xs text-term-dim">
          No open {source === "broker" ? "live" : source === "paper" ? "paper" : ""} positions to stress-test.
          {data.skipped.length > 0 && <div className="mt-1 text-[10px]">Not repriced: {data.skipped.join(", ")}</div>}
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-3">
          {(data.partial || data.errors.length > 0 || data.skipped.length > 0) && (
            <div className="rounded border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">
              {data.errors.length > 0 && (
                <div>
                  Left out of the grid (no option chain): {data.errors.map((e) => `${e.symbol} ${e.expiry}`).join(", ")}. Their
                  P&amp;L still counts in "now", but they don't move in the scenarios.
                </div>
              )}
              {data.skipped.length > 0 && <div>Not repriced (equity / unrecognised): {data.skipped.join(", ")}.</div>}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Stat label="P&L now" value={rupee(data.current)} cls={signColor(data.current)} />
            {data.worst && (
              <Stat
                label="Worst case in grid"
                value={rupee(showTotal ? data.current + data.worst.delta : data.worst.delta)}
                cls="text-down"
                sub={`${pctLabel(data.worst.spot)} · ${ivLabel(data.worst.iv)}`}
              />
            )}
            {data.best && (
              <Stat
                label="Best case in grid"
                value={rupee(showTotal ? data.current + data.best.delta : data.best.delta)}
                cls="text-up"
                sub={`${pctLabel(data.best.spot)} · ${ivLabel(data.best.iv)}`}
              />
            )}
            <Stat
              label="Net delta"
              value={nf(g.delta, 1)}
              cls={signColor(g.delta)}
              sub={`${rupee(g.deltaRs1pct)} per 1%`}
              title="Net position in units of the underlying, and the P&L for a 1% move (all underlyings together)"
            />
            <Stat label="Gamma" value={`${g.gamma >= 0 ? "+" : ""}${nf(g.gamma, 1)}`} cls={signColor(g.gamma)} sub="Δ change per 1%" title="How much your net delta (in units) changes for a 1% move" />
            <Stat label="Theta / day" value={rupee(g.theta)} cls={signColor(g.theta)} />
            <Stat label="Vega / vol pt" value={rupee(g.vega)} cls={signColor(g.vega)} />
          </div>

          {/* the grid */}
          <section className="min-w-0 rounded border border-term-border bg-term-bg/20 p-3">
            <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
              <h3 className="text-[11px] font-bold uppercase tracking-wide text-term-text">
                {showTotal ? "Total P&L" : "P&L change"} —{" "}
                {data.daysForward <= 0
                  ? "right now"
                  : data.nearestDte != null && Math.abs(data.daysForward - data.nearestDte) < 0.02
                  ? `at the nearest expiry (${nf(data.daysForward, 1)} days)`
                  : `${nf(data.daysForward, 1)} day${data.daysForward > 1 ? "s" : ""} from now`}
              </h3>
              <span className="text-[10px] text-term-dim">
                {narrow ? "Spot moves down the side, IV (vol points) across the top." : "Spot moves across, IV moves down."}{" "}
                Every underlying moves by the same %{sigma != null ? `; a 1σ one-day move is about ±${nf(sigma, 2)}%` : ""}.
              </span>
            </div>
            {narrow ? (
              // phone: on its side -- spot moves down the side, IV shifts across
              <table className="w-full table-fixed border-separate border-spacing-[2px] text-center text-[10px]">
                <thead>
                  <tr>
                    <th className="w-[42px] text-right text-[9px] font-medium text-term-dim">spot/IV</th>
                    {ivCols.map(([dv]) => (
                      <th key={dv} className="py-1 font-semibold text-term-dim">
                        {dv === 0 ? "±0" : `${sign(dv)}${Math.abs(dv)}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {data.spotShocks.map((x, j) => (
                    <tr key={x}>
                      <th
                        className={`rounded px-0.5 py-1 text-right font-semibold ${
                          in1s(x) ? "bg-term-accent/15 text-term-text" : "text-term-dim"
                        }`}
                        title={in1s(x) ? "Within a 1σ one-day move" : undefined}
                      >
                        {pctLabel(x)}
                      </th>
                      {ivCols.map(([dv, i]) => gridCell(i, j, dv, x, "px-0 py-1.5"))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0.5 text-center text-2xs">
                <thead>
                  <tr>
                    <th className="w-16 min-w-[56px]" />
                    {data.spotShocks.map((x) => (
                      <th
                        key={x}
                        className={`min-w-[58px] rounded px-1 py-1 font-semibold ${
                          in1s(x) ? "bg-term-accent/15 text-term-text" : "text-term-dim"
                        }`}
                        title={in1s(x) ? "Within a 1σ one-day move" : undefined}
                      >
                        {pctLabel(x)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="num">
                  {ivRows.map(([dv, i]) => (
                    <tr key={dv}>
                      <th className="px-1 py-1 text-right font-semibold text-term-dim">{ivLabel(dv)}</th>
                      {data.spotShocks.map((x, j) => gridCell(i, j, dv, x, "px-1 py-1.5"))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
            <p className="mt-1.5 text-[10px] text-term-dim">
              Each option is repriced with Black-Scholes using the IV that reproduces its current price, then IV is shifted in parallel.
              The outlined cell is the one shown in the table below — click any cell to inspect it.
            </p>
          </section>

          {/* by underlying */}
          {data.byUnderlying.length > 1 && (
            <section className="min-w-0 rounded border border-term-border bg-term-bg/20 p-3">
              <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-term-text">By underlying</h3>
              {narrow ? (
                <div className="flex flex-col gap-1.5 text-[11px] tabular-nums">
                  {data.byUnderlying.map((u) => (
                    <div key={u.symbol} className="rounded-md bg-term-bg/40 px-2.5 py-1.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-semibold text-term-text">
                          {u.symbol} <span className="font-normal text-term-dim">{u.spot != null ? nf(u.spot, 1) : "–"}</span>
                        </span>
                        <span className={signColor(u.pnl)}>{rupee(u.pnl)}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-term-dim">
                        <span>
                          Δ <span className={signColor(u.delta)}>{nf(u.delta, 1)}</span> ·{" "}
                          <span className={signColor(u.deltaRs1pct)}>{rupee(u.deltaRs1pct)}</span>/1%
                        </span>
                        <span>
                          Θ <span className={signColor(u.theta)}>{rupee(u.theta)}</span>/day
                        </span>
                        <span>
                          V <span className={signColor(u.vega)}>{rupee(u.vega)}</span>
                        </span>
                        <span>1σ {u.sigma1dPct != null ? `±${nf(u.sigma1dPct, 2)}%` : "–"}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-2xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase text-term-dim">
                      {["Underlying", "Spot", "P&L now", "Delta", "₹ per 1%", "Theta/day", "Vega", "1σ day"].map((h) => (
                        <th key={h} className="border-b border-term-border px-2 py-1 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="num">
                    {data.byUnderlying.map((u) => (
                      <tr key={u.symbol} className="border-b border-term-border/50">
                        <td className="px-2 py-1 font-semibold text-term-text">{u.symbol}</td>
                        <td className="px-2 py-1">{u.spot != null ? nf(u.spot, 1) : "–"}</td>
                        <td className={`px-2 py-1 ${signColor(u.pnl)}`}>{rupee(u.pnl)}</td>
                        <td className={`px-2 py-1 ${signColor(u.delta)}`}>{nf(u.delta, 1)}</td>
                        <td className={`px-2 py-1 ${signColor(u.deltaRs1pct)}`}>{rupee(u.deltaRs1pct)}</td>
                        <td className={`px-2 py-1 ${signColor(u.theta)}`}>{rupee(u.theta)}</td>
                        <td className={`px-2 py-1 ${signColor(u.vega)}`}>{rupee(u.vega)}</td>
                        <td className="px-2 py-1">{u.sigma1dPct != null ? `±${nf(u.sigma1dPct, 2)}%` : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )}
            </section>
          )}

          {/* legs in the selected scenario */}
          <section className="min-w-0 rounded border border-term-border bg-term-bg/20 p-3">
            <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
              <h3 className="text-[11px] font-bold uppercase tracking-wide text-term-text">Positions</h3>
              {cell && (
                <span className="text-[10px] text-term-dim">
                  Scenario: spot {pctLabel(data.spotShocks[cell[1]])}, {ivLabel(data.ivShifts[cell[0]])} ={" "}
                  <span className={`num font-semibold ${signColor(selDelta)}`}>{rupee(selDelta)}</span> change
                  {sel && (
                    <button className="ml-2 underline hover:text-term-text" onClick={() => setSel(null)}>
                      back to worst case
                    </button>
                  )}
                </span>
              )}
            </div>
            {narrow ? (
              <div className="flex flex-col gap-1.5 text-[11px] tabular-nums">
                {data.positions.map((p, i) => {
                  const d = p.grid && cell ? p.grid[cell[0]][cell[1]] : null;
                  return (
                    <div key={i} className="rounded-md bg-term-bg/40 px-2.5 py-1.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate font-semibold text-term-text">
                          {legName(p)}
                          {data.positions.some((q) => q.source !== p.source) && (
                            <span className="ml-1.5 rounded border border-term-dim/60 px-1 text-[9px] font-normal uppercase text-term-dim">
                              {p.source === "broker" ? "live" : "paper"}
                            </span>
                          )}
                          {!p.priced && <span className="ml-1.5 font-normal text-amber-400">unpriced</span>}
                        </span>
                        <span className="whitespace-nowrap text-term-dim">
                          scenario{" "}
                          <span className={`font-semibold ${d == null ? "" : signColor(d)}`}>{d != null ? rupee(d) : "–"}</span>
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-term-dim">
                        <span>
                          Qty <span className={signColor(p.qty)}>{nf(p.qty, 0)}</span> ({nf(p.lots, 1)}L)
                        </span>
                        <span>
                          Entry <span className="text-term-text">{nf(p.entry, 2)}</span>
                        </span>
                        <span>
                          LTP <span className="text-term-text">{nf(p.ltp, 2)}</span>
                        </span>
                        <span>IV {p.iv != null ? `${nf(p.iv, 1)}%` : "–"}</span>
                      </div>
                      <div className="flex flex-wrap gap-x-3 text-term-dim">
                        <span>
                          Δ <span className={signColor(p.delta)}>{p.delta != null ? nf(p.delta, 1) : "–"}</span>
                        </span>
                        <span>
                          Θ <span className={signColor(p.theta)}>{p.theta != null ? rupee(p.theta) : "–"}</span>/day
                        </span>
                        <span>
                          V <span className={signColor(p.vega)}>{p.vega != null ? rupee(p.vega) : "–"}</span>
                        </span>
                        <span>
                          now <span className={signColor(p.pnl)}>{rupee(p.pnl)}</span>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-2xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase text-term-dim">
                    {["Position", "Qty", "Entry", "LTP", "IV", "Delta", "Theta/day", "Vega", "P&L now", "In scenario"].map((h) => (
                      <th key={h} className="border-b border-term-border px-2 py-1 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="num">
                  {data.positions.map((p, i) => {
                    const d = p.grid && cell ? p.grid[cell[0]][cell[1]] : null;
                    return (
                      <tr key={i} className="border-b border-term-border/50">
                        <td className="px-2 py-1 text-term-text">
                          {legName(p)}
                          {data.positions.some((q) => q.source !== p.source) && (
                            <span className="ml-1.5 rounded border border-term-dim/60 px-1 text-[9px] uppercase text-term-dim">
                              {p.source === "broker" ? "live" : "paper"}
                            </span>
                          )}
                          {!p.priced && <span className="ml-1.5 text-amber-400" title="No option chain — not repriced">unpriced</span>}
                        </td>
                        <td className={`px-2 py-1 ${signColor(p.qty)}`}>
                          {nf(p.qty, 0)}
                          <span className="text-term-dim"> ({nf(p.lots, 1)}L)</span>
                        </td>
                        <td className="px-2 py-1">{nf(p.entry, 2)}</td>
                        <td className="px-2 py-1">{nf(p.ltp, 2)}</td>
                        <td className="px-2 py-1" title={p.ivSource ? `IV from the ${p.ivSource === "mark" ? "position's own price" : p.ivSource === "chain" ? "option chain" : "ATM IV"}` : undefined}>
                          {p.iv != null ? `${nf(p.iv, 1)}%` : "–"}
                        </td>
                        <td className={`px-2 py-1 ${signColor(p.delta)}`}>{p.delta != null ? nf(p.delta, 1) : "–"}</td>
                        <td className={`px-2 py-1 ${signColor(p.theta)}`}>{p.theta != null ? rupee(p.theta) : "–"}</td>
                        <td className={`px-2 py-1 ${signColor(p.vega)}`}>{p.vega != null ? rupee(p.vega) : "–"}</td>
                        <td className={`px-2 py-1 ${signColor(p.pnl)}`}>{rupee(p.pnl)}</td>
                        <td className={`px-2 py-1 font-semibold ${d == null ? "" : signColor(d)}`}>{d != null ? rupee(d) : "–"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
