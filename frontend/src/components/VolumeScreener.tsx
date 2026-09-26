import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { api, type VolRow, type VolSnapshot } from "../lib/api";
import { nf } from "../lib/format";
import { isViewer } from "../lib/auth";

type Mode = "spikes" | "volume" | "value" | "breakouts";
const MODES: [Mode, string][] = [
  ["spikes", "Volume spikes"],
  ["volume", "Most traded"],
  ["value", "Top value"],
  ["breakouts", "Breakouts"],
];
const SIGNAL: Record<string, { label: string; up: boolean }> = {
  PDH: { label: "▲ above yesterday's high", up: true },
  PDL: { label: "▼ below yesterday's low", up: false },
  HIGH: { label: "▲ at day high", up: true },
  LOW: { label: "▼ at day low", up: false },
};
/** 1,33,45,678 shares -> "1.33 Cr", 12,40,000 -> "12.4 L" */
const qty = (v: number) => (v >= 1e7 ? `${(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(1)} L` : nf(v, 0));
const crore = (v: number) => (v >= 1e9 ? `₹${nf(v / 1e7, 0)} Cr` : `₹${(v / 1e7).toFixed(1)} Cr`);

/** Stocks by traded volume: spikes vs their usual volume for this time of day, the most
 *  traded, the biggest value, and volume-backed breakouts -- F&O stocks or all of NSE. */
export function VolumeScreener() {
  const selectSymbol = useStore((s) => s.selectSymbol);
  const setView = useStore((s) => s.setView);
  const addWatch = useStore((s) => s.addWatch);
  const watch = useStore((s) => s.watch);
  const viewer = isViewer();

  const [universe, setUniverse] = useState<"fo" | "all">("fo");
  const [mode, setMode] = useState<Mode>("spikes");
  const [minCr, setMinCr] = useState(0);
  const [data, setData] = useState<VolSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  useEffect(() => setMinCr(universe === "all" ? 5 : 0), [universe]); // illiquid small caps swamp "all" otherwise

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.volumeScreener(universe).then(
        (d) => alive && (setData(d), setErr(null)),
        (e) => alive && setErr(String(e?.message || e))
      );
    load();
    const t = window.setInterval(() => !document.hidden && load(), 20_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [universe]);

  const rows = useMemo(() => {
    let r = (data?.rows ?? []).filter((x) => x.value >= minCr * 1e7);
    if (mode === "spikes") r = r.filter((x) => x.rvol != null).sort((a, b) => (b.rvol ?? 0) - (a.rvol ?? 0));
    else if (mode === "volume") r = [...r].sort((a, b) => b.vol - a.vol);
    else if (mode === "value") r = [...r].sort((a, b) => b.value - a.value);
    else r = r.filter((x) => x.signal).sort((a, b) => (b.rvol ?? 0) - (a.rvol ?? 0));
    return r.slice(0, 100);
  }, [data, mode, minCr]);

  const inWatch = useMemo(() => new Set(watch.map((w) => w.key)), [watch]);
  const wlKey = (r: VolRow) => (r.fo ? r.symbol : `EQ:${r.symbol}`);

  const openChart = (r: VolRow) => {
    selectSymbol(r.symbol, true);
    setView("chart");
  };

  const setAlert = (lvl: number) => {
    api.volumeScreenerConfig({ alertLevel: lvl }).then((c) => setData((d) => (d ? { ...d, cfg: c } : d)), (e) => alert(String(e?.message || e)));
  };

  const asOf = data?.asOf ? new Date(data.asOf * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;
  const base = data?.baseline;
  const seg = (on: boolean) =>
    `whitespace-nowrap px-2.5 py-1 text-[12px] font-semibold ${on ? "bg-term-accent/20 text-term-accent" : "text-term-dim"}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-term-bg">
      <div className="sticky top-0 z-10 space-y-2 border-b border-term-border bg-term-panel2 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-bold uppercase tracking-wide text-term-text">Volume</span>
          <div className="flex overflow-hidden rounded border border-term-border">
            <button onClick={() => setUniverse("fo")} className={seg(universe === "fo")}>
              F&amp;O stocks
            </button>
            <button onClick={() => setUniverse("all")} className={seg(universe === "all")}>
              All NSE
            </button>
          </div>
          <span className="ml-auto text-[11px] text-term-dim">
            {data?.market === "open" ? (asOf ? `live · ${asOf}` : "loading…") : asOf ? `market closed · last session` : ""}
          </span>
        </div>
        <div className="no-scrollbar flex gap-1 overflow-x-auto">
          {MODES.map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`whitespace-nowrap rounded-full border px-3 py-1 text-[12px] font-semibold ${
                mode === m ? "border-term-accent bg-term-accent/20 text-term-accent" : "border-term-border text-term-dim"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-term-dim">
          <span>Min traded</span>
          <div className="flex overflow-hidden rounded border border-term-border">
            {[0, 1, 5, 25].map((v) => (
              <button key={v} onClick={() => setMinCr(v)} className={seg(minCr === v)}>
                {v ? `₹${v} Cr` : "any"}
              </button>
            ))}
          </div>
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
        </div>
        {base && base.ready < base.total && (
          <div className="text-[11px] text-amber-400">
            Working out each stock's usual volume: {base.ready} / {base.total} ready
            {universe === "all" ? " — the first time for all NSE takes about 45 min" : ""}. Spikes fill in as they're done.
          </div>
        )}
      </div>

      {err && <div className="p-4 text-center text-[12px] text-down">{err}</div>}
      {!err && data && rows.length === 0 && (
        <div className="p-6 text-center text-[12px] text-term-dim">
          {data.rows.length === 0
            ? universe === "all"
              ? "Loading all NSE stocks — prices arrive in a minute or two."
              : "No quotes yet — they arrive within a minute."
            : mode === "breakouts"
            ? "No volume-backed breakouts right now."
            : "Nothing matches the filter."}
        </div>
      )}

      <div>
        {rows.map((r) => {
          const s = r.signal ? SIGNAL[r.signal] : null;
          const rv = r.rvol;
          const rvCls =
            rv == null
              ? "bg-term-border/60 text-term-dim"
              : rv >= 5
              ? "bg-amber-500 text-black"
              : rv >= 3
              ? "bg-amber-500/25 text-amber-300"
              : rv >= 2
              ? "bg-term-accent/20 text-term-accent"
              : "bg-term-border/60 text-term-dim";
          const key = wlKey(r);
          const has = inWatch.has(key) || added.has(key);
          return (
            <div key={r.symbol} className="flex items-stretch border-b border-term-border/60">
              <button onClick={() => openChart(r)} className="min-w-0 flex-1 px-3 py-2 text-left active:bg-term-border/40">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[14px] font-semibold text-term-text">{r.symbol}</span>
                  {!r.fo && <span className="rounded bg-term-border px-1 text-[9px] font-semibold text-term-dim">CASH</span>}
                  <span className="num ml-auto text-[14px] text-term-text">{nf(r.ltp)}</span>
                  {r.chgPct != null && (
                    <span className={`num w-14 text-right text-[12px] ${r.chgPct >= 0 ? "text-up" : "text-down"}`}>
                      {r.chgPct >= 0 ? "+" : ""}
                      {nf(r.chgPct)}%
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-term-dim">
                  <span className={`num rounded px-1.5 py-0.5 font-bold ${rvCls}`} title="vs its usual volume by this time of day">
                    {rv != null ? `${nf(rv, 1)}x usual` : "usual: …"}
                  </span>
                  <span className="num">Vol {qty(r.vol)}</span>
                  <span className="num">{crore(r.value)}</span>
                  {s && <span className={`font-semibold ${s.up ? "text-up" : "text-down"}`}>{s.label}</span>}
                </div>
                {r.name && <div className="mt-0.5 truncate text-[10px] text-term-dim/80">{r.name}</div>}
              </button>
              <button
                disabled={has}
                onClick={() => {
                  addWatch(key);
                  setAdded((a) => new Set(a).add(key));
                }}
                className="w-12 shrink-0 text-[18px] text-term-dim active:bg-term-border/40 disabled:text-amber-400"
                title={has ? "In your watchlist" : "Add to watchlist"}
              >
                {has ? "★" : "☆"}
              </button>
            </div>
          );
        })}
      </div>
      {rows.length > 0 && (
        <div className="px-3 py-3 text-[10px] leading-snug text-term-dim">
          "x usual" = today's volume vs the stock's average day (20 sessions), scaled to how much of a normal day's
          volume trades by this time — approximate. Breakouts need 1.5x+ volume. Tap a stock for its chart; ☆ adds it
          to the watchlist.
        </div>
      )}
    </div>
  );
}
