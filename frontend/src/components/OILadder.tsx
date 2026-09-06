import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { compact, nf, sk } from "../lib/format";
import type { ChainRow } from "../types";

const CALL = "#ef4444";
const PUT = "#22c55e";

/** OI ladder for the charted instrument, as a table: per-strike Call/Put OI,
 *  ΔOI and LTP with the strike down the middle. ATM centred; wall / floor
 *  marked. Any cell taps through to chart that leg. Shown on the right of the
 *  Chart view in place of the positions panel. */
export function OILadder() {
  const chain = useStore((s) => s.chain);
  const symbol = useStore((s) => s.symbol);
  const liveSpots = useStore((s) => s.liveSpots);
  const setInstrument = useStore((s) => s.setChartInstrument);
  const instrument = useStore((s) => s.chartInstrument);

  const [count, setCount] = useState(14);
  const wrapRef = useRef<HTMLDivElement>(null);
  const centered = useRef("");

  const rows = useMemo<ChainRow[]>(() => {
    if (!chain) return [];
    let atm = chain.rows.findIndex((r) => r.strike === chain.atmStrike);
    if (atm < 0) atm = Math.floor(chain.rows.length / 2);
    return chain.rows.slice(Math.max(0, atm - count), atm + count + 1);
  }, [chain, count]);

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
      ceC += r.call.oiChg || 0;
      peC += r.put.oiChg || 0;
    }
    return { maxOI: m, wall: w.k, floor: f.k, ceTot: ceT, peTot: peT, ceChgTot: ceC, peChgTot: peC };
  }, [rows]);

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
  const chg = (v: number) => (
    <span className={v >= 0 ? "text-up" : "text-down"}>
      {v >= 0 ? "▲" : "▼"}
      {compact(Math.abs(v))}
    </span>
  );

  return (
    <div className="flex h-full flex-col bg-term-panel2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-term-border px-2 py-1.5 text-2xs">
        <span className="font-semibold uppercase tracking-wide text-term-dim">OI Ladder</span>
        <span className="num font-semibold text-term-text">{symbol}</span>
        <span className="num text-term-dim">{chain.expiry}</span>
        <span className="num ml-auto text-term-dim">
          PCR <span className="text-term-text">{nf(chain.pcr, 2)}</span>
        </span>
        <div className="seg text-[10px]">
          {[8, 14, 20].map((n) => (
            <button key={n} onClick={() => setCount(n)} className={count === n ? "on" : ""}>
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* totals + total-OI change with direction arrows */}
      <div className="grid grid-cols-2 gap-px border-b border-term-border bg-term-border text-[10px]">
        <div className="bg-term-panel2 px-2 py-1">
          <div className="text-[8px] uppercase text-term-dim" style={{ color: CALL }}>
            Total Call OI
          </div>
          <div className="num font-semibold text-term-text">{compact(ceTot)}</div>
          <div className={`num text-[9px] ${ceChgTot >= 0 ? "text-up" : "text-down"}`}>
            {ceChgTot >= 0 ? "▲" : "▼"} {compact(Math.abs(ceChgTot))}
          </div>
        </div>
        <div className="bg-term-panel2 px-2 py-1 text-right">
          <div className="text-[8px] uppercase text-term-dim" style={{ color: PUT }}>
            Total Put OI
          </div>
          <div className="num font-semibold text-term-text">{compact(peTot)}</div>
          <div className={`num text-[9px] ${peChgTot >= 0 ? "text-up" : "text-down"}`}>
            {peChgTot >= 0 ? "▲" : "▼"} {compact(Math.abs(peChgTot))}
          </div>
        </div>
      </div>

      <div ref={wrapRef} className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-[9px]">
          <thead className="sticky top-0 z-10 bg-term-panel text-[8px] uppercase text-term-dim">
            <tr>
              <th className="border-b border-term-border px-1 py-1 text-right" style={{ color: CALL }}>
                C OI
              </th>
              <th className="border-b border-term-border px-1 py-1 text-right">C Δ</th>
              <th className="border-b border-term-border px-1 py-1 text-right">C LTP</th>
              <th className="border-x border-b border-term-border bg-term-bg px-1 py-1 text-center font-semibold text-term-text">
                Strike
              </th>
              <th className="border-b border-term-border px-1 py-1 text-left">P LTP</th>
              <th className="border-b border-term-border px-1 py-1 text-left">P Δ</th>
              <th className="border-b border-term-border px-1 py-1 text-left" style={{ color: PUT }}>
                P OI
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isATM = r.strike === chain.atmStrike;
              const isWall = r.strike === wall;
              const isFloor = r.strike === floor;
              const near = Math.abs(r.strike - spot) < (chain.strikeStep || 50) * 0.5;
              const cw = `${Math.min(100, (r.call.oi / maxOI) * 100)}%`;
              const pw = `${Math.min(100, (r.put.oi / maxOI) * 100)}%`;
              const rowCls = isATM
                ? "bg-term-accent/15"
                : isWall
                ? "bg-down/10"
                : isFloor
                ? "bg-up/10"
                : near
                ? "bg-term-accent/[0.05]"
                : "";
              return (
                <tr key={r.strike} className={rowCls}>
                  <td
                    onClick={() => pick(r.strike, "CE")}
                    className="relative cursor-pointer border-b border-term-border/30 px-1 py-1 text-right font-medium text-term-text"
                    title={`Chart ${r.strike} CE`}
                  >
                    <span
                      className="pointer-events-none absolute inset-y-[2px] right-0"
                      style={{ width: cw, background: `${CALL}22` }}
                    />
                    <span className="relative">{compact(r.call.oi)}</span>
                  </td>
                  <td className="num border-b border-term-border/30 px-1 py-1 text-right">
                    {chg(r.call.oiChg)}
                  </td>
                  <td className="num border-b border-term-border/30 px-1 py-1 text-right text-term-dim">
                    {nf(r.call.ltp)}
                  </td>
                  <td
                    onClick={() => pick(r.strike, isATM || r.strike >= spot ? "CE" : "PE")}
                    className={`num cursor-pointer border-x border-b border-term-border/30 bg-term-bg/60 px-1 py-1 text-center ${
                      isWall
                        ? "font-bold text-down"
                        : isFloor
                        ? "font-bold text-up"
                        : isATM || near
                        ? "font-bold text-term-accent"
                        : "text-term-text"
                    }`}
                    title={isWall ? "biggest Call OI (resistance)" : isFloor ? "biggest Put OI (support)" : `Chart ${r.strike}`}
                  >
                    {sk(r.strike)}
                  </td>
                  <td className="num border-b border-term-border/30 px-1 py-1 text-left text-term-dim">
                    {nf(r.put.ltp)}
                  </td>
                  <td className="num border-b border-term-border/30 px-1 py-1 text-left">
                    {chg(r.put.oiChg)}
                  </td>
                  <td
                    onClick={() => pick(r.strike, "PE")}
                    className="relative cursor-pointer border-b border-term-border/30 px-1 py-1 text-left font-medium text-term-text"
                    title={`Chart ${r.strike} PE`}
                  >
                    <span
                      className="pointer-events-none absolute inset-y-[2px] left-0"
                      style={{ width: pw, background: `${PUT}22` }}
                    />
                    <span className="relative">{compact(r.put.oi)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="border-t border-term-border px-2 py-1 text-[9px] text-term-dim">
        spot <span className="num text-term-text">{nf(spot, 1)}</span> · wall{" "}
        <span className="num text-down">{sk(wall)}</span> · floor{" "}
        <span className="num text-up">{sk(floor)}</span>
        {instrument.includes("|") && <span> · charting {instrument.split("|").slice(2).join(" ")}</span>}
      </div>
    </div>
  );
}
