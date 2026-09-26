import { useEffect, useMemo, useState } from "react";
import { api, type VolRow } from "../lib/api";
import { nf } from "../lib/format";
import { isViewer } from "../lib/auth";
import { Chips, MinTraded, ScanHeader, ScanTable, useStockScan, type Metric, type Universe } from "./StockScanTable";

type Mode = "spikes" | "volume" | "value" | "breakouts";
const SIGNAL: Record<string, { label: string; up: boolean; title: string }> = {
  PDH: { label: "▲PDH", up: true, title: "above yesterday's high" },
  PDL: { label: "▼PDL", up: false, title: "below yesterday's low" },
  HIGH: { label: "▲HI", up: true, title: "at the day's high" },
  LOW: { label: "▼LO", up: false, title: "at the day's low" },
};

const rvolCell = (r: VolRow) => {
  const v = r.rvol;
  if (v == null) return <span className="text-term-dim">…</span>;
  const cls = v >= 5 ? "font-bold text-amber-300" : v >= 3 ? "font-bold text-amber-400" : v >= 2 ? "text-term-accent" : "text-term-dim";
  return <span className={cls}>{nf(v, 1)}x</span>;
};
const RVOL: Metric = { label: "x usual", cell: rvolCell, sort: (r) => r.rvol };

/** Stocks by traded volume: spikes vs their usual volume for this time of day, the most
 *  traded, the biggest value, and volume-backed breakouts -- F&O stocks or all of NSE. */
export function VolumeScreener() {
  const viewer = isViewer();
  const [universe, setUniverse] = useState<Universe>("fo");
  const [mode, setMode] = useState<Mode>("spikes");
  const [minCr, setMinCr] = useState(0);
  const { data, setData, err } = useStockScan(universe);
  useEffect(() => setMinCr(universe !== "fo" ? 5 : 0), [universe]); // illiquid small caps swamp "all" otherwise

  const rows = useMemo(() => {
    const r = (data?.rows ?? []).filter((x) => x.value >= minCr * 1e7);
    if (mode === "spikes") return r.filter((x) => x.rvol != null);
    if (mode === "breakouts") return r.filter((x) => x.signal);
    return r;
  }, [data, mode, minCr]);

  const setAlert = (lvl: number) =>
    api.volumeScreenerConfig({ alertLevel: lvl }).then(
      (c) => setData((d) => (d ? { ...d, cfg: c } : d)),
      (e) => alert(String(e?.message || e))
    );
  const base = data?.baseline;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-term-bg">
      <div className="space-y-2 border-b border-term-border bg-term-panel2 px-3 py-2">
        <ScanHeader title="Volume" universe={universe} setUniverse={setUniverse} data={data} />
        <Chips<Mode>
          items={[
            ["spikes", "Volume spikes"],
            ["volume", "Most traded"],
            ["value", "Top value"],
            ["breakouts", "Breakouts"],
          ]}
          value={mode}
          onChange={setMode}
        />
        <MinTraded value={minCr} onChange={setMinCr}>
          {!viewer && data && (
            <span className="ml-auto flex items-center gap-1">
              🔔
              <select
                id="vol-alert-level"
                value={data.cfg.alertLevel}
                onChange={(e) => setAlert(Number(e.target.value))}
                className="rounded border border-term-border bg-term-bg px-1 py-0.5 text-[11px] text-term-text"
                title="Alert (app + Telegram) when a stock crosses this many times its usual volume"
              >
                <option value={0}>alerts off</option>
                <option value={2}>alert at 2x</option>
                <option value={3}>alert at 3x</option>
                <option value={5}>alert at 5x</option>
              </select>
            </span>
          )}
        </MinTraded>
        {base && base.ready < base.total && (
          <div className="text-[11px] text-amber-400">
            Working out each stock's usual volume: {base.ready} / {base.total} ready
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
          metric={RVOL}
          sort={
            mode === "volume"
              ? { key: "vol", dir: -1 }
              : mode === "value"
              ? { key: "value", dir: -1 }
              : { key: "metric", dir: -1 }
          }
          tag={(r) =>
            r.signal ? (
              <span title={SIGNAL[r.signal].title} className={`shrink-0 text-[9px] font-bold ${SIGNAL[r.signal].up ? "text-up" : "text-down"}`}>
                {SIGNAL[r.signal].label}
              </span>
            ) : null
          }
          empty={
            data.rows.length === 0
              ? universe !== "fo"
                ? "Loading all NSE stocks — prices arrive in a minute or two."
                : "No quotes yet — they arrive within a minute."
              : mode === "breakouts"
              ? "No volume-backed breakouts right now."
              : "Nothing matches the filter."
          }
        />
      )}
      <div className="px-3 py-3 text-[10px] leading-snug text-term-dim">
        "x usual" = today's volume vs the stock's average day (20 sessions), scaled to how much of a normal day trades by
        this time — approximate. Breakouts need 1.5x+ volume: ▲PDH / ▼PDL = past yesterday's high / low, ▲HI / ▼LO = at
        today's high / low. Dir = who has been in control TODAY: ▲ Buy = above the day's average traded price (VWAP) and high in
        the day's range, ▼ Sell = the opposite, ◆ = mixed — an estimate, and about today's session (a stock down on
        the day can still be ▲ Buy if it recovered). SYMBOL stays put when the table is swiped sideways. Tap a header to sort, a stock for its chart; ☆ adds it to the watchlist.
      </div>
    </div>
  );
}
