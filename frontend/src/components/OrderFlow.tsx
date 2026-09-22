import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { ago, nf, sk } from "../lib/format";
import type { FlowData } from "../types";

/** Order flow dashboard: cumulative delta (buy vs sell pressure) and volume profile (buy vs sell bars). */

const BUY_COLOR = "#4ade80";  // green
const SELL_COLOR = "#f87171"; // red
const NEUTRAL_COLOR = "#94a3b8"; // gray

const pctFmt = (v: number) => `${nf(v, 1)}%`;

export function OrderFlowView() {
  const symbol = useStore((s) => s.symbol);
  const expiry = useStore((s) => s.expiry);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const symClassOk = useStore((s) => s.symClassOk);
  const symClass = useStore((s) => s.symClass);

  const [data, setData] = useState<FlowData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [win, setWin] = useState("day");

  const [symChoices, setSymChoices] = useState<string[]>([]);
  useEffect(() => {
    api.symbols().then(
      (d) => setSymChoices([...new Set([...(d.indices ?? []), ...(d.fo ?? []), ...(d.defaults ?? [])])].sort()),
      () => {}
    );
  }, []);

  const symOptions = useMemo(
    () =>
      [...new Set([...symChoices, symbol])]
        .filter(Boolean)
        .filter((s) => s === symbol || symClassOk(s))
        .sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [symChoices, symbol, symClass]
  );

  useEffect(() => {
    let alive = true;
    setErr(null);
    const load = () => {
      setBusy(true);
      return api
        .flow(symbol, expiry || undefined, win)
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
    }, 60000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [symbol, expiry, win, tick]);

  // Calculate delta from flow series data
  const deltaData = useMemo(() => {
    if (!data?.series) return [];
    let cumulativeDelta = 0;
    return data.series.slice(-120).map((p) => {
      const delta = (p.cb ?? 0) + (p.pw ?? 0) - (p.cw ?? 0) - (p.pb ?? 0);
      cumulativeDelta += delta;
      return { time: p.t, delta: cumulativeDelta, label: new Date(p.t * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) };
    });
  }, [data]);

  // Calculate volume profile from latest point
  const volumeProfile = useMemo(() => {
    if (!data?.series || data.series.length === 0) return { buy: 0, sell: 0 };
    const latest = data.series[data.series.length - 1];
    const buyVol = (latest.cb ?? 0) + (latest.pw ?? 0);
    const sellVol = (latest.cw ?? 0) + (latest.pb ?? 0);
    return { buy: buyVol, sell: sellVol };
  }, [data]);

  const maxVol = Math.max(volumeProfile.buy, volumeProfile.sell) || 1;
  const totalVol = volumeProfile.buy + volumeProfile.sell || 1;
  const buyPct = (volumeProfile.buy / totalVol) * 100;

  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
      <span className="font-semibold uppercase tracking-wide">Order Flow</span>
      <select
        value={symbol}
        onChange={(e) => selectSymbol(e.target.value, false)}
        className="rounded border border-term-border bg-term-panel px-2 py-0.5 text-2xs text-term-text"
        title="Underlying"
      >
        {symOptions.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <select
        value={win}
        onChange={(e) => setWin(e.target.value)}
        className="rounded border border-term-border bg-term-panel px-2 py-0.5 text-2xs text-term-text"
        title="Time window"
      >
        <option value="5">5 min ago</option>
        <option value="15">15 min ago</option>
        <option value="30">30 min ago</option>
        <option value="day">Prev close</option>
      </select>
      <button className="btn !px-2 !py-0.5 !text-2xs" onClick={() => setTick((t) => t + 1)} disabled={busy}>
        <span className={busy ? "inline-block animate-spin" : ""}>⟳</span> Refresh
      </button>
      <span className="ml-auto">{data ? `updated ${ago(data.asOf)}` : ""}</span>
    </div>
  );

  if (!data) {
    return (
      <div className="flex flex-col min-[901px]:min-h-0 min-[901px]:flex-1">
        {toolbar}
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-[360px] rounded-lg border border-term-dim/70 bg-term-panel/95 px-4 py-3 text-center text-xs">
            {err ? (
              <>
                <div className="font-semibold text-down">Couldn't load order flow for {symbol}</div>
                <div className="mt-1 break-words text-[10px] text-term-dim">{err}</div>
                <button className="chipbtn mt-2 text-term-text" onClick={() => setTick((t) => t + 1)}>
                  Retry
                </button>
              </>
            ) : (
              <div className="flex items-center justify-center gap-2 text-term-text">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-term-dim/50 border-t-term-accent" />
                Loading order flow for {symbol}…
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-[901px]:min-h-0 min-[901px]:flex-1 min-[901px]:overflow-y-auto">
      {toolbar}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-3 lg:grid-cols-2">
        {/* Delta Flow Chart */}
        <section className="min-w-0 rounded border border-term-border bg-term-bg/20 p-3">
          <h3 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-term-dim">Cumulative Delta (Buy vs Sell Pressure)</h3>
          <div className="h-[240px] bg-term-panel rounded border border-term-border/40 p-2">
            {deltaData.length > 0 ? (
              <svg viewBox={`0 0 600 200`} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
                {/* Grid */}
                <line x1="0" y1="100" x2="600" y2="100" stroke="#475569" strokeWidth="1" strokeDasharray="2,2" />

                {/* Delta line */}
                {deltaData.length > 1 && (
                  <polyline
                    points={deltaData
                      .map((d, i) => {
                        const x = (i / (deltaData.length - 1)) * 600;
                        const y = 100 - (d.delta / Math.max(...deltaData.map((dd) => Math.abs(dd.delta)), 1)) * 80;
                        return `${x},${y}`;
                      })
                      .join(" ")}
                    fill="none"
                    stroke={deltaData[deltaData.length - 1].delta > 0 ? BUY_COLOR : SELL_COLOR}
                    strokeWidth="2"
                  />
                )}

                {/* Latest value */}
                {deltaData.length > 0 && (
                  <text
                    x="590"
                    y="20"
                    textAnchor="end"
                    className="text-[12px] font-bold"
                    fill={deltaData[deltaData.length - 1].delta > 0 ? BUY_COLOR : SELL_COLOR}
                  >
                    {nf(deltaData[deltaData.length - 1].delta, 0)}
                  </text>
                )}
              </svg>
            ) : (
              <div className="flex items-center justify-center h-full text-term-dim text-[11px]">No flow data yet</div>
            )}
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-term-dim">
            <span>🟢 Buying pressure (delta &gt; 0)</span>
            <span>🔴 Selling pressure (delta &lt; 0)</span>
          </div>
        </section>

        {/* Volume Profile */}
        <section className="min-w-0 rounded border border-term-border bg-term-bg/20 p-3">
          <h3 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-term-dim">Volume Profile (Latest)</h3>
          <div className="space-y-4">
            {/* Buy side */}
            <div>
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="text-[11px] text-term-dim">Buying</span>
                <span className="num text-sm font-semibold text-term-text">{nf(buyPct, 1)}%</span>
              </div>
              <div className="relative h-6 rounded bg-term-border/40">
                <div
                  className="absolute inset-y-0 left-0 rounded bg-emerald-500/80"
                  style={{ width: `${(volumeProfile.buy / maxVol) * 100}%` }}
                />
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-term-text">{volumeProfile.buy > 0 ? nf(volumeProfile.buy, 0) : "–"}</span>
              </div>
            </div>

            {/* Sell side */}
            <div>
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="text-[11px] text-term-dim">Selling</span>
                <span className="num text-sm font-semibold text-term-text">{nf(100 - buyPct, 1)}%</span>
              </div>
              <div className="relative h-6 rounded bg-term-border/40">
                <div
                  className="absolute inset-y-0 left-0 rounded bg-red-500/80"
                  style={{ width: `${(volumeProfile.sell / maxVol) * 100}%` }}
                />
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-term-text">{volumeProfile.sell > 0 ? nf(volumeProfile.sell, 0) : "–"}</span>
              </div>
            </div>

            {/* Summary */}
            <div className="rounded border border-term-border/60 bg-term-panel/50 px-2.5 py-2">
              <div className="text-[10px] text-term-dim space-y-0.5">
                <div className="flex justify-between">
                  <span>Total Volume:</span>
                  <span className="num font-semibold text-term-text">{nf(totalVol, 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Imbalance:</span>
                  <span className={`num font-semibold ${volumeProfile.buy > volumeProfile.sell ? "text-emerald-400" : "text-red-400"}`}>
                    {nf(Math.abs(buyPct - 50), 1)}% {volumeProfile.buy > volumeProfile.sell ? "BUYING" : "SELLING"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Status indicator */}
      {data.closed && (
        <div className="mx-3 mb-3 rounded border border-term-border/40 bg-term-accent/10 px-3 py-2 text-[11px] text-term-text">
          Order flow tracking ended at market close. Resumes 09:15 IST next trading day.
        </div>
      )}
    </div>
  );
}
