import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { compact, nf, sk } from "../lib/format";
import type { ChainRow } from "../types";

const CALL = "#b91c1c"; // total Call OI  — dark red
const PUT = "#15803d"; // total Put OI   — dark green
const ADD = "#22c55e"; // OI added (buildup)
const CUT = "#ef4444"; // OI reduced (unwinding)

/** OI ladder for the charted instrument — one combined bar per side showing
 *  total OI with a coloured ΔOI cap (green = added, red = reduced), for a
 *  chosen window (Day / 5m / 15m / 30m / 1h). ATM centred; wall & floor
 *  marked; every cell taps through to chart that leg. */
export function OILadder() {
  const chain = useStore((s) => s.chain);
  const symbol = useStore((s) => s.symbol);
  const liveSpots = useStore((s) => s.liveSpots);
  const setInstrument = useStore((s) => s.setChartInstrument);
  const instrument = useStore((s) => s.chartInstrument);

  const [count, setCount] = useState(8);
  const [tf, setTf] = useState(0); // ΔOI window in minutes; 0 = day (since open)
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

  const { maxOI, wall, floor, ceTot, peTot, ceChgTot, peChgTot } = useMemo(() => {
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
    return { maxOI: m, wall: w.k, floor: f.k, ceTot: ceT, peTot: peT, ceChgTot: ceC, peChgTot: peC };
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
  const tfLbl = tf === 0 ? "day" : `${tf}m`;

  return (
    <div className="flex h-full flex-col bg-term-panel2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-term-border px-2 py-1.5 text-2xs">
        <span className="font-semibold uppercase tracking-wide text-term-dim">OI Ladder</span>
        <span className="num font-semibold text-term-text">{symbol}</span>
        <span className="num text-term-dim">{chain.expiry}</span>
        <span className="num ml-auto text-term-dim">
          PCR <span className="text-term-text">{nf(chain.pcr, 2)}</span>
        </span>
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
        <span className="ml-auto text-term-dim">Strikes</span>
        <div className="seg">
          {[8, 14, 20].map((n) => (
            <button key={n} onClick={() => setCount(n)} className={count === n ? "on" : ""}>
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* totals + total-OI change (▲ add / ▼ reduce) */}
      <div className="grid grid-cols-2 divide-x divide-term-border border-b border-term-border text-[10px]">
        <div className="px-2 py-1">
          <div className="text-[8px] uppercase text-term-dim" style={{ color: CALL }}>
            Total Call OI
          </div>
          <div className="num font-semibold text-term-text">{compact(ceTot)}</div>
          <div className={`num text-[9px] ${ceChgTot >= 0 ? "text-up" : "text-down"}`}>
            {ceChgTot >= 0 ? "▲" : "▼"} {compact(Math.abs(ceChgTot))} · {tfLbl}
          </div>
        </div>
        <div className="px-2 py-1 text-right">
          <div className="text-[8px] uppercase text-term-dim" style={{ color: PUT }}>
            Total Put OI
          </div>
          <div className="num font-semibold text-term-text">{compact(peTot)}</div>
          <div className={`num text-[9px] ${peChgTot >= 0 ? "text-up" : "text-down"}`}>
            {peChgTot >= 0 ? "▲" : "▼"} {compact(Math.abs(peChgTot))} · {tfLbl}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr] items-center divide-x divide-term-border border-b border-term-border text-[9px] uppercase text-term-dim">
        <span className="px-2 py-0.5 text-right" style={{ color: CALL }}>
          Call OI · Δ
        </span>
        <span className="px-2 py-0.5 text-center">Strike</span>
        <span className="px-2 py-0.5" style={{ color: PUT }}>
          Put OI · Δ
        </span>
      </div>

      <div ref={wrapRef} className="min-h-0 flex-1 overflow-y-auto">
        {rows.map((r) => {
          const isATM = r.strike === chain.atmStrike;
          const isWall = r.strike === wall;
          const isFloor = r.strike === floor;
          const near = Math.abs(r.strike - spot) < (chain.strikeStep || 50) * 0.5;
          const cChg = dCE(r);
          const pChg = dPE(r);
          const cBarW = (r.call.oi / maxOI) * 100;
          const pBarW = (r.put.oi / maxOI) * 100;
          // cap width = |ΔOI| clamped to the bar length
          const cCapW = Math.min(cBarW, (Math.abs(cChg) / maxOI) * 100);
          const pCapW = Math.min(pBarW, (Math.abs(pChg) / maxOI) * 100);
          return (
            <div
              key={r.strike}
              className={`grid grid-cols-[1fr_auto_1fr] items-stretch divide-x divide-term-border/60 border-b border-term-border/60 ${
                isATM ? "bg-term-accent/10" : near ? "bg-term-accent/[0.04]" : ""
              }`}
            >
              {/* call — combined OI bar (grows left) + ΔOI cap at the tip */}
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
                <span className="relative h-3.5 w-full max-w-[55%]">
                  <span
                    className="absolute right-0 top-0 h-full rounded-l-sm"
                    style={{ width: `${cBarW}%`, background: CALL }}
                  />
                  <span
                    className="absolute right-0 top-0 h-full"
                    style={{ width: `${cCapW}%`, background: cChg >= 0 ? ADD : CUT }}
                  />
                </span>
              </button>

              {/* strike */}
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

              {/* put — combined OI bar (grows right) + ΔOI cap at the tip */}
              <button
                onClick={() => pick(r.strike, "PE")}
                className="relative flex h-7 items-center gap-1 pl-1"
                title={`${r.strike} PE · OI ${compact(r.put.oi)} · Δ ${compact(pChg)}`}
              >
                <span className="relative h-3.5 w-full max-w-[55%]">
                  <span
                    className="absolute left-0 top-0 h-full rounded-r-sm"
                    style={{ width: `${pBarW}%`, background: PUT }}
                  />
                  <span
                    className="absolute left-0 top-0 h-full"
                    style={{ width: `${pCapW}%`, background: pChg >= 0 ? ADD : CUT }}
                  />
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
          <span style={{ color: CALL }}>■</span> Call OI &nbsp;
          <span style={{ color: PUT }}>■</span> Put OI &nbsp;
          <span style={{ color: ADD }}>■</span> added &nbsp;
          <span style={{ color: CUT }}>■</span> reduced
        </span>
        <span className="ml-auto">
          spot <span className="num text-term-text">{nf(spot, 1)}</span> · wall{" "}
          <span className="num text-down">{sk(wall)}</span> · floor{" "}
          <span className="num text-up">{sk(floor)}</span>
          {instrument.includes("|") && <span> · {instrument.split("|").slice(2).join(" ")}</span>}
        </span>
      </div>
    </div>
  );
}
