import { useEffect, useMemo, useState } from "react";
import type { VolRow } from "../lib/api";
import { nf } from "../lib/format";
import { Chips, MinTraded, ScanHeader, ScanTable, useStockScan, type Metric, type Universe } from "./StockScanTable";

type Mode = "gain" | "lose" | "hi" | "lo" | "gapup" | "gapdn";

const pct = (v: number) => `${v >= 0 ? "+" : ""}${nf(v)}%`;

/** Price movers (top gainers / losers), 52-week highs / lows and opening gaps, for the
 *  F&O stocks or all of NSE. */
export function StockScan() {
  const [universe, setUniverse] = useState<Universe>("fo");
  const [mode, setMode] = useState<Mode>("gain");
  const [minCr, setMinCr] = useState(0);
  const [near, setNear] = useState(2); // % from the 52-week high / low that still counts
  const [gapMin, setGapMin] = useState(1); // % gap
  const { data, err } = useStockScan(universe);
  useEffect(() => setMinCr(universe !== "fo" ? 5 : 0), [universe]);

  const rows = useMemo(() => {
    const r = (data?.rows ?? []).filter((x) => x.value >= minCr * 1e7);
    if (mode === "gain") return r.filter((x) => x.chgPct != null && x.chgPct > 0);
    if (mode === "lose") return r.filter((x) => x.chgPct != null && x.chgPct < 0);
    if (mode === "hi") return r.filter((x) => x.new52h || (x.fromHighPct != null && x.fromHighPct >= -near));
    if (mode === "lo") return r.filter((x) => x.new52l || (x.fromLowPct != null && x.fromLowPct <= near));
    if (mode === "gapup") return r.filter((x) => x.gapPct != null && x.gapPct >= gapMin);
    return r.filter((x) => x.gapPct != null && x.gapPct <= -gapMin);
  }, [data, mode, minCr, near, gapMin]);

  // new highs / lows sort first: they get a large sort value
  const metric: Metric =
    mode === "gain" || mode === "lose"
      ? {
          // the move's volume: a big % on thin trading means less than one on heavy trading
          label: "x usual",
          cell: (r: VolRow) =>
            r.rvol == null ? (
              <span className="text-term-dim">…</span>
            ) : (
              <span className={r.rvol >= 3 ? "font-bold text-amber-400" : r.rvol >= 2 ? "text-term-accent" : "text-term-dim"}>
                {nf(r.rvol, 1)}x
              </span>
            ),
          sort: (r) => r.rvol,
        }
      : mode === "hi"
      ? {
          label: "vs 52W H",
          cell: (r: VolRow) =>
            r.new52h ? <span className="font-bold text-up">NEW</span> : <span className="text-term-text">{pct(r.fromHighPct ?? 0)}</span>,
          sort: (r) => (r.new52h ? 100 : r.fromHighPct),
        }
      : mode === "lo"
      ? {
          label: "vs 52W L",
          cell: (r: VolRow) =>
            r.new52l ? <span className="font-bold text-down">NEW</span> : <span className="text-term-text">{pct(r.fromLowPct ?? 0)}</span>,
          sort: (r) => (r.new52l ? -100 : r.fromLowPct),
        }
      : {
          label: "Gap",
          cell: (r: VolRow) => (
            <span className={(r.gapPct ?? 0) >= 0 ? "text-up" : "text-down"}>
              {pct(r.gapPct ?? 0)}
              {r.gapFilled && <span className="ml-0.5 text-[8px] text-term-dim">F</span>}
            </span>
          ),
          sort: (r) => r.gapPct,
        };

  const empty =
    !data || data.rows.length === 0
      ? universe !== "fo"
        ? "Loading all NSE stocks — prices arrive in a minute or two."
        : "No quotes yet — they arrive within a minute."
      : mode === "gain"
      ? "No gainers right now."
      : mode === "lose"
      ? "No losers right now."
      : mode === "hi"
      ? `No stock within ${near}% of its 52-week high.`
      : mode === "lo"
      ? `No stock within ${near}% of its 52-week low.`
      : `No gap of ${gapMin}% or more today.`;
  const base = data?.baseline;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-term-bg">
      <div className="space-y-2 border-b border-term-border bg-term-panel2 px-3 py-2">
        <ScanHeader title="Movers" universe={universe} setUniverse={setUniverse} data={data} />
        <Chips<Mode>
          items={[
            ["gain", "Top gainers"],
            ["lose", "Top losers"],
            ["hi", "52W high"],
            ["lo", "52W low"],
            ["gapup", "Gap up"],
            ["gapdn", "Gap down"],
          ]}
          value={mode}
          onChange={setMode}
        />
        <MinTraded value={minCr} onChange={setMinCr} />
        {mode === "gain" || mode === "lose" ? null : mode === "hi" || mode === "lo" ? (
          <div className="flex items-center gap-2 text-[11px] text-term-dim">
            <span>Within</span>
            <Chips<number>
              items={[
                [0, "new only"],
                [1, "1%"],
                [2, "2%"],
                [5, "5%"],
              ]}
              value={near}
              onChange={setNear}
            />
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[11px] text-term-dim">
            <span>Gap of at least</span>
            <Chips<number>
              items={[
                [0.5, "0.5%"],
                [1, "1%"],
                [2, "2%"],
                [3, "3%"],
              ]}
              value={gapMin}
              onChange={setGapMin}
            />
          </div>
        )}
        {base && base.ready < base.total && (
          <div className="text-[11px] text-amber-400">
            Loading each stock's 52-week range: {base.ready} / {base.total} ready
            {universe !== "fo" ? " — the first time for all NSE takes about 45 min" : ""}.
          </div>
        )}
      </div>

      {err ? (
        <div className="p-4 text-center text-[12px] text-down">{err}</div>
      ) : !data ? (
        <div className="p-6 text-center text-[12px] text-term-dim">Loading…</div>
      ) : (
        <ScanTable
          rows={rows}
          metric={metric}
          sort={
            mode === "gain" || mode === "lose"
              ? { key: "chg", dir: mode === "gain" ? -1 : 1 }
              : { key: "metric", dir: mode === "lo" || mode === "gapdn" ? 1 : -1 }
          }
          empty={empty}
        />
      )}
      <div className="px-3 py-3 text-[10px] leading-snug text-term-dim">
        Gainers / losers = % change vs yesterday's close, with the move's volume vs usual beside it. 52W = the last 52 weeks of sessions before today; NEW = today's range went past it. Gap = today's open vs
        yesterday's close; F = filled (price has traded back to yesterday's close). Tap a header to sort, a stock for its
        chart; ☆ adds it to the watchlist.
      </div>
    </div>
  );
}
