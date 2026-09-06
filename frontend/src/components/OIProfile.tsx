import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { compact, lakhs, nf, sk } from "../lib/format";
import type { ChainRow } from "../types";

type Metric = "oi" | "chg" | "combined";

// total OI = dark saturated; OI added = light tint; OI reduced = a contrasting hue (amber / sky)
const CALL_OI = "#b91c1c"; // dark red    — total Call OI
const PUT_OI = "#15803d"; // dark green   — total Put OI
const CALL_ADD = "rgba(248,113,113,0.9)"; // light red   — Call OI added
const PUT_ADD = "rgba(74,222,128,0.9)"; // light green  — Put OI added
const CALL_CUT = "#f59e0b"; // amber      — Call OI reduced
const PUT_CUT = "#38bdf8"; // sky         — Put OI reduced

const zClamp = (z: number) => Math.min(3, Math.max(0.5, z));
// "OI added" fill — flat (no gradient)
const addGrad = (c: string) => c;

export function OIProfile() {
  const chain = useStore((s) => s.chain);
  const chainError = useStore((s) => s.chainError);
  const symbol = useStore((s) => s.symbol);
  const expiry = useStore((s) => s.expiry) ?? chain?.expiry ?? "";
  const selectSymbol = useStore((s) => s.selectSymbol);
  const selectExpiry = useStore((s) => s.selectExpiry);
  const symClass = useStore((s) => s.symClass);
  const symClassOk = useStore((s) => s.symClassOk);

  const [metric, setMetric] = useState<Metric>("combined");
  const [layout, setLayout] = useState<"chart" | "pcr">("chart");
  const [pcrPts, setPcrPts] = useState<{ t: number; pcr: number; spot: number }[]>([]);
  const [count, setCount] = useState(10);
  const [symChoices, setSymChoices] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [tf, setTf] = useState(5); // minutes; 0 = change since day open
  const [win, setWin] = useState<Record<string, { ceOiChg: number; peOiChg: number }>>({});
  const [winCov, setWinCov] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const didCenter = useRef(false);

  const AREA = Math.round(240 * zoom);
  const COLW = Math.round(40 * zoom);
  const BARW = Math.max(5, Math.round(14 * zoom));

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
    [symChoices, symbol, symClass]
  );

  // rolling-window OI change (polls the backend snapshot series)
  useEffect(() => {
    if (tf === 0 || !chain) {
      setWin({});
      setWinCov(0);
      return;
    }
    let alive = true;
    const load = () =>
      api.oiChange(symbol, expiry || undefined, tf).then(
        (d) => {
          if (!alive) return;
          const m: Record<string, { ceOiChg: number; peOiChg: number }> = {};
          for (const [k, v] of Object.entries(d.strikes))
            m[k] = { ceOiChg: v.ceOiChg, peOiChg: v.peOiChg };
          setWin(m);
          setWinCov(d.coverageMin);
        },
        () => {}
      );
    load();
    const id = window.setInterval(load, 20000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [tf, symbol, expiry, chain?.symbol, chain?.expiry]);

  // session PCR series for the PCR chart
  useEffect(() => {
    if (layout !== "pcr" || !symbol) return;
    let alive = true;
    const load = () =>
      api.history(symbol).then(
        (d) => {
          if (!alive) return;
          setPcrPts(
            d.points
              .filter((p) => p.pcr != null)
              .map((p) => ({ t: p.t, pcr: p.pcr as number, spot: p.spot }))
          );
        },
        () => {}
      );
    load();
    const id = window.setInterval(load, 20000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [layout, symbol]);

  const rows = useMemo<ChainRow[]>(() => {
    if (!chain) return [];
    let atm = chain.rows.findIndex((r) => r.strike === chain.atmStrike);
    if (atm < 0) atm = Math.floor(chain.rows.length / 2);
    return chain.rows.slice(Math.max(0, atm - count), atm + count + 1);
  }, [chain, count]);

  const dCE = (r: ChainRow) =>
    tf === 0 ? r.call.oiChg : win[String(Math.round(r.strike))]?.ceOiChg ?? 0;
  const dPE = (r: ChainRow) =>
    tf === 0 ? r.put.oiChg : win[String(Math.round(r.strike))]?.peOiChg ?? 0;

  const stats = useMemo(() => {
    let maxOI = 1;
    let maxCallOI = { v: -1, k: -1 };
    let maxPutOI = { v: -1, k: -1 };
    for (const r of rows) {
      maxOI = Math.max(maxOI, r.call.oi, r.put.oi);
      if (r.call.oi > maxCallOI.v) maxCallOI = { v: r.call.oi, k: r.strike };
      if (r.put.oi > maxPutOI.v) maxPutOI = { v: r.put.oi, k: r.strike };
    }
    return { maxOI, resistance: maxCallOI.k, floor: maxPutOI.k };
  }, [rows]);

  // total Call / Put OI across the visible strike window (for the donut)
  const oiTotals = useMemo(() => {
    let ce = 0, pe = 0;
    for (const r of rows) {
      ce += r.call.oi || 0;
      pe += r.put.oi || 0;
    }
    return { ce, pe, pcr: ce ? pe / ce : null };
  }, [rows]);

  const flow = useMemo(() => {
    let ceAdd = 0, ceCut = 0, peAdd = 0, peCut = 0, maxChg = 1;
    for (const r of rows) {
      const c = tf === 0 ? r.call.oiChg : win[String(Math.round(r.strike))]?.ceOiChg ?? 0;
      const p = tf === 0 ? r.put.oiChg : win[String(Math.round(r.strike))]?.peOiChg ?? 0;
      maxChg = Math.max(maxChg, Math.abs(c), Math.abs(p));
      if (c >= 0) ceAdd += c; else ceCut += c;
      if (p >= 0) peAdd += p; else peCut += p;
    }
    return { ceAdd, ceCut, peAdd, peCut, maxChg };
  }, [rows, win, tf]);

  // gamma-flip: strike where cumulative dealer gamma exposure crosses zero.
  // Dealer gamma proxy per strike = putGamma·putOI − callGamma·callOI (dealers long puts / short calls
  // from customer flow). Below the flip dealers are short gamma (moves amplified), above it long gamma.
  const gammaFlip = useMemo(() => {
    if (rows.length < 2) return null;
    let cum = 0;
    let prev = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      prev = cum;
      cum += (r.put.gamma ?? 0) * (r.put.oi ?? 0) - (r.call.gamma ?? 0) * (r.call.oi ?? 0);
      if (i > 0 && prev !== 0 && Math.sign(cum) !== Math.sign(prev)) {
        const t = Math.abs(prev) / (Math.abs(prev) + Math.abs(cum) || 1);
        const k0 = rows[i - 1].strike;
        return { strike: k0 + (r.strike - k0) * t, index: i - 1 + t };
      }
    }
    return null;
  }, [rows]);

  // current spot / close: fractional column index for a vertical marker line
  const spotMark = useMemo(() => {
    if (!chain || rows.length < 2) return null;
    const sp = chain.liveSpot?.ltp ?? chain.spot;
    if (sp <= rows[0].strike) return { index: 0, spot: sp };
    if (sp >= rows[rows.length - 1].strike) return { index: rows.length - 1, spot: sp };
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i].strike;
      const b = rows[i + 1].strike;
      if (sp >= a && sp <= b) return { index: i + (sp - a) / (b - a || 1), spot: sp };
    }
    return null;
  }, [rows, chain]);

  // ---- overall OI-analysis verdict (bullish / bearish / neutral) ----
  const verdict = useMemo(() => {
    if (!chain) return null;
    const spotNow = chain.liveSpot?.ltp ?? chain.spot;
    const pcr = chain.pcr;
    const putBuild = flow.peAdd;
    const callBuild = flow.ceAdd;
    const callUnwind = -flow.ceCut;
    const putUnwind = -flow.peCut;
    let score = 0;
    const pros: string[] = [];
    const cons: string[] = [];

    if (pcr != null) {
      if (pcr >= 1.2) { score += 2; pros.push(`PCR ${pcr.toFixed(2)} (put-heavy)`); }
      else if (pcr <= 0.8) { score -= 2; cons.push(`PCR ${pcr.toFixed(2)} (call-heavy)`); }
    }
    if (putBuild > callBuild * 1.15 && putBuild > 0) {
      score += 2; pros.push("Put writing > Call writing — support building");
    } else if (callBuild > putBuild * 1.15 && callBuild > 0) {
      score -= 2; cons.push("Call writing > Put writing — resistance building");
    }
    if (callUnwind > putUnwind * 1.25 && callUnwind > 0) {
      score += 1; pros.push("Call OI unwinding — resistance easing");
    } else if (putUnwind > callUnwind * 1.25 && putUnwind > 0) {
      score -= 1; cons.push("Put OI unwinding — support easing");
    }
    if (chain.maxPain) {
      if (spotNow < chain.maxPain * 0.997) { score += 1; pros.push(`Spot under Max Pain ${sk(chain.maxPain)}`); }
      else if (spotNow > chain.maxPain * 1.003) { score -= 1; cons.push(`Spot over Max Pain ${sk(chain.maxPain)}`); }
    }
    if (stats.floor && stats.resistance) {
      const room = (stats.resistance - spotNow) - (spotNow - stats.floor);
      if (room > (chain.strikeStep || 50)) { score += 1; pros.push(`More room to the wall (${sk(stats.resistance)}) than the floor (${sk(stats.floor)})`); }
      else if (room < -(chain.strikeStep || 50)) { score -= 1; cons.push(`Closer to the wall (${sk(stats.resistance)}) than the floor (${sk(stats.floor)})`); }
    }
    const bias = score >= 2 ? "BULLISH" : score <= -2 ? "BEARISH" : "NEUTRAL";
    return { bias, score, pros, cons };
  }, [chain, flow, stats]);

  useEffect(() => {
    didCenter.current = false;
  }, [chain?.symbol, chain?.expiry, count]);
  useEffect(() => {
    if (didCenter.current || !scrollRef.current || rows.length === 0 || !chain)
      return;
    const i = rows.findIndex((r) => r.strike === chain.atmStrike);
    if (i >= 0) {
      const el = scrollRef.current;
      el.scrollLeft = i * COLW - el.clientWidth / 2 + COLW / 2;
      didCenter.current = true;
    }
  }, [rows, chain, COLW, layout]);

  if (chainError && !chain)
    return <div className="flex h-full items-center justify-center p-8 text-sm text-down">{chainError}</div>;
  if (!chain)
    return <div className="flex h-full items-center justify-center text-term-dim">loading…</div>;

  const spot = chain.liveSpot?.ltp ?? chain.spot;
  const oiMax = stats.maxOI;
  const chgMax = flow.maxChg;

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom((z) => zClamp(z * (e.deltaY < 0 ? 1.12 : 0.89)));
  };

  const Sw = ({ c }: { c: string }) => (
    <span className="inline-block h-2.5 w-3.5 rounded-sm align-middle" style={{ background: c }} />
  );

  // ---- the horizontal column chart ----
  const TAG = 20; // px: WALL/FLOOR tag row (h-4) + pt-1 above the plot
  const LBL = 56; // px: rotated strike-label strip (h-14) below the plot
  const diverging = metric === "chg";
  // Y-axis tick values + their pixel offset from the container's bottom edge
  const axisTicks = (diverging
    ? [1, 0.5, 0, -0.5, -1].map((f) => ({ v: f * chgMax, mid: true }))
    : [1, 0.75, 0.5, 0.25, 0].map((f) => ({ v: f * oiMax, mid: false }))
  ).map(({ v }) => ({
    v,
    bottom: diverging
      ? LBL + AREA / 2 + (v / (chgMax || 1)) * (AREA / 2)
      : LBL + (v / (oiMax || 1)) * AREA,
  }));

  const PLOT_H = TAG + AREA + LBL;
  const chartEl = (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="flex items-end" style={{ minHeight: "100%" }}>
        {/* Y axis — OI (or ΔOI) values */}
        <div
          className="relative w-12 shrink-0 border-r border-term-border/60"
          style={{ height: PLOT_H }}
        >
          {axisTicks.map((t, i) => (
            <div
              key={i}
              className="absolute right-1 translate-y-1/2 text-[9px] leading-none text-term-dim"
              style={{ bottom: t.bottom }}
            >
              {diverging && t.v > 0 ? "+" : ""}
              {compact(t.v)}
            </div>
          ))}
          <div className="absolute right-1 text-[8px] uppercase tracking-wide text-term-dim" style={{ bottom: LBL - 12 }}>
            {diverging ? "ΔOI" : "OI"}
          </div>
        </div>

        {/* scrollable bars */}
        <div ref={scrollRef} onWheel={onWheel} className="min-w-0 flex-1 overflow-x-auto">
      <div
        className="relative flex items-end border border-term-border bg-term-panel/30"
        style={{ minWidth: rows.length * COLW, height: PLOT_H }}
      >
        {axisTicks.map((t, i) => (
          <div
            key={"g" + i}
            className="pointer-events-none absolute inset-x-0 border-t border-term-border/25"
            style={{ bottom: t.bottom }}
          />
        ))}
        {gammaFlip && (
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-10 border-l-2 border-dashed border-fuchsia-400"
            style={{ left: 12 + gammaFlip.index * COLW + COLW / 2 }}
            title={`Gamma flip ≈ ${sk(gammaFlip.strike)}`}
          >
            <span className="absolute -top-0 left-1 whitespace-nowrap rounded-sm bg-fuchsia-500 px-1 text-[8px] font-bold text-white">
              γ-flip {sk(gammaFlip.strike)}
            </span>
          </div>
        )}
        {spotMark && (
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-20 border-l-2 border-sky-400"
            style={{ left: 12 + spotMark.index * COLW + COLW / 2 }}
            title={`Spot / close ${nf(spotMark.spot, 1)}`}
          >
            <span className="absolute bottom-0 left-1 whitespace-nowrap rounded-sm bg-sky-500 px-1 text-[8px] font-bold text-white">
              ● spot {nf(spotMark.spot, 1)}
            </span>
          </div>
        )}
        {rows.map((r) => {
          const isATM = r.strike === chain.atmStrike;
          const isRes = r.strike === stats.resistance;
          const isFloor = r.strike === stats.floor;
          const near = Math.abs(r.strike - spot) < (chain.strikeStep || 50) * 0.5;
          const cChg = dCE(r);
          const pChg = dPE(r);
          const cCol = cChg >= 0 ? CALL_ADD : CALL_CUT;
          const pCol = pChg >= 0 ? PUT_ADD : PUT_CUT;

          let content: React.ReactNode;
          if (metric === "oi") {
            content = (
              <div className="flex items-end justify-center gap-[3px]" style={{ height: AREA }}>
                <div
                  title={`Call OI ${compact(r.call.oi)} @ ${r.strike}`}
                  className="rounded-t-sm"
                  style={{ width: BARW, height: (r.call.oi / oiMax) * AREA, background: CALL_OI }}
                />
                <div
                  title={`Put OI ${compact(r.put.oi)} @ ${r.strike}`}
                  className="rounded-t-sm"
                  style={{ width: BARW, height: (r.put.oi / oiMax) * AREA, background: PUT_OI }}
                />
              </div>
            );
          } else if (metric === "chg") {
            const half = AREA / 2;
            const cH = (Math.abs(cChg) / chgMax) * half;
            const pH = (Math.abs(pChg) / chgMax) * half;
            const col = (up: boolean, h: number, color: string, label: string, delta: number) => (
              <div className="flex flex-col" style={{ width: BARW, height: AREA }}>
                <div className="flex flex-1 items-end justify-center">
                  {up && (
                    <div
                      title={`${label} +${compact(delta)}`}
                      className="rounded-t-sm"
                      style={{ width: BARW, height: Math.max(h > 0 ? 2 : 0, h), background: addGrad(color) }}
                    />
                  )}
                </div>
                <div className="flex flex-1 items-start justify-center">
                  {!up && (
                    <div
                      title={`${label} ${compact(delta)}`}
                      className="rounded-b-sm"
                      style={{ width: BARW, height: Math.max(h > 0 ? 2 : 0, h), background: color }}
                    />
                  )}
                </div>
              </div>
            );
            content = (
              <div className="relative flex justify-center gap-[3px]" style={{ height: AREA }}>
                <div className="absolute inset-x-0 border-t border-term-dim/60" style={{ top: half }} />
                {col(cChg >= 0, cH, cCol, "Call ΔOI", cChg)}
                {col(pChg >= 0, pH, pCol, "Put ΔOI", pChg)}
              </div>
            );
          } else {
            const cOIh = (r.call.oi / oiMax) * AREA;
            const pOIh = (r.put.oi / oiMax) * AREA;
            const cCapH = Math.min(cOIh, (Math.abs(cChg) / oiMax) * AREA);
            const pCapH = Math.min(pOIh, (Math.abs(pChg) / oiMax) * AREA);
            const seg = (
              oiH: number,
              capH: number,
              base: string,
              cap: string,
              added: boolean,
              title: string
            ) => (
              <div
                title={title}
                className="flex flex-col justify-end rounded-t-sm"
                style={{ width: BARW, height: oiH, background: base }}
              >
                <div
                  className="rounded-t-sm"
                  style={{ height: capH, background: added ? addGrad(cap) : cap }}
                />
              </div>
            );
            content = (
              <div className="flex items-end justify-center gap-[3px]" style={{ height: AREA }}>
                {seg(cOIh, cCapH, CALL_OI, cCol, cChg >= 0, `Call OI ${compact(r.call.oi)} · Δ ${compact(cChg)}`)}
                {seg(pOIh, pCapH, PUT_OI, pCol, pChg >= 0, `Put OI ${compact(r.put.oi)} · Δ ${compact(pChg)}`)}
              </div>
            );
          }

          return (
            <div
              key={r.strike}
              className={`flex flex-col items-center border-r border-term-border/40 last:border-r-0 ${
                isRes
                  ? "bg-down/10 ring-1 ring-inset ring-down/50"
                  : isFloor
                  ? "bg-up/10 ring-1 ring-inset ring-up/50"
                  : isATM
                  ? "bg-term-accent/10"
                  : ""
              }`}
              style={{ width: COLW }}
            >
              <div className="flex h-4 w-full items-end justify-center">
                {isRes && (
                  <span className="whitespace-nowrap rounded-sm bg-down px-1 text-[8px] font-bold leading-tight text-white">
                    WALL
                  </span>
                )}
                {isFloor && (
                  <span className="whitespace-nowrap rounded-sm bg-up px-1 text-[8px] font-bold leading-tight text-white">
                    FLOOR
                  </span>
                )}
              </div>
              <div className="w-full pt-1">{content}</div>
              <div className="flex h-14 w-full items-center justify-center border-t border-term-border/60 bg-term-panel/40">
                <div
                  className={`num -rotate-90 whitespace-nowrap text-[10px] leading-none ${
                    isRes
                      ? "font-bold text-down"
                      : isFloor
                      ? "font-bold text-up"
                      : isATM || near
                      ? "font-bold text-term-accent"
                      : "text-term-dim"
                  }`}
                >
                  {sk(r.strike)}
                </div>
              </div>
            </div>
          );
        })}
          </div>
        </div>
      </div>
    </div>
  );

  // ---- OI split donut (total Call vs Put OI over the visible strike window) ----
  const donutEl = (() => {
    const { ce, pe, pcr } = oiTotals;
    const tot = ce + pe;
    if (tot <= 0) return null;
    const R = 42;
    const SW = 16;
    const C = 2 * Math.PI * R;
    const ceLen = (ce / tot) * C;
    const fAdd = flow.ceAdd + flow.peAdd;
    return (
      <div className="flex w-40 shrink-0 flex-col items-center gap-2 border-r border-term-border/60 p-3">
        <div className="text-center text-[10px] font-semibold uppercase tracking-wide text-term-dim">
          OI split · {count}±ATM
        </div>
        <svg viewBox="0 0 100 100" className="w-28">
          <circle cx="50" cy="50" r={R} fill="none" stroke="#1e2733" strokeWidth={SW} />
          {/* put arc (full ring) then call arc on top */}
          <circle
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke={PUT_OI}
            strokeWidth={SW}
            strokeDasharray={`${C} ${C}`}
            transform="rotate(-90 50 50)"
          />
          <circle
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke={CALL_OI}
            strokeWidth={SW}
            strokeDasharray={`${ceLen.toFixed(1)} ${C}`}
            transform="rotate(-90 50 50)"
          />
          <text x="50" y="47" textAnchor="middle" className="fill-term-text" fontSize="15" fontWeight="700">
            {pcr != null ? nf(pcr, 2) : "–"}
          </text>
          <text x="50" y="60" textAnchor="middle" className="fill-term-dim" fontSize="8">
            PCR
          </text>
        </svg>
        <div className="w-full space-y-1 text-[10px]">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Sw c={CALL_OI} /> Call
            </span>
            <span className="num text-term-text">
              {lakhs(ce)} · {nf((ce / tot) * 100, 0)}%
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Sw c={PUT_OI} /> Put
            </span>
            <span className="num text-term-text">
              {lakhs(pe)} · {nf((pe / tot) * 100, 0)}%
            </span>
          </div>
        </div>
        {tf > 0 && Math.abs(fAdd) > 0 && (
          <div className="w-full border-t border-term-border/50 pt-1.5">
            <div className="mb-1 text-[9px] uppercase tracking-wide text-term-dim">
              OI added · last {tf}m
            </div>
            <div className="flex h-2 w-full overflow-hidden rounded-sm bg-term-bg">
              <div
                style={{
                  width: `${(Math.max(0, flow.ceAdd) / (fAdd || 1)) * 100}%`,
                  background: CALL_ADD,
                }}
              />
              <div
                style={{
                  width: `${(Math.max(0, flow.peAdd) / (fAdd || 1)) * 100}%`,
                  background: PUT_ADD,
                }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[9px] text-term-dim">
              <span style={{ color: CALL_ADD }}>C +{compact(flow.ceAdd)}</span>
              <span style={{ color: PUT_ADD }}>P +{compact(flow.peAdd)}</span>
            </div>
          </div>
        )}
      </div>
    );
  })();

  // ---- the Sensibull-style data table ----
  // ---- session PCR line chart (with the underlying price overlaid on a right axis) ----
  const pcrEl = (() => {
    const W = 1000;
    const H = 320;
    const pad = { l: 44, r: 52, t: 16, b: 26 };
    if (pcrPts.length < 2)
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-xs text-term-dim">
          collecting PCR history for {symbol}…
        </div>
      );
    const ts = pcrPts.map((p) => p.t);
    const vs = pcrPts.map((p) => p.pcr);
    const ss = pcrPts.map((p) => p.spot);
    const t0 = ts[0];
    const t1 = ts[ts.length - 1] || t0 + 1;
    let lo = Math.min(...vs, 1);
    let hi = Math.max(...vs, 1);
    const padY = (hi - lo) * 0.12 || 0.1;
    lo -= padY;
    hi += padY;
    let slo = Math.min(...ss);
    let shi = Math.max(...ss);
    const sPad = (shi - slo) * 0.15 || 1;
    slo -= sPad;
    shi += sPad;
    const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
    const ys = (v: number) => pad.t + (1 - (v - slo) / (shi - slo || 1)) * (H - pad.t - pad.b);
    const path = pcrPts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.pcr).toFixed(1)}`).join(" ");
    const spotPath = pcrPts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${ys(p.spot).toFixed(1)}`).join(" ");
    const last = pcrPts[pcrPts.length - 1];
    const first = pcrPts[0];
    const bullish = last.pcr >= 1;
    const yGrid = [lo, (lo + hi) / 2, hi].concat(lo < 1 && hi > 1 ? [1] : []);
    const fmtT = (t: number) =>
      new Date(t * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    return (
      <div className="min-h-0 flex-1 overflow-hidden p-3">
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
          <span className="font-semibold text-term-text">{symbol} · Session PCR vs Price</span>
          <span className={`num text-lg font-bold ${bullish ? "text-up" : "text-down"}`}>
            {nf(last.pcr, 2)}
          </span>
          <span className="num text-term-dim">
            open {nf(first.pcr, 2)} · lo {nf(Math.min(...vs), 2)} · hi {nf(Math.max(...vs), 2)} · avg{" "}
            {nf(vs.reduce((a, b) => a + b, 0) / vs.length, 2)}
          </span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${bullish ? "bg-up text-white" : "bg-down text-white"}`}>
            {bullish ? "PUT-HEAVY / supportive" : "CALL-HEAVY / heavy"}
          </span>
          <span className="num text-sky-400">
            ── {symbol} {nf(last.spot, 1)}
          </span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[calc(100%-2rem)] w-full">
          {yGrid.map((v, i) => (
            <g key={i}>
              <line
                x1={pad.l}
                x2={W - pad.r}
                y1={y(v)}
                y2={y(v)}
                stroke={Math.abs(v - 1) < 1e-6 ? "#eab308" : "currentColor"}
                strokeOpacity={Math.abs(v - 1) < 1e-6 ? 0.9 : 0.15}
                strokeDasharray={Math.abs(v - 1) < 1e-6 ? "4 3" : undefined}
                className="text-term-dim"
              />
              <text x={4} y={y(v) + 3} fontSize={11} className="fill-term-dim">
                {v.toFixed(2)}
              </text>
            </g>
          ))}
          {/* right axis: price */}
          {[slo + (shi - slo) * 0.15, (slo + shi) / 2, shi - (shi - slo) * 0.15].map((v, i) => (
            <text key={"s" + i} x={W - pad.r + 4} y={ys(v) + 3} fontSize={10} className="fill-sky-400/80">
              {nf(v, 0)}
            </text>
          ))}
          {[t0, (t0 + t1) / 2, t1].map((t, i) => (
            <text key={i} x={x(t)} y={H - 8} fontSize={11} textAnchor="middle" className="fill-term-dim">
              {fmtT(t)}
            </text>
          ))}
          <path
            d={`${path} L${x(t1).toFixed(1)},${(H - pad.b).toFixed(1)} L${x(t0).toFixed(1)},${(H - pad.b).toFixed(1)} Z`}
            fill={bullish ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)"}
          />
          <path d={spotPath} fill="none" stroke="#38bdf8" strokeWidth={1.5} strokeOpacity={0.9} />
          <path d={path} fill="none" stroke={bullish ? "#22c55e" : "#ef4444"} strokeWidth={2} />
          <circle cx={x(last.t)} cy={y(last.pcr)} r={3.5} fill={bullish ? "#22c55e" : "#ef4444"} />
          <circle cx={x(last.t)} cy={ys(last.spot)} r={3} fill="#38bdf8" />
        </svg>
      </div>
    );
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
        <span className="font-semibold uppercase tracking-wide">OI Profile</span>

        <select
          value={symbol}
          onChange={(e) => selectSymbol(e.target.value, true)}
          className="rounded border border-term-border bg-term-bg px-1 py-0.5 font-semibold text-term-text outline-none focus:border-term-accent"
          title="Underlying"
        >
          {symOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        {chain.expiries.length > 0 && (
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
        )}

        <span className="ml-1">View</span>
        <div className="seg">
          <button onClick={() => setMetric("oi")} className={metric === "oi" ? "on" : ""}>
            OI
          </button>
          <button onClick={() => setMetric("chg")} className={metric === "chg" ? "on" : ""}>
            Change in OI
          </button>
          <button onClick={() => setMetric("combined")} className={metric === "combined" ? "on" : ""}>
            Combined
          </button>
        </div>

        <span className="ml-1">Strikes</span>
        <div className="seg">
          {[5, 10, 20, 30].map((n) => (
            <button key={n} onClick={() => setCount(n)} className={count === n ? "on" : ""}>
              {n}
            </button>
          ))}
        </div>

        <span className="ml-1">Show</span>
        <div className="seg">
          {(["chart", "pcr"] as const).map((v) => (
            <button key={v} onClick={() => setLayout(v)} className={layout === v ? "on" : ""}>
              {v}
            </button>
          ))}
        </div>

        <span className="ml-1">ΔOI over</span>
        <div className="seg">
          {([[0, "Day"], [1, "1m"], [5, "5m"], [15, "15m"], [30, "30m"], [60, "1h"], [240, "4h"]] as const).map(
            ([m, l]) => (
              <button key={m} onClick={() => setTf(m)} className={tf === m ? "on" : ""}>
                {l}
              </button>
            )
          )}
        </div>
        {tf > 0 && winCov > 0 && winCov < tf - 0.5 && (
          <span className="text-amber-400">
            history {winCov}m / {tf}m — still filling
          </span>
        )}
        {tf > 0 && winCov === 0 && <span className="text-amber-400">collecting OI history…</span>}

        {layout === "chart" && (
          <>
            <span className="ml-1">Zoom</span>
            <div className="seg">
              <button onClick={() => setZoom((z) => zClamp(z - 0.25))}>−</button>
              <button className="on pointer-events-none">{Math.round(zoom * 100)}%</button>
              <button onClick={() => setZoom((z) => zClamp(z + 0.25))}>+</button>
              <button onClick={() => setZoom(1)}>reset</button>
            </div>
          </>
        )}

        <span className="ml-auto num">
          Spot <span className="text-term-text">{nf(spot, 1)}</span> · PCR{" "}
          <span className="text-term-text">{nf(chain.pcr, 2)}</span> · Max Pain{" "}
          <span className="text-term-text">{nf(chain.maxPain, 0)}</span>
          {gammaFlip && (
            <>
              {" "}
              · γ-flip <span className="text-fuchsia-400">{sk(gammaFlip.strike)}</span>{" "}
              <span className={spot >= gammaFlip.strike ? "text-up" : "text-down"}>
                ({spot >= gammaFlip.strike ? "long-γ / stable" : "short-γ / volatile"})
              </span>
            </>
          )}
        </span>
      </div>

      {/* legend / totals */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-term-border bg-term-panel px-3 py-1 text-[10px]">
        <span className="text-term-dim">
          <span className="font-semibold text-down">Call OI</span>{" "}
          <span className="num">{lakhs(chain.totals.ceOI)}</span> ·{" "}
          <Sw c={addGrad(CALL_ADD)} /> added <span style={{ color: CALL_ADD }}>+{compact(flow.ceAdd)}</span> ·{" "}
          <Sw c={CALL_CUT} /> reduced <span style={{ color: CALL_CUT }}>{compact(flow.ceCut)}</span>
        </span>
        <span className="text-term-dim">
          Resistance {sk(stats.resistance)} · Floor {sk(stats.floor)} · ATM {sk(chain.atmStrike)}
        </span>
        <span className="text-term-dim">
          <span className="font-semibold text-up">Put OI</span>{" "}
          <span className="num">{lakhs(chain.totals.peOI)}</span> ·{" "}
          <Sw c={addGrad(PUT_ADD)} /> added <span style={{ color: PUT_ADD }}>+{compact(flow.peAdd)}</span> ·{" "}
          <Sw c={PUT_CUT} /> reduced <span style={{ color: PUT_CUT }}>{compact(flow.peCut)}</span>
        </span>
      </div>

      {/* overall OI verdict */}
      {verdict && (
        <div
          className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b px-3 py-1 text-[10px] ${
            verdict.bias === "BULLISH"
              ? "border-up/40 bg-up/10"
              : verdict.bias === "BEARISH"
              ? "border-down/40 bg-down/10"
              : "border-term-border bg-term-panel"
          }`}
        >
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
              verdict.bias === "BULLISH"
                ? "bg-up text-white"
                : verdict.bias === "BEARISH"
                ? "bg-down text-white"
                : "bg-term-border text-term-dim"
            }`}
          >
            OI TREND: {verdict.bias}
          </span>
          <span className="text-term-dim">score {verdict.score > 0 ? "+" : ""}{verdict.score}</span>
          {verdict.pros.length > 0 && (
            <span className="text-up">▲ {verdict.pros.join(" · ")}</span>
          )}
          {verdict.cons.length > 0 && (
            <span className="text-down">▼ {verdict.cons.join(" · ")}</span>
          )}
        </div>
      )}

      {layout === "chart" && (
        <div className="flex min-h-0 flex-1">
          {donutEl}
          {chartEl}
        </div>
      )}
      {layout === "pcr" && pcrEl}

      <div className="flex flex-wrap items-center gap-x-3 border-t border-term-border px-3 py-1 text-[9px] text-term-dim">
        <span>
          <Sw c={addGrad(CALL_ADD)} /> Call OI added
        </span>
        <span>
          <Sw c={CALL_CUT} /> Call OI reduced
        </span>
        <span>
          <Sw c={addGrad(PUT_ADD)} /> Put OI added
        </span>
        <span>
          <Sw c={PUT_CUT} /> Put OI reduced
        </span>
        <span>
          <span className="mr-1 inline-block border-l-2 border-dashed border-fuchsia-400 align-middle" style={{ height: 10 }} />
          γ-flip (dealer gamma zero-cross)
        </span>
        <span className="text-term-dim">
          · “Change in OI”: added grows up, reduced grows down · Ctrl+scroll to zoom.
        </span>
      </div>
    </div>
  );
}
