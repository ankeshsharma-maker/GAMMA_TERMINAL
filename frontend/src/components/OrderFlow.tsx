import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { ago, compact, nf, sk } from "../lib/format";
import type { FlowData } from "../types";

/** Order flow dashboard: cumulative delta (buy vs sell pressure) and volume profile (buy vs sell bars). */

const BUY_COLOR = "#4ade80";  // green
const SELL_COLOR = "#f87171"; // red
const NEUTRAL_COLOR = "#94a3b8"; // gray

const pctFmt = (v: number) => `${nf(v, 1)}%`;

const PROFILE_WINDOWS: [string, string][] = [
  ["5", "5 min"],
  ["15", "15 min"],
  ["60", "1 hour"],
];
type Lean = "BUYING" | "SELLING" | "BALANCED";
// anything between 45% and 55% buying is too close to call a side
const leanOf = (buy: number, sell: number): Lean | null => {
  const tot = buy + sell;
  if (tot <= 0) return null;
  const p = (buy / tot) * 100;
  return p >= 55 ? "BUYING" : p <= 45 ? "SELLING" : "BALANCED";
};
const LEAN_CLS: Record<Lean, string> = {
  BUYING: "bg-emerald-500/20 text-emerald-400",
  SELLING: "bg-red-500/20 text-red-400",
  BALANCED: "bg-term-border/40 text-term-dim",
};

const Bar = ({ label, pct, value, color }: { label: string; pct: number; value: number; color: string }) => (
  <div>
    <div className="flex items-baseline justify-between text-[10px]">
      <span className="text-term-dim">{label}</span>
      <span className="num font-semibold text-term-text">{nf(pct, 0)}%</span>
    </div>
    <div className="relative mt-0.5 h-2.5 rounded bg-term-border/40">
      <div className={`absolute inset-y-0 left-0 rounded ${color}`} style={{ width: `${pct}%` }} />
    </div>
    <div className="num text-[9px] text-term-dim">{compact(value)}</div>
  </div>
);

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

  // volume profile for 5 min / 15 min / 1 hour side by side -- independent of
  // the window dropdown, which still drives the cumulative-delta chart
  const [profiles, setProfiles] = useState<Record<string, FlowData | null>>({});
  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all(PROFILE_WINDOWS.map(([w]) => api.flow(symbol, expiry || undefined, w).catch(() => null))).then(
        (rs) => alive && setProfiles(Object.fromEntries(PROFILE_WINDOWS.map(([w], i) => [w, rs[i]])))
      );
    load();
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 60000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [symbol, expiry, tick]);

  const freshProfile = (w: string) => {
    const p = profiles[w];
    return p && p.symbol === symbol.toUpperCase() ? p : null;
  };
  const leans = PROFILE_WINDOWS.map(([w]) => {
    const p = freshProfile(w);
    return p && !p.warming ? leanOf(p.bull, p.bear) : null;
  });
  const [l5, , l60] = leans;
  const profileSummary =
    !l5 || !l60
      ? null
      : l5 !== "BALANCED" && leans.every((l) => l === l5)
      ? `All three windows ${l5.toLowerCase()} — the pressure is consistent.`
      : l5 !== "BALANCED" && l60 !== "BALANCED" && l5 !== l60
      ? `Last 5 min ${l5.toLowerCase()}, but the last hour is ${l60.toLowerCase()} — the short-term move runs against the hour's flow.`
      : null;

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
        <option value="60">1 hour ago</option>
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

        {/* Volume profile: 5 min / 15 min / 1 hour side by side */}
        <section className="min-w-0 rounded border border-term-border bg-term-bg/20 p-3">
          <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-term-dim">
            Volume Profile · 5 min / 15 min / 1 hour
          </h3>
          <div className="mb-3 text-[10px] text-term-dim">
            Buying = call buying + put writing · Selling = call writing + put buying, over each window
          </div>
          <div className="grid grid-cols-3 divide-x divide-term-border/60 rounded border border-term-border/60">
            {PROFILE_WINDOWS.map(([w, label], i) => {
              const p = freshProfile(w);
              const tot = p ? p.bull + p.bear : 0;
              const bp = p && tot ? (p.bull / tot) * 100 : 0;
              const lean = leans[i];
              return (
                <div key={w} className="min-w-0 space-y-1.5 p-2">
                  <div className="text-center text-[11px] font-semibold text-term-text">{label}</div>
                  {!p ? (
                    <div className="py-4 text-center text-[10px] text-term-dim">loading…</div>
                  ) : p.warming ? (
                    <div className="py-4 text-center text-[10px] text-term-dim">collecting… needs {p.warmupMin} min</div>
                  ) : !tot || !lean ? (
                    <div className="py-4 text-center text-[10px] text-term-dim">no flow yet</div>
                  ) : (
                    <>
                      <Bar label="Buy" pct={bp} value={p.bull} color="bg-emerald-500/80" />
                      <Bar label="Sell" pct={100 - bp} value={p.bear} color="bg-red-500/80" />
                      <div className={`rounded px-1 py-0.5 text-center text-[10px] font-bold ${LEAN_CLS[lean]}`}>
                        {lean}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {profileSummary && <div className="mt-2 text-[11px] text-term-text">→ {profileSummary}</div>}
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
