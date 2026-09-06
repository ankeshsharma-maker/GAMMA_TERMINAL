import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { compact, crores, nf, sk } from "../lib/format";
import type { ChainRow } from "../types";

const CALL_OI = "#b91c1c"; // total Call OI — dark red
const PUT_OI = "#15803d"; // total Put OI  — dark green
const OI_ADD = "#22c55e"; // OI added (buildup)
const OI_CUT = "#ef4444"; // OI reduced (unwinding)

const Sw = ({ c }: { c: string }) => (
  <span className="inline-block h-2 w-3 rounded-sm align-middle" style={{ background: c }} />
);

function MiniDonut({
  aVal,
  bVal,
  aCol,
  bCol,
  center,
  sub,
}: {
  aVal: number;
  bVal: number;
  aCol: string;
  bCol: string;
  center: string;
  sub: string;
}) {
  const R = 42;
  const SW = 15;
  const C = 2 * Math.PI * R;
  const t = Math.abs(aVal) + Math.abs(bVal) || 1;
  const aLen = (Math.abs(aVal) / t) * C;
  return (
    <svg viewBox="0 0 100 100" className="w-full max-w-[108px]">
      <circle cx="50" cy="50" r={R} fill="none" stroke="#1e2733" strokeWidth={SW} />
      <circle cx="50" cy="50" r={R} fill="none" stroke={bCol} strokeWidth={SW} strokeDasharray={`${C} ${C}`} transform="rotate(-90 50 50)" />
      <circle cx="50" cy="50" r={R} fill="none" stroke={aCol} strokeWidth={SW} strokeDasharray={`${aLen.toFixed(1)} ${C}`} transform="rotate(-90 50 50)" />
      <text x="50" y="47" textAnchor="middle" className="fill-term-text" fontSize="14" fontWeight="700">
        {center}
      </text>
      <text x="50" y="59" textAnchor="middle" className="fill-term-dim" fontSize="7.5">
        {sub}
      </text>
    </svg>
  );
}

/** OI ladder for the charted instrument — OI-Profile layout in the sidebar:
 *  Total-OI pie + Change-in-OI pie, then a per-strike ladder (total OI bar
 *  with a green/red ΔOI cap). Same values / colours as OI Profile. */
export function OILadder() {
  const chain = useStore((s) => s.chain);
  const symbol = useStore((s) => s.symbol);
  const liveSpots = useStore((s) => s.liveSpots);
  const setInstrument = useStore((s) => s.setChartInstrument);

  const [count, setCount] = useState(8);
  const [tf, setTf] = useState(0); // ΔOI window minutes; 0 = day
  const [win, setWin] = useState<Record<string, { ce: number; pe: number }>>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const centered = useRef("");
  const expiry = chain?.expiry ?? "";

  useEffect(() => {
    if (tf === 0 || !symbol) {
      setWin({});
      return;
    }
    let alive = true;
    const load = () =>
      api.oiChange(symbol, expiry || undefined, tf).then((d) => {
        if (!alive) return;
        const m: Record<string, { ce: number; pe: number }> = {};
        for (const [k, v] of Object.entries(d.strikes)) m[k] = { ce: v.ceOiChg, pe: v.peOiChg };
        setWin(m);
      }, () => {});
    load();
    const id = window.setInterval(load, 20000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [tf, symbol, expiry]);

  const rows = useMemo<ChainRow[]>(() => {
    if (!chain) return [];
    let atm = chain.rows.findIndex((r) => r.strike === chain.atmStrike);
    if (atm < 0) atm = Math.floor(chain.rows.length / 2);
    return chain.rows.slice(Math.max(0, atm - count), atm + count + 1);
  }, [chain, count]);

  const dCE = (r: ChainRow) => (tf === 0 ? r.call.oiChg : win[String(Math.round(r.strike))]?.ce ?? 0);
  const dPE = (r: ChainRow) => (tf === 0 ? r.put.oiChg : win[String(Math.round(r.strike))]?.pe ?? 0);

  const { maxOI, wall, floor, ceTot, peTot, dCEnet, dPEnet } = useMemo(() => {
    let m = 1;
    let w = { v: -1, k: 0 };
    let f = { v: -1, k: 0 };
    let ceT = 0, peT = 0, ceC = 0, peC = 0;
    for (const r of rows) {
      m = Math.max(m, r.call.oi, r.put.oi);
      if (r.call.oi > w.v) w = { v: r.call.oi, k: r.strike };
      if (r.put.oi > f.v) f = { v: r.put.oi, k: r.strike };
      ceT += r.call.oi || 0;
      peT += r.put.oi || 0;
      ceC += dCE(r);
      peC += dPE(r);
    }
    return { maxOI: m, wall: w.k, floor: f.k, ceTot: ceT, peTot: peT, dCEnet: ceC, dPEnet: peC };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, win, tf]);

  useEffect(() => {
    const key = `${chain?.symbol}|${chain?.expiry}|${count}`;
    if (!chain || !wrapRef.current || rows.length === 0 || centered.current === key) return;
    const i = rows.findIndex((r) => r.strike === chain.atmStrike);
    if (i >= 0) {
      const el = wrapRef.current;
      const rowH = el.scrollHeight / rows.length;
      el.scrollTop = i * rowH - el.clientHeight / 2 + rowH / 2;
      centered.current = key;
    }
  }, [chain, rows, count]);

  if (!chain)
    return (
      <div className="flex h-full items-center justify-center text-2xs text-term-dim">
        no chain for {symbol}
      </div>
    );

  const spot = chain.liveSpot?.ltp ?? liveSpots[chain.symbol]?.ltp ?? chain.spot;
  const pick = (k: number, ot: "CE" | "PE") =>
    setInstrument(`${symbol}|${chain.expiry}|${k}|${ot}`);
  const pcr = ceTot ? peTot / ceTot : null;
  const totOI = ceTot + peTot;
  const dtot = Math.abs(dCEnet) + Math.abs(dPEnet);
  const tfLbl = tf === 0 ? "since open" : `last ${tf}m`;

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-term-panel2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-term-border px-2 py-1.5 text-2xs">
        <span className="font-semibold uppercase tracking-wide text-term-dim">OI Ladder</span>
        <span className="num font-semibold text-term-text">{symbol}</span>
        <span className="num text-term-dim">{chain.expiry}</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-term-border px-2 py-1 text-[10px]">
        <span className="text-term-dim">ΔOI</span>
        <div className="seg">
          {([0, 5, 15, 30, 60] as const).map((m) => (
            <button key={m} onClick={() => setTf(m)} className={tf === m ? "on" : ""}>
              {m === 0 ? "Day" : m < 60 ? `${m}m` : "1h"}
            </button>
          ))}
        </div>
        <span className="ml-auto text-term-dim">±ATM</span>
        <div className="seg">
          {[8, 14, 20].map((n) => (
            <button key={n} onClick={() => setCount(n)} className={count === n ? "on" : ""}>
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* ---- pies (same as OI Profile) ---- */}
      <div className="flex flex-col items-center gap-1.5 border-b border-term-border p-2">
        <div className="text-center text-[9px] font-semibold uppercase tracking-wide text-term-dim">
          Total OI · {count}±ATM
        </div>
        <MiniDonut
          aVal={ceTot}
          bVal={peTot}
          aCol={CALL_OI}
          bCol={PUT_OI}
          center={pcr != null ? nf(pcr, 2) : "–"}
          sub="PCR"
        />
        <div className="w-full space-y-0.5 text-[10px]">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Sw c={CALL_OI} /> Call
            </span>
            <span className="num text-term-text">
              {crores(ceTot)} · {nf(totOI ? (ceTot / totOI) * 100 : 0, 0)}%
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Sw c={PUT_OI} /> Put
            </span>
            <span className="num text-term-text">
              {crores(peTot)} · {nf(totOI ? (peTot / totOI) * 100 : 0, 0)}%
            </span>
          </div>
        </div>

        <div className="mt-1 w-full border-t border-term-border/50 pt-1.5 text-center text-[9px] font-semibold uppercase tracking-wide text-term-dim">
          Change in OI · {tfLbl}
        </div>
        {dtot > 0 ? (
          <>
            <MiniDonut
              aVal={dCEnet}
              bVal={dPEnet}
              aCol={dCEnet >= 0 ? OI_ADD : OI_CUT}
              bCol={dPEnet >= 0 ? OI_ADD : OI_CUT}
              center={
                Math.abs(dPEnet) > Math.abs(dCEnet)
                  ? dPEnet >= 0
                    ? "PUT+"
                    : "PUT−"
                  : dCEnet >= 0
                  ? "CALL+"
                  : "CALL−"
              }
              sub="net ΔOI"
            />
            <div className="w-full space-y-0.5 text-[10px]">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <Sw c={dCEnet >= 0 ? OI_ADD : OI_CUT} /> Call {dCEnet >= 0 ? "written" : "unwound"}
                </span>
                <span className="num text-term-text">
                  {dCEnet >= 0 ? "+" : ""}
                  {compact(dCEnet)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <Sw c={dPEnet >= 0 ? OI_ADD : OI_CUT} /> Put {dPEnet >= 0 ? "written" : "unwound"}
                </span>
                <span className="num text-term-text">
                  {dPEnet >= 0 ? "+" : ""}
                  {compact(dPEnet)}
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="text-[10px] text-term-dim">no OI change yet</div>
        )}
      </div>

      {/* ---- per-strike ladder ---- */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center divide-x divide-term-border border-b border-term-border text-[9px] uppercase text-term-dim">
        <span className="px-2 py-0.5 text-right" style={{ color: CALL_OI }}>
          Call OI · Δ
        </span>
        <span className="px-2 py-0.5 text-center">Strike</span>
        <span className="px-2 py-0.5" style={{ color: PUT_OI }}>
          Put OI · Δ
        </span>
      </div>

      <div ref={wrapRef} className="min-h-0 flex-1">
        {rows.map((r) => {
          const isATM = r.strike === chain.atmStrike;
          const isWall = r.strike === wall;
          const isFloor = r.strike === floor;
          const near = Math.abs(r.strike - spot) < (chain.strikeStep || 50) * 0.5;
          const cChg = dCE(r);
          const pChg = dPE(r);
          const cBarW = (r.call.oi / maxOI) * 100;
          const pBarW = (r.put.oi / maxOI) * 100;
          const cCapW = Math.min(cBarW, (Math.abs(cChg) / maxOI) * 100);
          const pCapW = Math.min(pBarW, (Math.abs(pChg) / maxOI) * 100);
          return (
            <div
              key={r.strike}
              className={`grid grid-cols-[1fr_auto_1fr] items-stretch divide-x divide-term-border/60 border-b border-term-border/60 ${
                isATM ? "bg-term-accent/10" : near ? "bg-term-accent/[0.04]" : ""
              }`}
            >
              <button
                onClick={() => pick(r.strike, "CE")}
                className="relative flex h-7 items-center justify-end gap-1 pr-1"
                title={`${r.strike} CE · OI ${compact(r.call.oi)} · Δ ${compact(cChg)}`}
              >
                <span className={`num text-[9px] ${cChg >= 0 ? "text-up" : "text-down"}`}>
                  {cChg >= 0 ? "▲" : "▼"}
                  {compact(Math.abs(cChg))}
                </span>
                <span className="num text-[9px] font-medium text-term-text">{compact(r.call.oi)}</span>
                <span className="relative h-3.5 w-full max-w-[52%]">
                  <span className="absolute right-0 top-0 h-full rounded-l-sm" style={{ width: `${cBarW}%`, background: CALL_OI }} />
                  <span className="absolute right-0 top-0 h-full" style={{ width: `${cCapW}%`, background: cChg >= 0 ? OI_ADD : OI_CUT }} />
                </span>
              </button>

              <button
                onClick={() => pick(r.strike, isATM || r.strike >= spot ? "CE" : "PE")}
                className={`num flex h-7 items-center justify-center px-2 text-[10px] leading-none ${
                  isWall
                    ? "font-bold text-down"
                    : isFloor
                    ? "font-bold text-up"
                    : isATM || near
                    ? "font-bold text-term-accent"
                    : "text-term-text"
                }`}
                title={isWall ? "biggest Call OI (resistance)" : isFloor ? "biggest Put OI (support)" : ""}
              >
                {sk(r.strike)}
              </button>

              <button
                onClick={() => pick(r.strike, "PE")}
                className="relative flex h-7 items-center gap-1 pl-1"
                title={`${r.strike} PE · OI ${compact(r.put.oi)} · Δ ${compact(pChg)}`}
              >
                <span className="relative h-3.5 w-full max-w-[52%]">
                  <span className="absolute left-0 top-0 h-full rounded-r-sm" style={{ width: `${pBarW}%`, background: PUT_OI }} />
                  <span className="absolute left-0 top-0 h-full" style={{ width: `${pCapW}%`, background: pChg >= 0 ? OI_ADD : OI_CUT }} />
                </span>
                <span className="num text-[9px] font-medium text-term-text">{compact(r.put.oi)}</span>
                <span className={`num text-[9px] ${pChg >= 0 ? "text-up" : "text-down"}`}>
                  {pChg >= 0 ? "▲" : "▼"}
                  {compact(Math.abs(pChg))}
                </span>
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 border-t border-term-border px-2 py-1 text-[9px] text-term-dim">
        <span>
          <Sw c={CALL_OI} /> Call &nbsp; <Sw c={PUT_OI} /> Put &nbsp;
          <Sw c={OI_ADD} /> added &nbsp; <Sw c={OI_CUT} /> reduced
        </span>
        <span className="ml-auto">
          spot <span className="num text-term-text">{nf(spot, 1)}</span> · wall{" "}
          <span className="num text-down">{sk(wall)}</span> · floor{" "}
          <span className="num text-up">{sk(floor)}</span>
        </span>
      </div>
    </div>
  );
}
