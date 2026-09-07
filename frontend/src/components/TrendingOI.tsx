import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, compact } from "../lib/format";

type Pt = {
  t: number;
  spot: number;
  pcr: number | null;
  ce: number; // cumulative Call ΔOI since day open
  pe: number; // cumulative Put ΔOI since day open
  cVol: number;
  pVol: number;
};

const CE = "#f87171";
const PE = "#4ade80";
const PCRC = "#eab308";

const inr = (v: number) => nf(Math.round(v), 0);
const sInr = (v: number) => (v >= 0 ? "+" : "") + inr(v);
const sentCls = (s: string) =>
  s === "Bullish" ? "text-up" : s === "Bearish" ? "text-down" : "text-term-dim";

/**
 * Trending OI Live — selected-strike Call vs Put ΔOI pressure over the
 * session, bucketed to a 1 / 3 / 5 / 15-minute cadence, with a summary
 * band (bias, OI pressure, PCR / COI-PCR / Vol-PCR, direction change) and
 * a per-bucket data table. Optional ΔOI trend chart on top.
 */
export function TrendingOI() {
  const symbol = useStore((s) => s.symbol);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const chain = useStore((s) => s.chain);
  const selectExpiry = useStore((s) => s.selectExpiry);
  const symClass = useStore((s) => s.symClass);
  const symClassOk = useStore((s) => s.symClassOk);
  const liveSpots = useStore((s) => s.liveSpots);

  const [symChoices, setSymChoices] = useState<string[]>([]);
  const [pts, setPts] = useState<Pt[]>([]);
  const [tf, setTf] = useState(5); // bucket minutes; >=1440 = daily view
  const [showChart, setShowChart] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    api.symbols().then(
      (d) =>
        setSymChoices(
          [...new Set([...(d.indices ?? []), ...(d.fo ?? []), ...(d.defaults ?? [])])].sort()
        ),
      () => {}
    );
  }, []);
  const symOptions = useMemo(
    () =>
      [...new Set([...symChoices, symbol])]
        .filter(Boolean)
        .filter((s) => s === symbol || symClassOk(s))
        .sort(),
    [symChoices, symbol, symClass]
  );

  const expiry = chain?.expiry ?? "";
  const daily = tf >= 1440;

  useEffect(() => {
    let alive = true;

    const loadSession = () =>
      api.history(symbol).then((d) => {
        if (!alive) return;
        const raw = d.points
          .filter((p) => p.ceOIChg != null || p.peOIChg != null)
          .map((p) => ({
            t: p.t,
            spot: p.spot,
            pcr: p.pcr,
            ce: p.ceOIChg ?? 0,
            pe: p.peOIChg ?? 0,
            cVol: Number(p.ceVol ?? 0),
            pVol: Number(p.peVol ?? 0),
          }));
        const cut = raw.length ? raw[raw.length - 1].t - 10 * 3600 : 0;
        setPts(raw.filter((p) => p.t >= cut));
      }, () => {});

    const loadDaily = () => {
      if (!expiry) {
        setPts([]);
        return;
      }
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
      api.upstoxHistoryChain(symbol, expiry, from, to).then((d) => {
        if (!alive) return;
        const s = (d.series as any[]) ?? [];
        const ce0 = s.length ? Number(s[0].ceOI || 0) : 0;
        const pe0 = s.length ? Number(s[0].peOI || 0) : 0;
        setPts(
          s.map((r) => ({
            t: Math.floor(new Date(r.date + "T00:00:00Z").getTime() / 1000),
            spot: Number(r.spot ?? 0),
            pcr: r.pcr ?? null,
            ce: Number(r.ceOI || 0) - ce0,
            pe: Number(r.peOI || 0) - pe0,
            cVol: 0,
            pVol: 0,
          }))
        );
      }, () => setPts([]));
    };

    const load = daily ? loadDaily : loadSession;
    load();
    const id = window.setInterval(load, daily ? 60000 : 15000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [symbol, daily, expiry]);

  // ---- bucket the session into tf-wide windows and derive every column ----
  const rows = useMemo(() => {
    if (pts.length < 2) return [];
    const w = daily ? 86400 : tf * 60;
    const buckets: Pt[] = [];
    let key = -1;
    for (const p of pts) {
      const k = Math.floor(p.t / w);
      if (k !== key) {
        buckets.push(p);
        key = k;
      } else {
        buckets[buckets.length - 1] = p;
      }
    }
    const out: {
      t: number;
      spot: number;
      cCum: number;
      pCum: number;
      cInt: number;
      pInt: number;
      diff: number;
      diffPct: number;
      dirUp: boolean;
      chngInDir: number;
      pcr: number | null;
      coiPcr: number | null;
      volPcr: number | null;
      sentiment: string;
    }[] = [];
    for (let i = 1; i < buckets.length; i++) {
      const a = buckets[i - 1];
      const b = buckets[i];
      const cInt = b.ce - a.ce;
      const pInt = b.pe - a.pe;
      const diff = b.pe - b.ce;
      const diffPrev = a.pe - a.ce;
      const denom = Math.abs(b.ce) + Math.abs(b.pe) || 1;
      const diffPct = Math.max(-100, Math.min(100, (diff / denom) * 100));
      const sentiment = diff > denom * 0.02 ? "Bullish" : diff < -denom * 0.02 ? "Bearish" : "Neutral";
      out.push({
        t: b.t,
        spot: b.spot,
        cCum: b.ce,
        pCum: b.pe,
        cInt,
        pInt,
        diff,
        diffPct,
        dirUp: b.spot - a.spot >= 0,
        chngInDir: diff - diffPrev,
        pcr: b.pcr,
        coiPcr: cInt !== 0 ? pInt / cInt : null,
        volPcr: b.cVol ? b.pVol / b.cVol : null,
        sentiment,
      });
    }
    return out.reverse().slice(0, 40);
  }, [pts, tf, daily]);

  const L = rows[0]; // latest bucket
  const P = rows[1]; // previous bucket
  const fmtTime = (t: number) =>
    daily
      ? new Date(t * 1000).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
      : new Date(t * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

  // ---- optional ΔOI trend chart ----
  const chart = useMemo(() => {
    if (!showChart || pts.length < 2) return null;
    const W = 1000;
    const H = 260;
    const pad = { l: 52, r: 52, t: 12, b: 22 };
    const ts = pts.map((p) => p.t);
    const t0 = ts[0];
    const t1 = ts[ts.length - 1] || t0 + 1;
    const vals = pts.flatMap((p) => [p.ce, p.pe, 0]);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const gy = (hi - lo) * 0.12 || 1;
    lo -= gy;
    hi += gy;
    const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
    const line = (sel: (p: Pt) => number) =>
      pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(sel(p)).toFixed(1)}`).join(" ");
    const y0 = y(0);
    return (
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        {[hi, (hi + lo) / 2, 0, lo].map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity={Math.abs(v) < 1e-6 ? 0.5 : 0.12} className="text-term-dim" />
            <text x={6} y={y(v) + 3} fontSize={10} className="fill-term-dim">{compact(v)}</text>
          </g>
        ))}
        {[t0, (t0 + t1) / 2, t1].map((t, i) => (
          <text key={i} x={x(t)} y={H - 6} fontSize={10} textAnchor="middle" className="fill-term-dim">{fmtTime(t)}</text>
        ))}
        <path d={`${line((p) => p.ce)} L${x(t1)},${y0} L${x(t0)},${y0} Z`} fill={CE} fillOpacity={0.1} />
        <path d={`${line((p) => p.pe)} L${x(t1)},${y0} L${x(t0)},${y0} Z`} fill={PE} fillOpacity={0.1} />
        <path d={line((p) => p.ce)} fill="none" stroke={CE} strokeWidth={2} />
        <path d={line((p) => p.pe)} fill="none" stroke={PE} strokeWidth={2} />
        <path d={pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${(pad.t + (1 - ((p.pcr ?? 1) - 0.6) / 1.0) * (H - pad.t - pad.b)).toFixed(1)}`).join(" ")} fill="none" stroke={PCRC} strokeWidth={1.25} strokeOpacity={0.8} />
      </svg>
    );
  }, [showChart, pts, daily]);

  const live = chain ? liveSpots[chain.symbol] : undefined;
  const spot = live?.ltp ?? chain?.spot ?? 0;
  const spotChg = live?.chgPct ?? null;

  const Card = ({
    label,
    value,
    valueCls = "",
    sub,
  }: {
    label: string;
    value: React.ReactNode;
    valueCls?: string;
    sub?: React.ReactNode;
  }) => (
    <div className="min-w-[150px] flex-1 rounded-lg border border-term-border bg-term-bg/40 px-3 py-2">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-term-dim">{label}</div>
      <div className={`num text-base font-bold ${valueCls}`}>{value}</div>
      {sub != null && <div className="mt-0.5 text-[10px] text-term-dim">{sub}</div>}
    </div>
  );

  const TF: [string, number][] = [
    ["1 Min", 1],
    ["3 Min", 3],
    ["5 Min", 5],
    ["15 Min", 15],
    ["1D", 1440],
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel2 px-3 py-2 text-2xs">
        <span className="text-sm font-semibold">{symbol} Trending OI Live</span>
        <select
          value={symbol}
          onChange={(e) => selectSymbol(e.target.value, true)}
          className="rounded border border-term-border bg-term-bg px-1 py-0.5 font-semibold text-term-text outline-none focus:border-term-accent"
        >
          {symOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {chain?.expiries?.length ? (
          <select
            value={expiry}
            onChange={(e) => selectExpiry(e.target.value)}
            className="num rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text outline-none focus:border-term-accent"
          >
            {chain.expiries.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        ) : null}
        <span className="num text-term-dim">
          Spot <span className="text-term-text">{nf(spot, 1)}</span>
          {spotChg != null && (
            <span className={spotChg >= 0 ? "text-up" : "text-down"}>
              {" "}
              ({spotChg >= 0 ? "+" : ""}
              {nf(spotChg, 2)}%)
            </span>
          )}
        </span>
        <span className="ml-auto text-term-dim">
          Refreshed {new Date(now).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
        </span>
        <button
          onClick={() => setShowChart((v) => !v)}
          className={`rounded border px-2 py-0.5 font-semibold ${
            showChart ? "border-term-accent bg-term-accent text-white" : "border-term-border text-term-dim"
          }`}
        >
          {showChart ? "Hide chart" : "Show chart"}
        </button>
      </div>

      {/* summary band */}
      <div className="border-b border-term-border bg-term-panel px-3 py-2">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-term-dim">
            Trending OI Summary
          </span>
          {L && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                L.sentiment === "Bullish"
                  ? "bg-up text-white"
                  : L.sentiment === "Bearish"
                  ? "bg-down text-white"
                  : "bg-term-border text-term-dim"
              }`}
            >
              {L.sentiment}
            </span>
          )}
          {L && (
            <span className="text-[10px] text-term-dim">
              latest {tf < 1440 ? `${tf}-min` : "daily"} bucket at {fmtTime(L.t)}
            </span>
          )}
        </div>
        {L ? (
          <div className="flex flex-wrap gap-2">
            <Card
              label="Current bias"
              value={L.sentiment}
              valueCls={sentCls(L.sentiment)}
              sub={`Diff OI ${inr(L.diff)}`}
            />
            <Card
              label="Change in OI pressure"
              value={L.pInt >= L.cInt ? "PE OI stronger" : "CE OI stronger"}
              valueCls={L.pInt >= L.cInt ? "text-up" : "text-down"}
              sub={`CE ${compact(L.cCum)} / PE ${compact(L.pCum)}`}
            />
            <Card
              label="PCR"
              value={L.pcr != null ? nf(L.pcr, 3) : "–"}
              valueCls={L.pcr != null ? (L.pcr >= 1 ? "text-up" : "text-down") : ""}
              sub={
                P?.pcr != null && L.pcr != null
                  ? `${(L.pcr - P.pcr >= 0 ? "+" : "")}${nf(L.pcr - P.pcr, 3)} vs prev`
                  : "put OI / call OI"
              }
            />
            <Card
              label="COI PCR"
              value={L.coiPcr != null ? nf(L.coiPcr, 3) : "–"}
              valueCls={L.coiPcr != null ? (L.coiPcr >= 0 ? "text-up" : "text-down") : ""}
              sub="Δ put OI / Δ call OI"
            />
            <Card
              label="Volume PCR"
              value={L.volPcr != null ? nf(L.volPcr, 3) : "–"}
              valueCls={L.volPcr != null ? (L.volPcr >= 1 ? "text-up" : "text-down") : ""}
              sub="put volume / call volume"
            />
            <Card
              label="Direction change"
              value={sInr(L.chngInDir)}
              valueCls={L.chngInDir >= 0 ? "text-up" : "text-down"}
              sub={P ? `${sInr(L.chngInDir - P.chngInDir)} momentum` : "vs previous bucket"}
            />
          </div>
        ) : (
          <div className="text-2xs text-term-dim">
            {daily
              ? expiry
                ? `loading daily OI history for ${symbol}…`
                : "pick an expiry for the 1D view"
              : `collecting OI history for ${symbol}… (needs a few snapshots)`}
          </div>
        )}
      </div>

      {/* timeframe controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
        <span className="uppercase tracking-wide">Timeframe</span>
        <div className="seg">
          {TF.map(([lbl, v]) => (
            <button key={v} onClick={() => setTf(v)} className={tf === v ? "on" : ""}>
              {lbl}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-up" /> auto-refresh {daily ? "60s" : "15s"}
        </span>
      </div>

      {showChart && (
        <div className="h-[240px] shrink-0 border-b border-term-border p-3">
          {chart ?? (
            <div className="flex h-full items-center justify-center text-2xs text-term-dim">
              need a few snapshots
            </div>
          )}
        </div>
      )}

      {/* data table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-2xs">
          <thead className="sticky top-0 z-10 bg-term-panel text-[10px] uppercase text-term-dim">
            <tr>
              {[
                "Time",
                "Spot",
                "Calls chng OI",
                "Puts chng OI",
                "Diff. in OI",
                "Diff %",
                "Dir.",
                "Chng in dir",
                "PCR",
                "COI PCR",
                "Vol PCR",
                "Sentiment",
              ].map((h, i) => (
                <th
                  key={h}
                  className={`border-b border-r border-term-border px-2 py-1.5 font-medium last:border-r-0 ${
                    i === 0 || i === 11 ? "text-left" : "text-right"
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i === 0 ? "bg-term-accent/[0.06]" : ""}>
                <td className="num border-b border-r border-term-border/40 px-2 py-1 text-term-dim">
                  {fmtTime(r.t)}
                </td>
                <td className="num border-b border-r border-term-border/40 px-2 py-1 text-right">
                  {nf(r.spot, 1)}
                </td>
                <td
                  className="num border-b border-r border-term-border/40 px-2 py-1 text-right"
                  style={{ color: CE }}
                >
                  {inr(r.cCum)}
                  <span className="block text-[9px] opacity-70">({sInr(r.cInt)})</span>
                </td>
                <td
                  className="num border-b border-r border-term-border/40 px-2 py-1 text-right"
                  style={{ color: PE }}
                >
                  {inr(r.pCum)}
                  <span className="block text-[9px] opacity-70">({sInr(r.pInt)})</span>
                </td>
                <td
                  className={`num border-b border-r border-term-border/40 px-2 py-1 text-right ${
                    r.diff >= 0 ? "text-up" : "text-down"
                  }`}
                >
                  {inr(r.diff)}
                </td>
                <td
                  className={`num border-b border-r border-term-border/40 px-2 py-1 text-right ${
                    r.diffPct >= 0 ? "text-up" : "text-down"
                  }`}
                >
                  {r.diffPct >= 0 ? "+" : ""}
                  {nf(r.diffPct, 1)}%
                </td>
                <td className="border-b border-r border-term-border/40 px-2 py-1 text-center">
                  <span
                    className={`inline-block rounded px-1.5 font-bold ${
                      r.dirUp ? "bg-up/20 text-up" : "bg-down/20 text-down"
                    }`}
                  >
                    {r.dirUp ? "↑" : "↓"}
                  </span>
                </td>
                <td
                  className={`num border-b border-r border-term-border/40 px-2 py-1 text-right ${
                    r.chngInDir >= 0 ? "text-up" : "text-down"
                  }`}
                >
                  {inr(r.chngInDir)}
                </td>
                <td className="num border-b border-r border-term-border/40 px-2 py-1 text-right">
                  {r.pcr != null ? nf(r.pcr, 3) : "–"}
                </td>
                <td
                  className={`num border-b border-r border-term-border/40 px-2 py-1 text-right ${
                    r.coiPcr != null ? (r.coiPcr >= 0 ? "text-up" : "text-down") : "text-term-dim"
                  }`}
                >
                  {r.coiPcr != null ? nf(r.coiPcr, 3) : "–"}
                </td>
                <td className="num border-b border-r border-term-border/40 px-2 py-1 text-right">
                  {r.volPcr != null ? nf(r.volPcr, 2) : "–"}
                </td>
                <td
                  className={`border-b border-term-border/40 px-2 py-1 font-semibold ${sentCls(
                    r.sentiment
                  )}`}
                >
                  {r.sentiment}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={12} className="px-3 py-6 text-center text-2xs text-term-dim">
                  collecting OI history…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
