import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { oiCr, nf } from "../lib/format";
import { SelectMenu } from "./SelectMenu";

type Pt = {
  t: number;
  spot: number;
  pcr: number | null;
  ce: number; // cumulative Call ΔOI since day open
  pe: number; // cumulative Put ΔOI since day open
  cVol: number;
  pVol: number;
};

const CE = "#f87171"; // call OI  — red
const PE = "#4ade80"; // put OI   — green
const PCRC = "#eab308"; // pcr     — amber

const SENT_COL: Record<string, string> = {
  "▲ Bullish": "#4ade80",
  "▼ Bearish": "#f87171",
  "Put writing ↓": "#eab308",
  "Call unwind ↑": "#38bdf8",
  Neutral: "#3b4657",
};

// OI figures in lakh ("35.35L", not "35,35,080") -- asked for 24-Sep
const inr = (v: number) => oiCr(v); // crores (asked 25-Sep; was lakhs)
const sInr = (v: number) => (v >= 0 ? "+" : "") + inr(v);
const sentCls = (s: string) =>
  s === "Bullish" ? "text-up" : s === "Bearish" ? "text-down" : "text-term-dim";

const VIEW_LS = "trendingoi.view";

// Live data table: columns hidden on a phone (< sm), shown from sm up. Keeps the
// 7 core columns readable on a Fold cover screen instead of a 12-wide crush.
const LIVE_HIDE_SM = new Set([4, 7, 8, 9, 10]); // Diff OI, Chng-dir, PCR, COI PCR, Vol PCR

/* ------------------------------------------------------------------ *
 *  Shared session / daily history loader                             *
 * ------------------------------------------------------------------ */
function useTrendingOI() {
  const symbol = useStore((s) => s.symbol);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const selectExpiry = useStore((s) => s.selectExpiry);
  const chain = useStore((s) => s.chain);
  const symClass = useStore((s) => s.symClass);
  const symClassOk = useStore((s) => s.symClassOk);

  const [symChoices, setSymChoices] = useState<string[]>([]);
  const [pts, setPts] = useState<Pt[]>([]);
  const [tf, setTf] = useState(5); // bucket minutes; >=1440 → daily view

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

  return {
    symbol,
    selectSymbol,
    selectExpiry,
    chain,
    symOptions,
    expiry,
    daily,
    pts,
    tf,
    setTf,
  };
}

/* ================================================================== *
 *  Wrapper — Live / Classic view switch                              *
 * ================================================================== */
type ToiView = "live" | "classic" | "cross";
export function TrendingOI() {
  const [view, setView] = useState<ToiView>(() => {
    try {
      const v = localStorage.getItem(VIEW_LS);
      return v === "classic" || v === "cross" ? v : "live";
    } catch {
      return "live";
    }
  });
  const pick = (v: ToiView) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_LS, v);
    } catch {}
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs uppercase tracking-wide text-term-dim">
        <span>Trending OI view</span>
        <div className="seg">
          <button className={view === "live" ? "on" : ""} onClick={() => pick("live")}>
            Live table
          </button>
          <button className={view === "classic" ? "on" : ""} onClick={() => pick("classic")}>
            Classic chart
          </button>
          <button className={view === "cross" ? "on" : ""} onClick={() => pick("cross")}>
            Crossover
          </button>
        </div>
        <span className="ml-auto hidden normal-case sm:inline">
          {view === "live"
            ? "NiftyTrader-style summary + per-bucket data"
            : view === "cross"
            ? "where Put OI change crosses Call OI change, and what spot did next"
            : "original CE/PE build-up trend + PCR overlay"}
        </span>
      </div>
      {view === "live" ? <TrendingOILive /> : view === "cross" ? <TrendingOICrossover /> : <TrendingOIClassic />}
    </div>
  );
}

/* ================================================================== *
 *  LIVE — summary band + "Trending OI Data" table                    *
 * ================================================================== */
function TrendingOILive() {
  const { symbol, selectSymbol, selectExpiry, chain, symOptions, expiry, daily, pts, tf, setTf } =
    useTrendingOI();
  // narrow subscription — only the current chain symbol's tick
  const live = useStore((s) => (s.chain ? s.liveSpots[s.chain.symbol] : undefined));

  const [showChart, setShowChart] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  // ---- bucket the session into tf-wide windows and derive every column ----
  const rows = useMemo(() => {
    if (pts.length < 2) return [];
    const w = daily ? 86400 : tf * 60;
    const buckets: Pt[] = [];
    let key = -1;
    for (const p of pts) {
      const k = Math.floor(p.t / w);
      // stamp every bucket with its own aligned boundary time, not the raw
      // snapshot's own timestamp -- the in-progress (latest) bucket gets a
      // new snapshot every ~15s poll, and without this its .t (and so its
      // React key below) would drift on every refresh, forcing React to
      // tear down and recreate that row's DOM node instead of patching it
      // in place. That churn is what showed up as a "ghost" row flashing
      // near the sticky header.
      if (k !== key) {
        buckets.push({ ...p, t: k * w });
        key = k;
      } else {
        buckets[buckets.length - 1] = { ...p, t: k * w };
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
      const sentiment =
        diff > denom * 0.02 ? "Bullish" : diff < -denom * 0.02 ? "Bearish" : "Neutral";
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

  const L = rows[0];
  const P = rows[1];
  const fmtTime = (t: number) =>
    daily
      ? new Date(t * 1000).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
      : new Date(t * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

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
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(v)}
              y2={y(v)}
              stroke="currentColor"
              strokeOpacity={Math.abs(v) < 1e-6 ? 0.5 : 0.12}
              className="text-term-dim"
            />
            <text x={6} y={y(v) + 3} fontSize={10} className="fill-term-dim">
              {oiCr(v)}
            </text>
          </g>
        ))}
        {[t0, (t0 + t1) / 2, t1].map((t, i) => (
          <text key={i} x={x(t)} y={H - 6} fontSize={10} textAnchor="middle" className="fill-term-dim">
            {fmtTime(t)}
          </text>
        ))}
        <path d={`${line((p) => p.ce)} L${x(t1)},${y0} L${x(t0)},${y0} Z`} fill={CE} fillOpacity={0.1} />
        <path d={`${line((p) => p.pe)} L${x(t1)},${y0} L${x(t0)},${y0} Z`} fill={PE} fillOpacity={0.1} />
        <path d={line((p) => p.ce)} fill="none" stroke={CE} strokeWidth={2} />
        <path d={line((p) => p.pe)} fill="none" stroke={PE} strokeWidth={2} />
        <path
          d={pts
            .map(
              (p, i) =>
                `${i ? "L" : "M"}${x(p.t).toFixed(1)},${(
                  pad.t +
                  (1 - ((p.pcr ?? 1) - 0.6) / 1.0) * (H - pad.t - pad.b)
                ).toFixed(1)}`
            )
            .join(" ")}
          fill="none"
          stroke={PCRC}
          strokeWidth={1.25}
          strokeOpacity={0.8}
        />
      </svg>
    );
  }, [showChart, pts, daily]);

  // hold the last live tick so the readout doesn't flip between live.ltp and
  // the slightly-different chain.spot on every store update (that's the flicker)
  const lastSpotRef = useRef(0);
  const spotSymRef = useRef(symbol);
  if (symbol !== spotSymRef.current) {
    spotSymRef.current = symbol;
    lastSpotRef.current = 0;
  }
  if (live?.ltp != null) lastSpotRef.current = live.ltp;
  const spot = lastSpotRef.current || chain?.spot || 0;
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
    <div className="min-w-0 rounded-lg border border-term-border bg-term-bg/40 px-2 py-1.5 sm:min-w-[150px] sm:flex-1 sm:px-3 sm:py-2">
      <div className="truncate text-[9px] font-semibold uppercase tracking-wide text-term-dim">
        {label}
      </div>
      <div className={`num truncate text-sm font-bold sm:text-base ${valueCls}`}>{value}</div>
      {sub != null && <div className="mt-0.5 truncate text-[10px] text-term-dim">{sub}</div>}
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
    <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto lg:overflow-y-hidden">
      {/* header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel2 px-3 py-2 text-2xs">
        <span className="text-sm font-semibold">{symbol} Trending OI Live</span>
        <SelectMenu
          value={symbol}
          options={symOptions.map((s) => [s, s] as [string, string])}
          onChange={(v) => selectSymbol(v, true)}
          title="Underlying"
          width={140}
        />
        {chain?.expiries?.length ? (
          <SelectMenu
            value={expiry}
            options={chain.expiries.map((e) => [e, e] as [string, string])}
            onChange={selectExpiry}
            title="Expiry"
            width={130}
          />
        ) : null}
        <button
          onClick={() => setShowChart((v) => !v)}
          className={`rounded border px-2 py-0.5 font-semibold ${
            showChart
              ? "border-term-accent bg-term-accent text-white"
              : "border-term-dim/70 text-term-dim"
          }`}
        >
          {showChart ? "Hide chart" : "Show chart"}
        </button>
        <span className="uppercase tracking-wide text-term-dim">Timeframe</span>
        <SelectMenu value={tf} options={TF} onChange={setTf} title="Bucket timeframe" />
        <span className="num text-term-dim">
          Spot{" "}
          <span className="num inline-block min-w-[3.5rem] text-right text-term-text">
            {nf(spot, 1)}
          </span>
          <span className={spotChg == null ? "invisible" : spotChg >= 0 ? "text-up" : "text-down"}>
            {" "}
            ({(spotChg ?? 0) >= 0 ? "+" : ""}
            {nf(spotChg ?? 0, 2)}%)
          </span>
        </span>
        <span className="ml-auto flex items-center gap-3 text-term-dim">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-up" /> auto-refresh{" "}
            {daily ? "60s" : "15s"}
          </span>
          <span>
            Refreshed{" "}
            {new Date(now).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
          </span>
        </span>
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
          <div className="grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:gap-2">
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
              sub={`CE ${oiCr(L.cCum)} / PE ${oiCr(L.pCum)}`}
            />
            <Card
              label="PCR"
              value={L.pcr != null ? nf(L.pcr, 3) : "–"}
              valueCls={L.pcr != null ? (L.pcr >= 1 ? "text-up" : "text-down") : ""}
              sub={
                P?.pcr != null && L.pcr != null
                  ? `${L.pcr - P.pcr >= 0 ? "+" : ""}${nf(L.pcr - P.pcr, 3)} vs prev`
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

      {showChart && (
        <div className="h-[240px] shrink-0 border-b border-term-border p-3">
          {chart ?? (
            <div className="flex h-full items-center justify-center text-2xs text-term-dim">
              need a few snapshots
            </div>
          )}
        </div>
      )}

      {/* data table — a phone shows the 7 core columns, fitted to the screen width (no
          sideways scroll: tight padding, short headers) and at full length: the page
          scrolls and the header row sticks under the top (a scroll box of its own was
          squeezed to ~200px under the summary, rows showing above its header). sm+ adds
          the 5 detail PCR / direction columns and scrolls sideways if it must. */}
      <div className="max-w-full shrink-0 px-1 pb-1 sm:overflow-x-auto sm:p-2 lg:min-h-0 lg:flex-1 lg:shrink lg:overflow-auto">
        <table className="w-full border-separate border-spacing-0 border border-term-border text-2xs sm:min-w-[820px] [&_td:last-child]:border-r-0 [&_td]:border-b [&_td]:border-r [&_td]:border-term-border/60 [&_th:last-child]:border-r-0 [&_th]:border-b [&_th]:border-r [&_th]:border-term-border">
          <thead className="sticky -top-px z-10 isolate will-change-transform bg-term-panel text-[10px] uppercase text-term-dim sm:top-0">
            <tr>
              {(
                [
                  ["Time"],
                  ["Spot"],
                  ["Calls chng OI", "Calls ΔOI"],
                  ["Puts chng OI", "Puts ΔOI"],
                  ["Diff. in OI"],
                  ["Diff %"],
                  ["Dir."],
                  ["Chng in dir"],
                  ["PCR"],
                  ["COI PCR"],
                  ["Vol PCR"],
                  ["Sentiment", "Bias"],
                ] as [string, string?][]
              ).map(([h, short], i) => (
                <th
                  key={h}
                  className={`bg-term-panel px-1 py-1.5 font-medium last:border-r-0 sm:px-2 ${
                    i === 0 || i === 11 ? "text-left" : i === 6 ? "text-center" : "text-right"
                  } ${LIVE_HIDE_SM.has(i) ? "hidden sm:table-cell" : ""}`}
                  title={short ? h : undefined}
                >
                  {short ? (
                    <>
                      <span className="sm:hidden">{short}</span>
                      <span className="hidden sm:inline">{h}</span>
                    </>
                  ) : (
                    h
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.t} className={i === 0 ? "bg-term-accent/[0.06]" : ""}>
                <td className="num px-1 py-1 sm:px-2 text-term-dim">
                  {fmtTime(r.t)}
                </td>
                <td className="num px-1 py-1 sm:px-2 text-right">
                  {nf(r.spot, 1)}
                </td>
                <td
                  className="num px-1 py-1 sm:px-2 text-right"
                  style={{ color: CE }}
                >
                  {inr(r.cCum)}
                  <span className="block whitespace-nowrap text-[9px] opacity-70">({sInr(r.cInt)})</span>
                </td>
                <td
                  className="num px-1 py-1 sm:px-2 text-right"
                  style={{ color: PE }}
                >
                  {inr(r.pCum)}
                  <span className="block whitespace-nowrap text-[9px] opacity-70">({sInr(r.pInt)})</span>
                </td>
                <td
                  className={`num hidden px-1 py-1 sm:px-2 text-right sm:table-cell ${
                    r.diff >= 0 ? "text-up" : "text-down"
                  }`}
                >
                  {inr(r.diff)}
                </td>
                <td
                  className={`num px-1 py-1 sm:px-2 text-right ${
                    r.diffPct >= 0 ? "text-up" : "text-down"
                  }`}
                >
                  {r.diffPct >= 0 ? "+" : ""}
                  {nf(r.diffPct, 1)}%
                </td>
                <td className="px-1 py-1 sm:px-2 text-center">
                  <span
                    className={`inline-block rounded px-1.5 font-bold ${
                      r.dirUp ? "bg-up/20 text-up" : "bg-down/20 text-down"
                    }`}
                  >
                    {r.dirUp ? "↑" : "↓"}
                  </span>
                </td>
                <td
                  className={`num hidden px-1 py-1 sm:px-2 text-right sm:table-cell ${
                    r.chngInDir >= 0 ? "text-up" : "text-down"
                  }`}
                >
                  {inr(r.chngInDir)}
                </td>
                <td className="num hidden px-1 py-1 sm:px-2 text-right sm:table-cell">
                  {r.pcr != null ? nf(r.pcr, 3) : "–"}
                </td>
                <td
                  className={`num hidden px-1 py-1 sm:px-2 text-right sm:table-cell ${
                    r.coiPcr != null ? (r.coiPcr >= 0 ? "text-up" : "text-down") : "text-term-dim"
                  }`}
                >
                  {r.coiPcr != null ? nf(r.coiPcr, 3) : "–"}
                </td>
                <td className="num hidden px-1 py-1 sm:px-2 text-right sm:table-cell">
                  {r.volPcr != null ? nf(r.volPcr, 2) : "–"}
                </td>
                <td className={`px-1 py-1 sm:px-2 font-semibold ${sentCls(r.sentiment)}`}>
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

/* ================================================================== *
 *  CROSSOVER -- Call OI change vs Put OI change through the day       *
 * ================================================================== */
type Cross = { t: number; spot: number; up: boolean; endT: number; endSpot: number; move: number; open: boolean };

function TrendingOICrossover() {
  const { symbol, selectSymbol, symOptions, tf, setTf } = useTrendingOI();
  const daily = false;
  // the WHOLE day: the per-symbol PCR series keeps every 5-min point from 09:15 (the chain's
  // snapshot history only holds the last ~1.5 hours in market hours, so a morning crossover was lost)
  const [pts, setPts] = useState<Pt[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.pcr(symbol, null, 5).then(
        (d) => {
          if (!alive) return;
          const at = (k: string) => d.fields.indexOf(k);
          const [it, isp, ipc, icc, ipcg, icv, ipv] = ["t", "spot", "pcr", "ceOIChg", "peOIChg", "ceVol", "peVol"].map(at);
          const last = d.points.length ? (d.points[d.points.length - 1][it] as number) : 0;
          const day = new Date((last + 19800) * 1000).toISOString().slice(0, 10);
          setPts(
            d.points
              .filter((p) => p[icc] != null && p[ipcg] != null && new Date(((p[it] as number) + 19800) * 1000).toISOString().slice(0, 10) === day)
              .map((p) => ({
                t: p[it] as number,
                spot: Number(p[isp] ?? 0),
                pcr: (p[ipc] as number | null) ?? null,
                ce: Number(p[icc]),
                pe: Number(p[ipcg]),
                cVol: icv >= 0 ? Number(p[icv] ?? 0) : 0,
                pVol: ipv >= 0 ? Number(p[ipv] ?? 0) : 0,
              }))
          );
        },
        () => {}
      );
    setPts([]);
    load();
    const id = window.setInterval(() => !document.hidden && load(), 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [symbol]);

  // one point per tf bucket (its last reading), on the market's 09:15 grid (03:45 UTC) -- plain
  // epoch buckets cut the 1-hour bars at 08:30 / 09:30 / 10:30 IST
  const bars = useMemo(() => {
    const w = Math.max(1, tf) * 60;
    const O = 13500;
    const out: Pt[] = [];
    let key = -1;
    for (const p of pts) {
      const k = Math.floor((p.t - O) / w);
      const bt = Math.max(k * w + O, pts[0].t - ((pts[0].t - O) % w));
      if (k !== key) {
        out.push({ ...p, t: bt });
        key = k;
      } else out[out.length - 1] = { ...p, t: bt };
    }
    return out;
  }, [pts, tf]);

  // crossovers, with a small dead-band so a tie wobbling around zero isn't a string of "crosses":
  // a side only counts once Put - Call is more than 3% of their combined size
  const { crosses, side, since } = useMemo(() => {
    const out: Cross[] = [];
    let cur = 0;
    let sinceT: number | null = null;
    bars.forEach((b) => {
      const diff = b.pe - b.ce;
      const band = (Math.abs(b.ce) + Math.abs(b.pe)) * 0.03;
      const s = diff > band ? 1 : diff < -band ? -1 : 0;
      if (!s || s === cur) return;
      if (cur !== 0) out.push({ t: b.t, spot: b.spot, up: s > 0, endT: 0, endSpot: 0, move: 0, open: false });
      if (cur === 0 && sinceT == null) sinceT = b.t;
      cur = s;
      sinceT = b.t;
    });
    const last = bars[bars.length - 1];
    out.forEach((c, i) => {
      const nx = out[i + 1];
      const end = nx ? bars.find((b) => b.t === nx.t) ?? last : last;
      c.endT = end?.t ?? c.t;
      c.endSpot = end?.spot ?? c.spot;
      c.move = (c.endSpot - c.spot) * (c.up ? 1 : -1); // + = spot went the way the cross said
      c.open = !nx;
    });
    return { crosses: out, side: cur, since: sinceT as number | null };
  }, [bars]);

  const last = bars[bars.length - 1];
  const first = pts[0]; // the day's first reading, whatever the bar size
  const lastCross = crosses[crosses.length - 1];
  const worked = crosses.filter((c) => !c.open && c.move > 0).length;
  const closed = crosses.filter((c) => !c.open).length;
  const fmt = (t: number) =>
    daily
      ? new Date(t * 1000).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
      : new Date(t * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const pts2 = (v: number) => `${v >= 0 ? "+" : "−"}${nf(Math.abs(v), 0)}`;
  const held = (a: number, b: number) => {
    const m = Math.max(0, Math.round((b - a) / 60));
    return daily ? `${Math.round(m / 1440)}d` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  };

  // ---- chart, drawn at the box's real size ----
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const chart = useMemo(() => {
    const W = box.w;
    const H = box.h;
    if (bars.length < 2 || W < 160 || H < 150) return null;
    const pad = { l: 46, r: 10, t: 8, b: 18 };
    const gap = 8;
    const spotH = Math.round((H - pad.t - pad.b - gap) * 0.36);
    const oiTop = pad.t + spotH + gap;
    const oiH = H - pad.b - oiTop;
    const t0 = bars[0].t;
    const t1 = bars[bars.length - 1].t || t0 + 1;
    const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
    const sp = bars.map((b) => b.spot);
    const sLo = Math.min(...sp);
    const sHi = Math.max(...sp);
    const ys = (v: number) => pad.t + (1 - (v - sLo) / (sHi - sLo || 1)) * spotH;
    const ov = bars.flatMap((b) => [b.ce, b.pe, 0]);
    const oLo = Math.min(...ov);
    const oHi = Math.max(...ov);
    const g = (oHi - oLo) * 0.08 || 1;
    const yo = (v: number) => oiTop + (1 - (v - (oLo - g)) / (oHi - oLo + 2 * g || 1)) * oiH;
    const path = (f: (b: Pt) => number, y: (v: number) => number) =>
      bars.map((b, i) => `${i ? "L" : "M"}${x(b.t).toFixed(1)},${y(f(b)).toFixed(1)}`).join(" ");
    // shade between the two lines: green where puts lead, red where calls lead
    const bands = bars.slice(1).map((b, i) => {
      const a = bars[i];
      const up = (a.pe - a.ce + (b.pe - b.ce)) / 2 >= 0;
      return (
        <path
          key={i}
          d={`M${x(a.t)},${yo(a.pe)} L${x(b.t)},${yo(b.pe)} L${x(b.t)},${yo(b.ce)} L${x(a.t)},${yo(a.ce)} Z`}
          fill={up ? PE : CE}
          fillOpacity={0.14}
        />
      );
    });
    return (
      <svg width={W} height={H} className="block">
        {/* spot pane */}
        <text x={W - pad.r} y={pad.t + 10} fontSize={10} textAnchor="end" className="fill-term-dim">
          spot
        </text>
        {[sHi, sLo].map((v, i) => (
          <text key={i} x={4} y={ys(v) + (i ? -2 : 12)} fontSize={10} className="fill-term-dim">
            {nf(v, 0)}
          </text>
        ))}
        <path d={path((b) => b.spot, ys)} fill="none" stroke="#93c5fd" strokeWidth={1.5} />
        {/* OI pane */}
        <line x1={pad.l} x2={W - pad.r} y1={yo(0)} y2={yo(0)} stroke="currentColor" strokeOpacity={0.35} className="text-term-dim" />
        {[oHi, 0, oLo].map((v, i) => (
          <text key={i} x={4} y={yo(v) + 3} fontSize={10} className="fill-term-dim">
            {oiCr(v)}
          </text>
        ))}
        {bands}
        <path d={path((b) => b.ce, yo)} fill="none" stroke={CE} strokeWidth={2} />
        <path d={path((b) => b.pe, yo)} fill="none" stroke={PE} strokeWidth={2} />
        {/* every crossover: a line through both panes and a marker on spot */}
        {crosses.map((c, i) => (
          <g key={i}>
            <line x1={x(c.t)} x2={x(c.t)} y1={pad.t} y2={oiTop + oiH} stroke={c.up ? PE : CE} strokeDasharray="3 3" strokeOpacity={0.7} />
            <text x={x(c.t)} y={ys(c.spot) + (c.up ? 14 : -5)} fontSize={12} textAnchor="middle" fill={c.up ? PE : CE}>
              {c.up ? "▲" : "▼"}
            </text>
          </g>
        ))}
        {[t0, (t0 + t1) / 2, t1].map((t, i) => (
          <text key={i} x={x(t)} y={H - 4} fontSize={10} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} className="fill-term-dim">
            {fmt(t)}
          </text>
        ))}
      </svg>
    );
  }, [bars, crosses, box, daily]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
        <span className="text-sm font-semibold text-term-text">{symbol} OI crossover</span>
        <SelectMenu value={symbol} options={symOptions.map((x) => [x, x] as [string, string])} onChange={(v) => selectSymbol(v, true)} title="Underlying" width={130} />
        <div className="seg">
          {[5, 15, 60].map((m) => (
            <button key={m} className={tf === m ? "on" : ""} onClick={() => setTf(m)}>
              {m < 60 ? `${m} min` : "1 hour"}
            </button>
          ))}
        </div>
        <span className="flex items-center gap-2">
          <span style={{ color: CE }}>■</span> Call OI Δ <span style={{ color: PE }}>■</span> Put OI Δ
        </span>
      </div>

      {/* where it stands, in plain words */}
      <div className="border-b border-term-border bg-term-panel px-3 py-2">
        {!last ? (
          <div className="text-2xs text-term-dim">collecting OI history for {symbol}… (needs a few snapshots)</div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span
              className={`rounded px-2 py-0.5 text-[12px] font-bold ${
                side > 0 ? "bg-up text-white" : side < 0 ? "bg-down text-white" : "bg-term-border text-term-dim"
              }`}
            >
              {side > 0 ? "▲ PUTS LEADING — bullish" : side < 0 ? "▼ CALLS LEADING — bearish" : "NO CLEAR LEAD"}
            </span>
            <span className="text-[12px] text-term-text">
              {lastCross ? (
                <>
                  since the {fmt(lastCross.t)} crossover at {nf(lastCross.spot, 0)} · spot now {nf(last.spot, 0)}{" "}
                  <span className={lastCross.move >= 0 ? "text-up" : "text-down"}>({pts2(last.spot - lastCross.spot)} pts)</span>
                </>
              ) : since != null ? (
                <>no crossover yet today — {side > 0 ? "puts" : "calls"} have led since {fmt(since)}</>
              ) : (
                <>Put and Call OI change are level</>
              )}
            </span>
            <span className="text-[11px] text-term-dim">
              Put Δ {oiCr(last.pe)} · Call Δ {oiCr(last.ce)} · gap {oiCr(last.pe - last.ce)}
              {first ? ` · spot ${pts2(last.spot - first.spot)} today` : ""}
            </span>
            {closed > 0 && (
              <span className="text-[11px] text-term-dim">
                {crosses.length} crossover{crosses.length === 1 ? "" : "s"} · {worked} of {closed} finished ones moved spot the way they pointed
              </span>
            )}
          </div>
        )}
      </div>

      <div ref={boxRef} className="h-[280px] shrink-0 border-b border-term-border px-1 py-2 sm:h-[340px]">
        {chart ?? <div className="flex h-full items-center justify-center text-2xs text-term-dim">need a few snapshots</div>}
      </div>

      {/* every crossover, newest first */}
      <div className="max-w-full shrink-0 px-1 pb-2 pt-1 sm:p-2">
        <table className="w-full border-separate border-spacing-0 border border-term-border text-2xs [&_td:last-child]:border-r-0 [&_td]:border-b [&_td]:border-r [&_td]:border-term-border/60 [&_th:last-child]:border-r-0 [&_th]:border-b [&_th]:border-r [&_th]:border-term-border">
          <thead className="sticky -top-px z-10 bg-term-panel text-[10px] uppercase text-term-dim sm:top-0">
            <tr>
              <th className="bg-term-panel px-1 py-1.5 text-left font-medium sm:px-2">Time</th>
              <th className="bg-term-panel px-1 py-1.5 text-left font-medium sm:px-2">Crossover</th>
              <th className="bg-term-panel px-1 py-1.5 text-right font-medium sm:px-2">Spot</th>
              <th className="bg-term-panel px-1 py-1.5 text-right font-medium sm:px-2" title="spot move from this crossover to the next one (or now), in the direction it pointed">
                Then
              </th>
              <th className="bg-term-panel px-1 py-1.5 text-right font-medium sm:px-2">Held</th>
            </tr>
          </thead>
          <tbody>
            {[...crosses].reverse().map((c) => (
              <tr key={c.t} className={c.open ? "bg-term-accent/[0.06]" : ""}>
                <td className="num px-1 py-1 text-term-dim sm:px-2">{fmt(c.t)}</td>
                <td className={`px-1 py-1 font-semibold sm:px-2 ${c.up ? "text-up" : "text-down"}`}>
                  {c.up ? "▲ Puts over calls" : "▼ Calls over puts"}
                  {c.open && <span className="ml-1 text-[10px] font-normal text-term-dim">(now)</span>}
                </td>
                <td className="num px-1 py-1 text-right sm:px-2">{nf(c.spot, 0)}</td>
                <td className={`num px-1 py-1 text-right sm:px-2 ${c.move >= 0 ? "text-up" : "text-down"}`}>
                  {pts2(c.move)}
                  {c.open ? "" : c.move >= 0 ? " ✓" : " ✗"}
                </td>
                <td className="num px-1 py-1 text-right text-term-dim sm:px-2">{held(c.t, c.endT)}</td>
              </tr>
            ))}
            {crosses.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-5 text-center text-2xs text-term-dim">
                  {bars.length < 2 ? "collecting OI history…" : "no crossover yet today at this timeframe"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="px-1 pt-2 text-[10px] leading-snug text-term-dim">
          A crossover is where the day's Put OI change passes the Call OI change. Puts over calls = more put writing than
          call writing (support building, bullish); calls over puts = the reverse. A side only counts once it leads by more
          than 3% of their combined size, so a near-tie wobbling around zero doesn't make a string of crossovers. "Then" =
          how far spot went in the crossover's direction until the next one (or now).
        </div>
      </div>
    </div>
  );
}

/* ================================================================== *
 *  CLASSIC — original CE/PE build-up trend chart + PCR overlay       *
 * ================================================================== */
function TrendingOIClassic() {
  const { symbol, selectSymbol, chain, symOptions, expiry, daily, pts, tf, setTf } = useTrendingOI();

  // measure the chart box so the SVG can render 1:1 with the pixel grid —
  // a stretched viewBox (preserveAspectRatio="none") was making the lines
  // and labels look blurry / distorted.
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setBox({ w: Math.round(el.clientWidth - 24), h: Math.round(el.clientHeight - 24) });
    });
    ro.observe(el);
    setBox({ w: Math.round(el.clientWidth - 24), h: Math.round(el.clientHeight - 24) });
    return () => ro.disconnect();
  }, []);

  const last = pts[pts.length - 1];
  const first = pts[0];
  const net = last ? last.pe - last.ce : 0; // >0 => puts adding faster
  const netOi = last ? last.ce + last.pe : 0; // total OI added(+) / reduced(-) today
  const priceChg = last && first ? last.spot - first.spot : 0;

  const bias = useMemo(() => {
    if (!last) return null;
    const scale = Math.max(Math.abs(last.ce), Math.abs(last.pe), 1);
    const r = net / scale;
    if (r > 0.08) return { txt: "▲ BULLISH · put writing", cls: "bg-up text-white" };
    if (r < -0.08) return { txt: "▼ BEARISH · call writing", cls: "bg-down text-white" };
    return { txt: "BALANCED", cls: "bg-term-border text-term-dim" };
  }, [last, net]);

  const buildup = useMemo(() => {
    if (!last || !first || pts.length < 3) return null;
    const pUp = priceChg >= 0;
    const oUp = netOi >= 0;
    if (pUp && oUp) return { txt: "LONG BUILDUP", cls: "bg-up text-white", note: "price ↑ · OI ↑" };
    if (!pUp && oUp)
      return { txt: "SHORT BUILDUP", cls: "bg-down text-white", note: "price ↓ · OI ↑" };
    if (!pUp && !oUp)
      return { txt: "LONG UNWINDING", cls: "bg-amber-500 text-white", note: "price ↓ · OI ↓" };
    return { txt: "SHORT COVERING", cls: "bg-sky-500 text-white", note: "price ↑ · OI ↓" };
  }, [last, first, priceChg, netOi, pts.length]);

  const chart = useMemo(() => {
    const W = box.w;
    const H = box.h;
    if (pts.length < 2 || W < 140 || H < 150) return null;

    const padL = 50;
    const padR = 14;
    const padT = 12;
    const padB = 20;
    const gap = 8;
    const plotW = W - padL - padR;
    const innerH = H - padT - padB - gap * 2;
    const stripH = Math.max(36, Math.min(78, Math.round(innerH * 0.22)));
    const restH = innerH - stripH;
    const spotH = Math.round(restH * 0.46);
    const colH = restH - spotH;
    const spotTop = padT;
    const colTop = padT + spotH + gap;
    const stripTop = colTop + colH + gap;

    // ---- per-interval Call / Put ΔOI buckets (Put up, Call down) ----
    const w = daily ? 86400 : Math.max(1, tf) * 60;
    const buckets: Pt[] = [];
    let bk = -1;
    for (const p of pts) {
      const k = Math.floor(p.t / w);
      if (k !== bk) {
        buckets.push(p);
        bk = k;
      } else buckets[buckets.length - 1] = p;
    }
    let bars: { t: number; dce: number; dpe: number }[] = [];
    for (let i = 1; i < buckets.length; i++)
      bars.push({
        t: buckets[i].t,
        dce: buckets[i].ce - buckets[i - 1].ce,
        dpe: buckets[i].pe - buckets[i - 1].pe,
      });
    const maxBars = Math.max(8, Math.floor(plotW / 7));
    bars = bars.slice(-maxBars);

    // shared time window — clipped to the visible bars
    const winT0 = bars.length ? bars[0].t : pts[0].t;
    const winT1 = (bars.length ? bars[bars.length - 1].t : pts[pts.length - 1].t) || winT0 + 1;
    const x = (t: number) => padL + ((t - winT0) / (winT1 - winT0 || 1)) * plotW;
    const vpts = pts.filter((p) => p.t >= winT0);

    // ---- top pane: spot price ----
    const sv = vpts.map((p) => p.spot).filter((v) => Number.isFinite(v) && v > 0);
    let slo = sv.length ? Math.min(...sv) : 0;
    let shi = sv.length ? Math.max(...sv) : 1;
    const sPad = (shi - slo) * 0.12 || Math.max(1, shi * 0.001);
    slo -= sPad;
    shi += sPad;
    const ys = (v: number) => spotTop + (1 - (v - slo) / (shi - slo || 1)) * spotH;
    const spotPath = vpts
      .map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${ys(p.spot).toFixed(1)}`)
      .join(" ");
    const spotGrid = [shi - sPad, (slo + shi) / 2, slo + sPad];

    // ---- mid pane: diverging ΔOI columns ----
    const cmax = Math.max(1, ...bars.flatMap((b) => [Math.abs(b.dce), Math.abs(b.dpe)]));
    const zeroY = colTop + colH / 2;
    const half = colH / 2 - 3;
    const barW = Math.max(3, Math.min(14, (plotW / Math.max(1, bars.length)) * 0.62));
    const hOf = (v: number) => Math.max(v !== 0 ? 1.5 : 0, (Math.abs(v) / cmax) * half);

    // ---- bottom strip: PCR ----
    const pcrs = vpts.map((p) => p.pcr ?? 1).filter((v) => v > 0);
    let plo = Math.min(...pcrs, 1);
    let phi = Math.max(...pcrs, 1);
    const pPad = (phi - plo) * 0.25 || 0.1;
    plo -= pPad;
    phi += pPad;
    const yp = (v: number) => stripTop + (1 - (v - plo) / (phi - plo || 1)) * stripH;
    const pcrPath = vpts
      .map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${yp(p.pcr ?? 1).toFixed(1)}`)
      .join(" ");

    const fmtT = (t: number) =>
      daily
        ? new Date(t * 1000).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
        : new Date(t * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    const step = Math.max(1, Math.ceil(vpts.length / 6));
    const tGrid = vpts.filter((_, i) => i % step === 0).map((p) => p.t);
    const lastSpot = vpts[vpts.length - 1]?.spot;
    const lastPcr = vpts[vpts.length - 1]?.pcr ?? null;

    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block">
        {/* ---- top pane: spot ---- */}
        <rect x={padL} y={spotTop} width={plotW} height={spotH} fill="none" stroke="currentColor" strokeOpacity={0.12} className="text-term-dim" />
        {spotGrid.map((v, i) => (
          <text key={"sg" + i} x={padL - 6} y={ys(v) + 3.5} fontSize={9} textAnchor="end" className="fill-term-dim">
            {nf(v, 0)}
          </text>
        ))}
        <path d={`${spotPath} L${x(winT1).toFixed(1)},${(spotTop + spotH).toFixed(1)} L${x(winT0).toFixed(1)},${(spotTop + spotH).toFixed(1)} Z`} fill="#38bdf8" fillOpacity={0.08} />
        <path d={spotPath} fill="none" stroke="#38bdf8" strokeWidth={2} />
        {lastSpot != null && (
          <>
            <circle cx={x(winT1)} cy={ys(lastSpot)} r={3} fill="#38bdf8" />
            <text x={padL - 6} y={spotTop + 9} textAnchor="end" fontSize={9} fill="#38bdf8" fontWeight={600}>
              spot
            </text>
            <text x={W - padR} y={spotTop + 10} textAnchor="end" fontSize={10} fill="#38bdf8" fontWeight={600}>
              {nf(lastSpot, 1)}
            </text>
          </>
        )}

        {/* ---- mid pane: diverging ΔOI columns ---- */}
        <line x1={padL} x2={W - padR} y1={zeroY} y2={zeroY} stroke="currentColor" strokeOpacity={0.5} strokeWidth={1.25} className="text-term-dim" />
        <text x={padL - 6} y={colTop + 9} textAnchor="end" fontSize={9} fill={PE} fontWeight={600}>
          Put +
        </text>
        <text x={padL - 6} y={colTop + colH - 3} textAnchor="end" fontSize={9} fill={CE} fontWeight={600}>
          Call +
        </text>
        <text x={padL - 6} y={colTop + colH / 2 - 3} textAnchor="end" fontSize={8} className="fill-term-dim">
          {oiCr(cmax)}
        </text>
        {bars.map((b, i) => {
          const cx = x(b.t);
          const pH = hOf(b.dpe);
          const cH = hOf(b.dce);
          return (
            <g key={i}>
              <rect x={cx - barW / 2} y={zeroY - pH} width={barW} height={pH} rx={1} fill={PE} fillOpacity={b.dpe >= 0 ? 0.95 : 0.4}>
                <title>Put ΔOI {b.dpe >= 0 ? "+" : ""}{oiCr(b.dpe)} · {fmtT(b.t)}</title>
              </rect>
              <rect x={cx - barW / 2} y={zeroY} width={barW} height={cH} rx={1} fill={CE} fillOpacity={b.dce >= 0 ? 0.95 : 0.4}>
                <title>Call ΔOI {b.dce >= 0 ? "+" : ""}{oiCr(b.dce)} · {fmtT(b.t)}</title>
              </rect>
            </g>
          );
        })}

        {/* ---- bottom strip: PCR ---- */}
        <rect x={padL} y={stripTop} width={plotW} height={stripH} fill="none" stroke="currentColor" strokeOpacity={0.15} className="text-term-dim" />
        {plo < 1 && phi > 1 && (
          <>
            <line x1={padL} x2={W - padR} y1={yp(1)} y2={yp(1)} stroke={PCRC} strokeOpacity={0.55} strokeWidth={1} strokeDasharray="4 3" />
            <text x={padL - 6} y={yp(1) + 3.5} fontSize={9} textAnchor="end" className="fill-term-dim">
              1.0
            </text>
          </>
        )}
        <path d={pcrPath} fill="none" stroke={PCRC} strokeWidth={2} />
        {lastPcr != null && <circle cx={x(winT1)} cy={yp(lastPcr)} r={3} fill={PCRC} />}
        <text x={padL - 6} y={stripTop + 10} textAnchor="end" fontSize={10} fill={PCRC} fontWeight={600}>
          PCR
        </text>
        {lastPcr != null && (
          <text x={W - padR} y={stripTop + 11} textAnchor="end" fontSize={10} fill={PCRC} fontWeight={600}>
            {nf(lastPcr, 2)}
          </text>
        )}

        {/* ---- shared time axis ---- */}
        {tGrid.map((t, i) => (
          <text key={"t" + i} x={x(t)} y={H - 6} fontSize={10} textAnchor="middle" className="fill-term-dim">
            {fmtT(t)}
          </text>
        ))}
      </svg>
    );
  }, [pts, last, daily, tf, box.w, box.h]);

  const intervals = useMemo(() => {
    if (pts.length < 2) return [];
    const w = tf * 60;
    const buckets: Pt[] = [];
    let curKey = -1;
    for (const p of pts) {
      const k = Math.floor(p.t / w);
      if (k !== curKey) {
        buckets.push(p);
        curKey = k;
      } else {
        buckets[buckets.length - 1] = p;
      }
    }
    const out: {
      t: number;
      dce: number;
      dpe: number;
      dspot: number;
      sent: { txt: string; cls: string };
    }[] = [];
    for (let i = 1; i < buckets.length; i++) {
      const a = buckets[i - 1];
      const b = buckets[i];
      const dce = b.ce - a.ce;
      const dpe = b.pe - a.pe;
      const dspot = b.spot - a.spot;
      const flow = dpe - dce;
      let txt = "Neutral";
      let cls = "bg-term-border text-term-dim";
      if (flow > 0 && dspot >= 0) {
        txt = "▲ Bullish";
        cls = "bg-up/20 text-up";
      } else if (flow < 0 && dspot <= 0) {
        txt = "▼ Bearish";
        cls = "bg-down/20 text-down";
      } else if (flow > 0 && dspot < 0) {
        txt = "Put writing ↓";
        cls = "bg-amber-500/20 text-amber-400";
      } else if (flow < 0 && dspot > 0) {
        txt = "Call unwind ↑";
        cls = "bg-sky-500/20 text-sky-400";
      }
      out.push({ t: b.t, dce, dpe, dspot, sent: { txt, cls } });
    }
    return out.reverse().slice(0, 20);
  }, [pts, tf]);

  const tfLbl = tf < 60 ? `${tf}m` : tf < 1440 ? `${tf / 60}h` : "1D";

  const pcrNow = last?.pcr ?? null;
  const pcrStats = useMemo(() => {
    const v = pts.map((p) => p.pcr).filter((x): x is number => x != null);
    if (!v.length) return null;
    return { open: v[0], lo: Math.min(...v), hi: Math.max(...v) };
  }, [pts]);
  const pcrDelta =
    last?.pcr != null && first?.pcr != null ? (last.pcr as number) - (first.pcr as number) : null;

  const sentBars = useMemo(() => [...intervals].reverse(), [intervals]);
  const sentTally = useMemo(() => {
    let bull = 0;
    let bear = 0;
    for (const b of sentBars) {
      if (b.sent.txt.startsWith("▲")) bull++;
      else if (b.sent.txt.startsWith("▼")) bear++;
    }
    return { bull, bear };
  }, [sentBars]);
  const sentSplit = useMemo(() => {
    const cats: { key: string; label: string; col: string }[] = [
      { key: "▲ Bullish", label: "bull", col: SENT_COL["▲ Bullish"] },
      { key: "▼ Bearish", label: "bear", col: SENT_COL["▼ Bearish"] },
      { key: "Put writing ↓", label: "put-wr ↓", col: SENT_COL["Put writing ↓"] },
      { key: "Call unwind ↑", label: "call-unw ↑", col: SENT_COL["Call unwind ↑"] },
      { key: "Neutral", label: "neutral", col: SENT_COL["Neutral"] },
    ];
    const total = sentBars.length || 1;
    return cats.map((c) => {
      const n = sentBars.filter((b) => b.sent.txt === c.key).length;
      return { ...c, n, pct: (n / total) * 100 };
    });
  }, [sentBars]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
        <span className="font-semibold uppercase tracking-wide">Trending OI</span>
        <SelectMenu
          value={symbol}
          options={symOptions.map((s) => [s, s] as [string, string])}
          onChange={(v) => selectSymbol(v, true)}
          title="Underlying"
          width={140}
        />
        {chain?.expiry && <span className="num">{chain.expiry}</span>}
        <span className="ml-1">Interval</span>
        <SelectMenu
          value={tf}
          options={[1, 3, 5, 15, 30, 60, 240, 1440].map(
            (m) => [m < 60 ? `${m}m` : m < 1440 ? `${m / 60}h` : "1D", m] as const
          )}
          onChange={setTf}
          title="Bucket interval"
        />
        {daily && (
          <span className="text-amber-400">
            {expiry ? "daily OI history · Upstox" : "pick an expiry for daily view"}
          </span>
        )}
        <span className="ml-auto">
          <span style={{ color: CE }}>■</span> Call OI Δ &nbsp;
          <span style={{ color: PE }}>■</span> Put OI Δ &nbsp;
          <span style={{ color: PCRC }}>■</span> PCR
        </span>
      </div>

      {/* compact stats strip — one line, freeing the rest for the chart */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel px-3 py-1 text-2xs">
        <Tile
          label="Call Δ"
          value={last ? oiCr(last.ce) : "–"}
          cls={last && last.ce >= 0 ? "text-down" : "text-up"}
        />
        <Tile
          label="Put Δ"
          value={last ? oiCr(last.pe) : "–"}
          cls={last && last.pe >= 0 ? "text-up" : "text-down"}
        />
        <Tile
          label={netOi >= 0 ? "Net +" : "Net −"}
          value={last ? oiCr(netOi) : "–"}
          cls={netOi >= 0 ? "text-term-text" : "text-amber-400"}
        />
        <Tile
          label="Bias"
          value={last ? oiCr(net) : "–"}
          cls={net >= 0 ? "text-up" : "text-down"}
        />
        <Tile
          label="PCR"
          value={pcrNow != null ? nf(pcrNow, 2) : "–"}
          cls={pcrNow != null ? (pcrNow >= 1 ? "text-up" : "text-down") : ""}
        />
        {pcrStats && (
          <span className="num text-[9px] text-term-dim">
            o{nf(pcrStats.open, 2)} l{nf(pcrStats.lo, 2)} h{nf(pcrStats.hi, 2)}
            {pcrDelta != null && (
              <span className={pcrDelta >= 0 ? " text-up" : " text-down"}>
                {" "}
                Δ{pcrDelta >= 0 ? "+" : ""}
                {nf(pcrDelta, 2)}
              </span>
            )}
          </span>
        )}
        <Tile
          label="Spot Δ"
          value={last ? `${priceChg >= 0 ? "+" : ""}${nf(priceChg, 1)}` : "–"}
          cls={priceChg >= 0 ? "text-up" : "text-down"}
        />
        {buildup && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${buildup.cls}`}
            title={buildup.note}
          >
            {buildup.txt}
          </span>
        )}
        {bias && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${bias.cls}`}>
            {bias.txt}
          </span>
        )}
        {sentBars.length > 0 && (
          <span className="flex items-center gap-1.5 text-[9px] text-term-dim">
            <span className="uppercase tracking-wide">Sent {tfLbl}</span>
            <span className="text-up">▲{sentTally.bull}</span>
            <span className="text-down">▼{sentTally.bear}</span>
            <span className="flex h-2 w-16 overflow-hidden rounded-sm bg-term-bg">
              {sentSplit.map(
                (sp) =>
                  sp.pct > 0 && (
                    <span
                      key={sp.key}
                      style={{ width: `${sp.pct}%`, background: sp.col }}
                      title={`${sp.label} · ${sp.n}`}
                    />
                  )
              )}
            </span>
          </span>
        )}
      </div>

      {/* chart -- a phone gives it a fixed height and scrolls the page (squeezed between the
          strips and the table it fell under the size it can draw at) */}
      <div ref={boxRef} className="relative h-[260px] shrink-0 overflow-hidden p-3 sm:h-auto sm:min-h-0 sm:flex-1 sm:shrink">
        {chart ?? (
          <div className="flex h-full items-center justify-center text-xs text-term-dim">
            {daily
              ? expiry
                ? `loading daily OI history for ${symbol}…`
                : "pick an expiry to use the 1D view"
              : `collecting OI history for ${symbol}… (needs a few snapshots)`}
          </div>
        )}
      </div>

      {/* recent intervals */}
      {intervals.length > 0 && (
        <div className="max-w-full shrink-0 border-t border-term-border px-1 pb-1 sm:max-h-[34%] sm:overflow-auto sm:p-2">
          {/* a phone: fitted to the screen width (tight padding), no sideways scroll, full
              length with the page scrolling and the header row sticking at the top */}
          <table className="w-full border-separate sm:min-w-[480px] border-spacing-0 border border-term-border text-2xs [&_td:last-child]:border-r-0 [&_td]:border-b [&_td]:border-r [&_td]:border-term-border/60 [&_th:last-child]:border-r-0 [&_th]:border-b [&_th]:border-r [&_th]:border-term-border">
            <thead className="sticky -top-px z-10 isolate will-change-transform bg-term-panel text-[10px] uppercase text-term-dim sm:top-0">
              <tr>
                <th className="bg-term-panel px-1 py-1 sm:px-3 text-left font-medium">
                  {daily ? "Date" : "Time"}
                </th>
                <th className="bg-term-panel px-1 py-1 sm:px-3 text-right font-medium">Call OI Δ</th>
                <th className="bg-term-panel px-1 py-1 sm:px-3 text-right font-medium">Put OI Δ</th>
                <th className="bg-term-panel px-1 py-1 sm:px-3 text-right font-medium">Spot Δ</th>
                <th className="bg-term-panel px-1 py-1 sm:px-3 text-left font-medium">Leader</th>
                <th className="bg-term-panel px-1 py-1 sm:px-3 text-left font-medium">Sentiment</th>
              </tr>
            </thead>
            <tbody>
              {intervals.map((r, i) => {
                const putLed = r.dpe > r.dce;
                return (
                  <tr key={r.t}>
                    <td className="num px-1 py-1 sm:px-3 text-term-dim">
                      {daily
                        ? new Date(r.t * 1000).toLocaleDateString("en-IN", {
                            day: "2-digit",
                            month: "short",
                          })
                        : new Date(r.t * 1000).toLocaleTimeString("en-IN", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                    </td>
                    <td
                      className="num px-1 py-1 sm:px-3 text-right"
                      style={{ color: CE }}
                    >
                      {r.dce >= 0 ? "+" : ""}
                      {oiCr(r.dce)}
                    </td>
                    <td
                      className="num px-1 py-1 sm:px-3 text-right"
                      style={{ color: PE }}
                    >
                      {r.dpe >= 0 ? "+" : ""}
                      {oiCr(r.dpe)}
                    </td>
                    <td
                      className={`num px-1 py-1 sm:px-3 text-right ${
                        r.dspot >= 0 ? "text-up" : "text-down"
                      }`}
                    >
                      {r.dspot >= 0 ? "+" : ""}
                      {nf(r.dspot, 1)}
                    </td>
                    <td
                      className={`px-1 py-1 sm:px-3 font-semibold ${
                        putLed ? "text-up" : "text-down"
                      }`}
                    >
                      {putLed ? "PUT" : "CALL"}
                    </td>
                    <td className="px-1 py-1 sm:px-3">
                      <span className={`whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-bold sm:px-1.5 ${r.sent.cls}`}>
                        {r.sent.txt}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, cls = "" }: { label: string; value: React.ReactNode; cls?: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[9px] uppercase tracking-wide text-term-dim">{label}</span>
      <span className={`num text-sm font-semibold ${cls}`}>{value}</span>
    </div>
  );
}
