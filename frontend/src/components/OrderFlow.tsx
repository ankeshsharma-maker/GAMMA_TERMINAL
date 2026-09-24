import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { ago, compact, nf } from "../lib/format";
import { istTime } from "../lib/istTime";
import type { FlowData } from "../types";

/** Order flow dashboard: buy vs sell pressure over time and the volume profile,
 *  each compared across the 5 min / 15 min / 1 hour windows. */

const PROFILE_WINDOWS: [string, string][] = [
  ["5", "5 min"],
  ["15", "15 min"],
  ["60", "1 hour"],
];
type Pt = { t: number; v: number };

/** Net flow per sample: buying (put writing + call buying) minus selling (call
 *  writing + put buying), in contracts. Each series point already holds the flow
 *  over its whole window, so it is plotted as-is -- summing points would count the
 *  same flow once per minute it stays inside the window. (Plotting the buying
 *  SHARE instead pinned the 15 min / 1 hour rows at 0% on a one-way day -- every
 *  put up, every call down -- so they looked frozen while the flow kept moving.) */
const netSeries = (d: FlowData | null): Pt[] =>
  (d?.series ?? []).map((p) => ({
    t: p.t,
    v: (p.pw ?? 0) + (p.cb ?? 0) - (p.cw ?? 0) - (p.pb ?? 0),
  }));

function PressureChart({ lines }: { lines: { w: string; label: string; pts: Pt[] }[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [wd, setWd] = useState(560);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const set = () => setWd(Math.max(260, Math.round(el.clientWidth)));
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const all = lines.flatMap((l) => l.pts);
  return (
    <div ref={box}>
      {all.length < 2 ? (
        <div className="flex h-[196px] items-center justify-center text-[11px] text-term-dim">
          Collecting flow… the rows fill in as the market is sampled (once a minute).
        </div>
      ) : (
        <PressureSvg lines={lines} all={all} wd={wd} />
      )}
    </div>
  );
}

const UP = "#22c55e";
const DOWN = "#ef4444";

/** One row per window on a shared time axis (not three lines crossing each
 *  other): fill is green above the 50% midline (more buying) and red below it
 *  (more selling), so each row reads on its own. */
function PressureSvg({ lines, all, wd }: { lines: { w: string; label: string; pts: Pt[] }[]; all: Pt[]; wd: number }) {
  const id = useId().replace(/:/g, "");
  const rowH = 54;
  const gap = 8;
  const axisH = 18;
  const H = lines.length * rowH + (lines.length - 1) * gap + axisH;
  const m = { l: 44, r: 58 };
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  const x = (t: number) => m.l + ((t - t0) / (t1 - t0 || 1)) * (wd - m.l - m.r);
  const span = (t1 - t0) / 60;
  const step = (span <= 100 ? 15 : span <= 200 ? 30 : 60) * 60;
  const xt: number[] = [];
  for (let t = Math.ceil((t0 + 19800) / step) * step - 19800; t <= t1; t += step) xt.push(t);
  const plotBottom = H - axisH;

  return (
    <svg width={wd} height={H} className="block" role="img" aria-label="Net buying minus selling over time: one row each for the 5 min, 15 min and 1 hour windows">
      {xt.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={0} y2={plotBottom} stroke="currentColor" strokeOpacity={0.07} className="text-term-dim" />
          <text x={x(t)} y={H - 5} textAnchor="middle" fontSize={10} fill="currentColor" className="text-term-dim">
            {istTime(t)}
          </text>
        </g>
      ))}
      {lines.map((l, r) => {
        const top = r * (rowH + gap);
        // each row on its own scale: the 1 hour window carries far more
        // contracts than the 5 min one, and a shared scale would flatten it
        const rowMax = Math.max(1, ...l.pts.map((p) => Math.abs(p.v)));
        const mid = top + rowH / 2;
        const y = (v: number) => mid - (v / rowMax) * (rowH / 2 - 2);
        // one closed area per unbroken run of samples; gaps (closed market, missed
        // samples) stay empty instead of being bridged
        const runs: Pt[][] = [];
        l.pts.forEach((p, i) => {
          if (!i || p.t - l.pts[i - 1].t > 300) runs.push([]);
          runs[runs.length - 1].push(p);
        });
        const area = runs
          .map((run) => `M${x(run[0].t).toFixed(1)},${mid}` + run.map((p) => `L${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("") + `L${x(run[run.length - 1].t).toFixed(1)},${mid}Z`)
          .join("");
        const last = l.pts[l.pts.length - 1];
        return (
          <g key={l.w}>
            <defs>
              <clipPath id={`${id}u${r}`}>
                <rect x={m.l} y={top} width={wd - m.l - m.r} height={mid - top} />
              </clipPath>
              <clipPath id={`${id}d${r}`}>
                <rect x={m.l} y={mid} width={wd - m.l - m.r} height={top + rowH - mid} />
              </clipPath>
            </defs>
            <rect x={m.l} y={top} width={wd - m.l - m.r} height={rowH} fill="currentColor" opacity={0.03} className="text-term-text" />
            <path d={area} fill={UP} fillOpacity={0.55} clipPath={`url(#${id}u${r})`} />
            <path d={area} fill={DOWN} fillOpacity={0.55} clipPath={`url(#${id}d${r})`} />
            <line x1={m.l} x2={wd - m.r} y1={mid} y2={mid} stroke="currentColor" strokeOpacity={0.35} strokeDasharray="3 3" className="text-term-dim" />
            <text x={m.l - 6} y={mid + 3} textAnchor="end" fontSize={10} fontWeight={600} fill="currentColor" className="text-term-text">
              {l.label}
            </text>
            {last && (
              <text
                x={wd - m.r + 5}
                y={mid + 3}
                fontSize={11}
                fontWeight={700}
                fill={last.v > 0 ? UP : last.v < 0 ? DOWN : "currentColor"}
                className={last.v === 0 ? "text-term-dim" : undefined}
              >
                {last.v > 0 ? "+" : last.v < 0 ? "−" : ""}
                {compact(Math.abs(last.v))}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
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

  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);

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

  // the 5 min / 15 min / 1 hour windows feed both the pressure chart and the
  // volume profile, so the page compares them instead of one window at a time
  const [profiles, setProfiles] = useState<Record<string, FlowData | null>>({});
  useEffect(() => {
    let alive = true;
    setErr(null);
    const load = () => {
      setBusy(true);
      let firstErr: string | null = null;
      return Promise.all(
        PROFILE_WINDOWS.map(([w]) =>
          api.flow(symbol, expiry || undefined, w).catch((e) => {
            firstErr ??= String(e?.message ?? e);
            return null;
          })
        )
      )
        .then((rs) => {
          if (!alive) return;
          setProfiles(Object.fromEntries(PROFILE_WINDOWS.map(([w], i) => [w, rs[i]])));
          setErr(rs.every((r) => r == null) ? firstErr : null);
        })
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
  }, [symbol, expiry, tick]);

  const freshProfile = (w: string) => {
    const p = profiles[w];
    return p && p.symbol === symbol.toUpperCase() ? p : null;
  };
  const base = freshProfile("15") ?? freshProfile("5") ?? freshProfile("60");
  const lines = useMemo(
    () => PROFILE_WINDOWS.map(([w, label]) => ({ w, label, pts: netSeries(freshProfile(w)) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profiles, symbol]
  );
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
      <span>5 min · 15 min · 1 hour</span>
      <button className="btn !px-2 !py-0.5 !text-2xs" onClick={() => setTick((t) => t + 1)} disabled={busy}>
        <span className={busy ? "inline-block animate-spin" : ""}>⟳</span> Refresh
      </button>
      <span className="ml-auto">{base?.asOf ? `updated ${ago(base.asOf)}` : ""}</span>
    </div>
  );

  if (!base) {
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
        {/* Buy vs sell pressure over time: 5 min / 15 min / 1 hour */}
        <section className="min-w-0 rounded border border-term-border bg-term-bg/20 p-3">
          <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-term-dim">
            Buy vs Sell Pressure · 5 min / 15 min / 1 hour
          </h3>
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-term-dim">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#22c55e]/60" /> above the line = more buying
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#ef4444]/60" /> below = more selling
            </span>
          </div>
          <div className="rounded border border-term-border/40 bg-term-panel p-1">
            <PressureChart lines={lines} />
          </div>
          <div className="mt-2 text-[10px] leading-snug text-term-dim">
            Each row is one window, read on its own and scaled to its own range: the line is net flow (buying − selling,
            in contracts) and the figure on the right is where it stands now. Buying = call buying + put writing; selling =
            call writing + put buying. The 5 min row flips first; the 1 hour row shows the bigger picture.
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
      {base.closed && (
        <div className="mx-3 mb-3 rounded border border-term-border/40 bg-term-accent/10 px-3 py-2 text-[11px] text-term-text">
          Order flow tracking ended at market close. Resumes 09:15 IST next trading day.
        </div>
      )}
    </div>
  );
}
