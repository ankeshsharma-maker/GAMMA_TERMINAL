import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { lakhs, nf } from "../lib/format";

type Pt = { t: number; spot: number; pcr: number | null; ce: number; pe: number };

const CE = "#f87171"; // call OI  — red
const PE = "#4ade80"; // put OI   — green
const PCRC = "#eab308"; // pcr     — amber

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

  useEffect(() => {
    let alive = true;
    const load = () =>
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
        // keep the current session only (last point back ~10h)
        const cut = raw.length ? raw[raw.length - 1].t - 10 * 3600 : 0;
        setPts(raw.filter((p) => p.t >= cut));
      }, () => {});
    load();
    const id = window.setInterval(load, 15000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [symbol]);

  const last = pts[pts.length - 1];
  const first = pts[0];
  const net = last ? last.pe - last.ce : 0; // >0 => puts adding faster
  const netOi = last ? last.ce + last.pe : 0; // total OI added(+) / reduced(-) today
  const priceChg = last && first ? last.spot - first.spot : 0;

  const bias = useMemo(() => {
    if (!last) return null;
    const scale = Math.max(Math.abs(last.ce), Math.abs(last.pe), 1);
    const r = net / scale;
    if (r > 0.08) return { txt: "PUT WRITING → supportive", cls: "bg-up text-white" };
    if (r < -0.08) return { txt: "CALL WRITING → resistance", cls: "bg-down text-white" };
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
      new Date(t * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
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
        txt = "Bullish";
        cls = "bg-up/20 text-up";
      } else if (flow < 0 && dspot <= 0) {
        txt = "Bearish";
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
          {([1, 3, 5, 15, 30, 60, 240] as const).map((m) => (
            <button key={m} onClick={() => setTf(m)} className={tf === m ? "on" : ""}>
              {m < 60 ? `${m}m` : `${m / 60}h`}
            </button>
          ))}
        </div>
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

      {/* chart */}
      <div className="min-h-0 flex-1 p-3">
        {chart ?? (
          <div className="flex h-full items-center justify-center text-xs text-term-dim">
            collecting OI history for {symbol}… (needs a few snapshots)
          </div>
        )}
      </div>

      {/* recent intervals */}
      {intervals.length > 0 && (
        <div className="max-h-[34%] shrink-0 overflow-y-auto border-t border-term-border">
          <table className="w-full border-separate border-spacing-0 text-2xs">
            <thead className="sticky top-0 bg-term-panel text-[10px] uppercase text-term-dim">
              <tr>
                <th className="border-b border-term-border px-3 py-1 text-left font-medium">Time</th>
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
                      {new Date(r.t * 1000).toLocaleTimeString("en-IN", {
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
