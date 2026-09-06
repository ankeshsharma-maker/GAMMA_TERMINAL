import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { lakhs, nf } from "../lib/format";

type Pt = { t: number; spot: number; pcr: number | null; ce: number; pe: number };

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

/**
 * Trending OI (NiftyTrader-style): how the day's total Call-OI vs Put-OI
 * build-up has trended through the session, with PCR overlaid. Rising Put OI
 * faster than Call OI = put writing / support; the reverse = call writing /
 * resistance. Per-strike OI is on the "OI" tab (OI profile).
 */
export function TrendingOI() {
  const symbol = useStore((s) => s.symbol);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const chain = useStore((s) => s.chain);
  const symClass = useStore((s) => s.symClass);
  const symClassOk = useStore((s) => s.symClassOk);

  const [symChoices, setSymChoices] = useState<string[]>([]);
  const [pts, setPts] = useState<Pt[]>([]);
  const [tf, setTf] = useState(5); // interval-table bucket, minutes

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

  // price ↕ vs total-OI ↕ → the four classic OI states
  const buildup = useMemo(() => {
    if (!last || !first || pts.length < 3) return null;
    const pUp = priceChg >= 0;
    const oUp = netOi >= 0;
    if (pUp && oUp) return { txt: "LONG BUILDUP", cls: "bg-up text-white", note: "price ↑ · OI ↑" };
    if (!pUp && oUp) return { txt: "SHORT BUILDUP", cls: "bg-down text-white", note: "price ↓ · OI ↑" };
    if (!pUp && !oUp)
      return { txt: "LONG UNWINDING", cls: "bg-amber-500 text-white", note: "price ↓ · OI ↓" };
    return { txt: "SHORT COVERING", cls: "bg-sky-500 text-white", note: "price ↑ · OI ↓" };
  }, [last, first, priceChg, netOi, pts.length]);

  // ---- svg chart ----
  const chart = useMemo(() => {
    const W = 1000;
    const H = 340;
    const pad = { l: 52, r: 52, t: 14, b: 24 };
    if (pts.length < 2) return null;
    const ts = pts.map((p) => p.t);
    const t0 = ts[0];
    const t1 = ts[ts.length - 1] || t0 + 1;
    const vals = pts.flatMap((p) => [p.ce, p.pe, 0]);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const padY = (hi - lo) * 0.12 || 1;
    lo -= padY;
    hi += padY;
    const pcrs = pts.map((p) => p.pcr ?? 1);
    let plo = Math.min(...pcrs, 1);
    let phi = Math.max(...pcrs, 1);
    const pPad = (phi - plo) * 0.2 || 0.1;
    plo -= pPad;
    phi += pPad;

    const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
    const yp = (v: number) => pad.t + (1 - (v - plo) / (phi - plo || 1)) * (H - pad.t - pad.b);
    const line = (sel: (p: Pt) => number) =>
      pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(sel(p)).toFixed(1)}`).join(" ");
    const cePath = line((p) => p.ce);
    const pePath = line((p) => p.pe);
    const pcrPath = pts
      .map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${yp(p.pcr ?? 1).toFixed(1)}`)
      .join(" ");
    const y0 = y(0);
    const fmtT = (t: number) =>
      daily
        ? new Date(t * 1000).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
        : new Date(t * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    const vGrid = [hi, (hi + lo) / 2, 0, lo].filter((v, i, a) => a.indexOf(v) === i);

    return (
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        {vGrid.map((v, i) => (
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
            <text x={6} y={y(v) + 3} fontSize={11} className="fill-term-dim">
              {lakhs(v)}
            </text>
          </g>
        ))}
        {[t0, (t0 + t1) / 2, t1].map((t, i) => (
          <text
            key={i}
            x={x(t)}
            y={H - 6}
            fontSize={11}
            textAnchor="middle"
            className="fill-term-dim"
          >
            {fmtT(t)}
          </text>
        ))}
        {/* right axis: PCR */}
        {[plo + (phi - plo) * 0.15, (plo + phi) / 2, phi - (phi - plo) * 0.15].map((v, i) => (
          <text
            key={"p" + i}
            x={W - pad.r + 6}
            y={yp(v) + 3}
            fontSize={10}
            className="fill-amber-400/80"
          >
            {nf(v, 2)}
          </text>
        ))}
        <path d={`${cePath} L${x(t1)},${y0} L${x(t0)},${y0} Z`} fill={CE} fillOpacity={0.1} />
        <path d={`${pePath} L${x(t1)},${y0} L${x(t0)},${y0} Z`} fill={PE} fillOpacity={0.1} />
        <path d={pcrPath} fill="none" stroke={PCRC} strokeWidth={1.25} strokeOpacity={0.85} />
        <path d={cePath} fill="none" stroke={CE} strokeWidth={2} />
        <path d={pePath} fill="none" stroke={PE} strokeWidth={2} />
        {last && (
          <>
            <circle cx={x(last.t)} cy={y(last.ce)} r={3} fill={CE} />
            <circle cx={x(last.t)} cy={y(last.pe)} r={3} fill={PE} />
          </>
        )}
      </svg>
    );
  }, [pts, last]);

  // ---- recent intervals, bucketed to the chosen timeframe ----
  const intervals = useMemo(() => {
    if (pts.length < 2) return [];
    const w = tf * 60;
    // last snapshot in each tf-wide bucket
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
      // sentiment: net OI flow (put writing bullish, call writing bearish)
      // confirmed / contradicted by the price move over the bucket
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

  // ---- PCR value + mini trend (left half of the side-by-side row) ----
  const pcrNow = last?.pcr ?? null;
  const pcrStats = useMemo(() => {
    const v = pts.map((p) => p.pcr).filter((x): x is number => x != null);
    if (!v.length) return null;
    return { open: v[0], lo: Math.min(...v), hi: Math.max(...v) };
  }, [pts]);
  const pcrSpark = useMemo(() => {
    const v = pts.filter((p) => p.pcr != null);
    if (v.length < 2) return null;
    const W = 300;
    const H = 92;
    const pad = 6;
    const t0 = v[0].t;
    const t1 = v[v.length - 1].t || t0 + 1;
    const ys = v.map((p) => p.pcr as number);
    let lo = Math.min(...ys, 1);
    let hi = Math.max(...ys, 1);
    const pd = (hi - lo) * 0.15 || 0.1;
    lo -= pd;
    hi += pd;
    const X = (t: number) => pad + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * pad);
    const Y = (val: number) => pad + (1 - (val - lo) / (hi - lo || 1)) * (H - 2 * pad);
    const d = v
      .map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.pcr as number).toFixed(1)}`)
      .join(" ");
    const lastV = ys[ys.length - 1];
    return (
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        {lo < 1 && hi > 1 && (
          <line
            x1={0}
            x2={W}
            y1={Y(1)}
            y2={Y(1)}
            stroke={PCRC}
            strokeOpacity={0.5}
            strokeDasharray="4 3"
          />
        )}
        <path
          d={`${d} L${X(t1)},${H} L${X(t0)},${H} Z`}
          fill={lastV >= 1 ? PE : CE}
          fillOpacity={0.1}
        />
        <path d={d} fill="none" stroke={PCRC} strokeWidth={1.75} />
        <circle cx={X(t1)} cy={Y(lastV)} r={2.5} fill={PCRC} />
      </svg>
    );
  }, [pts]);

  // ---- sentiment column chart (right half of the side-by-side row) ----
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
  const sentChart = useMemo(() => {
    if (sentBars.length < 1) return null;
    const W = 320;
    const H = 92;
    const n = sentBars.length;
    const gap = 2;
    const bw = Math.max(2, (W - gap * n) / n);
    const mags = sentBars.map((b) => Math.abs(b.dpe - b.dce));
    const mx = Math.max(...mags, 1);
    const midY = H / 2;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        <line
          x1={0}
          x2={W}
          y1={midY}
          y2={midY}
          stroke="currentColor"
          strokeOpacity={0.3}
          className="text-term-dim"
        />
        {sentBars.map((b, i) => {
          const h = (Math.abs(b.dpe - b.dce) / mx) * (H / 2 - 4);
          const bull = b.dpe >= b.dce;
          const x = i * (bw + gap);
          const col = SENT_COL[b.sent.txt] ?? "#3b4657";
          return (
            <rect
              key={i}
              x={x}
              width={bw}
              y={bull ? midY - Math.max(1, h) : midY}
              height={Math.max(1, h)}
              fill={col}
            >
              <title>
                {daily
                  ? new Date(b.t * 1000).toLocaleDateString("en-IN", {
                      day: "2-digit",
                      month: "short",
                    })
                  : new Date(b.t * 1000).toLocaleTimeString("en-IN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                · {b.sent.txt}
              </title>
            </rect>
          );
        })}
      </svg>
    );
  }, [sentBars, daily]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
        <span className="font-semibold uppercase tracking-wide">Trending OI</span>
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
        {chain?.expiry && <span className="num">{chain.expiry}</span>}
        <span className="ml-1">Interval</span>
        <div className="seg">
          {([1, 3, 5, 15, 30, 60, 240, 1440] as const).map((m) => (
            <button key={m} onClick={() => setTf(m)} className={tf === m ? "on" : ""}>
              {m < 60 ? `${m}m` : m < 1440 ? `${m / 60}h` : "1D"}
            </button>
          ))}
        </div>
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

      {/* live readout */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-term-border bg-term-panel px-3 py-1.5 text-2xs">
        <Tile label="Call OI Δ" value={last ? lakhs(last.ce) : "–"} cls={last && last.ce >= 0 ? "text-down" : "text-up"} />
        <Tile label="Put OI Δ" value={last ? lakhs(last.pe) : "–"} cls={last && last.pe >= 0 ? "text-up" : "text-down"} />
        <Tile
          label={netOi >= 0 ? "Net OI added" : "Net OI reduced"}
          value={last ? lakhs(netOi) : "–"}
          cls={netOi >= 0 ? "text-term-text" : "text-amber-400"}
        />
        <Tile
          label="Bias (PE − CE)"
          value={last ? lakhs(net) : "–"}
          cls={net >= 0 ? "text-up" : "text-down"}
        />
        <Tile
          label="PCR"
          value={last?.pcr != null ? nf(last.pcr, 2) : "–"}
          cls={last?.pcr != null ? (last.pcr >= 1 ? "text-up" : "text-down") : ""}
        />
        <Tile
          label="Spot Δ (session)"
          value={last ? `${priceChg >= 0 ? "+" : ""}${nf(priceChg, 1)}` : "–"}
          cls={priceChg >= 0 ? "text-up" : "text-down"}
        />
        {buildup && (
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${buildup.cls}`}
            title={buildup.note}
          >
            {buildup.txt}
          </span>
        )}
        {bias && (
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${bias.cls}`}>{bias.txt}</span>
        )}
      </div>

      {/* PCR value + sentiment chart, side by side */}
      {(pcrSpark || sentChart) && (
        <div className="grid h-[116px] shrink-0 grid-cols-2 divide-x divide-term-border border-b border-term-border bg-term-panel">
          {/* PCR */}
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="flex shrink-0 flex-col leading-tight">
              <span className="text-[9px] uppercase tracking-wide text-term-dim">PCR</span>
              <span
                className={`num text-2xl font-bold ${
                  pcrNow != null ? (pcrNow >= 1 ? "text-up" : "text-down") : "text-term-dim"
                }`}
              >
                {pcrNow != null ? nf(pcrNow, 2) : "–"}
              </span>
              <span className="text-[10px] text-term-dim">
                {pcrNow != null
                  ? pcrNow >= 1
                    ? "put-heavy · supportive"
                    : "call-heavy · heavy"
                  : "collecting…"}
              </span>
              {pcrStats && (
                <span className="num mt-0.5 text-[9px] text-term-dim">
                  o {nf(pcrStats.open, 2)} · lo {nf(pcrStats.lo, 2)} · hi {nf(pcrStats.hi, 2)}
                </span>
              )}
            </div>
            <div className="min-h-0 min-w-0 flex-1 self-stretch">{pcrSpark}</div>
          </div>

          {/* Sentiment */}
          <div className="flex flex-col px-3 py-2">
            <div className="flex items-center justify-between text-[9px] uppercase tracking-wide text-term-dim">
              <span>Sentiment · {tfLbl} buckets</span>
              <span className="normal-case">
                <span className="text-up">▲ {sentTally.bull}</span>{" "}
                <span className="text-down">▼ {sentTally.bear}</span>
              </span>
            </div>
            <div className="min-h-0 flex-1">
              {sentChart ?? (
                <div className="flex h-full items-center justify-center text-[10px] text-term-dim">
                  need a few buckets
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-x-2 text-[8px] text-term-dim">
              <span><span style={{ color: SENT_COL["▲ Bullish"] }}>■</span> bull</span>
              <span><span style={{ color: SENT_COL["▼ Bearish"] }}>■</span> bear</span>
              <span><span style={{ color: SENT_COL["Put writing ↓"] }}>■</span> put-wr ↓</span>
              <span><span style={{ color: SENT_COL["Call unwind ↑"] }}>■</span> call-unw ↑</span>
            </div>
          </div>
        </div>
      )}

      {/* chart */}
      <div className="min-h-0 flex-1 p-3">
        {chart ?? (
          <div className="flex h-full items-center justify-center text-xs text-term-dim">
            {daily ? (expiry ? `loading daily OI history for ${symbol}…` : "pick an expiry to use the 1D view") : `collecting OI history for ${symbol}… (needs a few snapshots)`}
          </div>
        )}
      </div>

      {/* recent intervals */}
      {intervals.length > 0 && (
        <div className="max-h-[34%] shrink-0 overflow-y-auto border-t border-term-border">
          <table className="w-full border-separate border-spacing-0 text-2xs">
            <thead className="sticky top-0 bg-term-panel text-[10px] uppercase text-term-dim">
              <tr>
                <th className="border-b border-term-border px-3 py-1 text-left font-medium">{daily ? "Date" : "Time"}</th>
                <th className="border-b border-term-border px-3 py-1 text-right font-medium">Call OI Δ</th>
                <th className="border-b border-term-border px-3 py-1 text-right font-medium">Put OI Δ</th>
                <th className="border-b border-term-border px-3 py-1 text-right font-medium">Spot Δ</th>
                <th className="border-b border-term-border px-3 py-1 text-left font-medium">Leader</th>
                <th className="border-b border-term-border px-3 py-1 text-left font-medium">Sentiment</th>
              </tr>
            </thead>
            <tbody>
              {intervals.map((r, i) => {
                const putLed = r.dpe > r.dce;
                return (
                  <tr key={i}>
                    <td className="num border-b border-term-border/40 px-3 py-1 text-term-dim">
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
                    <td className="num border-b border-term-border/40 px-3 py-1 text-right" style={{ color: CE }}>
                      {r.dce >= 0 ? "+" : ""}
                      {lakhs(r.dce)}
                    </td>
                    <td className="num border-b border-term-border/40 px-3 py-1 text-right" style={{ color: PE }}>
                      {r.dpe >= 0 ? "+" : ""}
                      {lakhs(r.dpe)}
                    </td>
                    <td
                      className={`num border-b border-term-border/40 px-3 py-1 text-right ${
                        r.dspot >= 0 ? "text-up" : "text-down"
                      }`}
                    >
                      {r.dspot >= 0 ? "+" : ""}
                      {nf(r.dspot, 1)}
                    </td>
                    <td
                      className={`border-b border-term-border/40 px-3 py-1 font-semibold ${
                        putLed ? "text-up" : "text-down"
                      }`}
                    >
                      {putLed ? "PUT" : "CALL"}
                    </td>
                    <td className="border-b border-term-border/40 px-3 py-1">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${r.sent.cls}`}>
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
