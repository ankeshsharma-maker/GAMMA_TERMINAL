import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { compact, nf, sk } from "../lib/format";
import type { ChainRow } from "../types";

const CALL = "#ef4444";
const PUT = "#22c55e";

/** Vertical OI ladder for the charted instrument — strikes down the axis,
 *  Call OI growing left, Put OI growing right, ATM centred. Shown on the
 *  right of the Chart view in place of the positions panel. */
export function OILadder() {
  const chain = useStore((s) => s.chain);
  const symbol = useStore((s) => s.symbol);
  const liveSpots = useStore((s) => s.liveSpots);
  const setInstrument = useStore((s) => s.setChartInstrument);
  const instrument = useStore((s) => s.chartInstrument);

  const [metric, setMetric] = useState<"oi" | "chg">("oi");
  const [count, setCount] = useState(14);
  const wrapRef = useRef<HTMLDivElement>(null);
  const centered = useRef("");

  const rows = useMemo<ChainRow[]>(() => {
    if (!chain) return [];
    let atm = chain.rows.findIndex((r) => r.strike === chain.atmStrike);
    if (atm < 0) atm = Math.floor(chain.rows.length / 2);
    return chain.rows.slice(Math.max(0, atm - count), atm + count + 1);
  }, [chain, count]);

  const { max, wall, floor } = useMemo(() => {
    let m = 1;
    let w = { v: -1, k: 0 };
    let f = { v: -1, k: 0 };
    for (const r of rows) {
      const cv = metric === "oi" ? r.call.oi : Math.abs(r.call.oiChg);
      const pv = metric === "oi" ? r.put.oi : Math.abs(r.put.oiChg);
      m = Math.max(m, cv, pv);
      if (r.call.oi > w.v) w = { v: r.call.oi, k: r.strike };
      if (r.put.oi > f.v) f = { v: r.put.oi, k: r.strike };
    }
    return { max: m, wall: w.k, floor: f.k };
  }, [rows, metric]);

  // keep the ATM row centred when the symbol / expiry changes
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
      <div className="flex items-center gap-1 border-b border-term-border px-2 py-1 text-[10px]">
        <div className="seg">
          <button onClick={() => setMetric("oi")} className={metric === "oi" ? "on" : ""}>
            OI
          </button>
          <button onClick={() => setMetric("chg")} className={metric === "chg" ? "on" : ""}>
            ΔOI
          </button>
        </div>
        <div className="seg ml-auto">
          {[8, 14, 20].map((n) => (
            <button key={n} onClick={() => setCount(n)} className={count === n ? "on" : ""}>
              {n}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr] items-center border-b border-term-border px-2 py-0.5 text-[9px] uppercase text-term-dim">
        <span className="text-right" style={{ color: CALL }}>
          Call {metric === "oi" ? "OI" : "ΔOI"}
        </span>
        <span className="px-2">Strike</span>
        <span style={{ color: PUT }}>Put {metric === "oi" ? "OI" : "ΔOI"}</span>
      </div>

      <div ref={wrapRef} className="min-h-0 flex-1 overflow-y-auto">
        {rows.map((r) => {
          const isATM = r.strike === chain.atmStrike;
          const isWall = r.strike === wall;
          const isFloor = r.strike === floor;
          const cv = metric === "oi" ? r.call.oi : r.call.oiChg;
          const pv = metric === "oi" ? r.put.oi : r.put.oiChg;
          const cW = (Math.abs(cv) / max) * 100;
          const pW = (Math.abs(pv) / max) * 100;
          const cNeg = metric === "chg" && cv < 0;
          const pNeg = metric === "chg" && pv < 0;
          const near = Math.abs(r.strike - spot) < (chain.strikeStep || 50) * 0.5;
          return (
            <div
              key={r.strike}
              className={`grid grid-cols-[1fr_auto_1fr] items-center border-b border-term-border/30 ${
                isATM ? "bg-term-accent/10" : near ? "bg-term-accent/[0.04]" : ""
              }`}
            >
              {/* call bar — grows left */}
              <button
                onClick={() => pick(r.strike, "CE")}
                className="flex h-6 items-center justify-end pr-1"
                title={`Chart ${r.strike} CE`}
              >
                <span className="num mr-1 text-[9px] text-term-dim">{compact(cv)}</span>
                <span
                  className="h-3 rounded-l-sm"
                  style={{
                    width: `${cW}%`,
                    background: cNeg ? "#f59e0b" : CALL,
                    opacity: cNeg ? 0.85 : 0.9,
                  }}
                />
              </button>

              {/* strike */}
              <button
                onClick={() => pick(r.strike, isATM || r.strike >= spot ? "CE" : "PE")}
                className={`num px-2 text-[10px] leading-none ${
                  isWall
                    ? "font-bold text-down"
                    : isFloor
                    ? "font-bold text-up"
                    : isATM || near
                    ? "font-bold text-term-accent"
                    : "text-term-text"
                }`}
                title={
                  isWall ? "biggest Call OI (resistance)" : isFloor ? "biggest Put OI (support)" : ""
                }
              >
                {sk(r.strike)}
              </button>

              {/* put bar — grows right */}
              <button
                onClick={() => pick(r.strike, "PE")}
                className="flex h-6 items-center pl-1"
                title={`Chart ${r.strike} PE`}
              >
                <span
                  className="h-3 rounded-r-sm"
                  style={{
                    width: `${pW}%`,
                    background: pNeg ? "#38bdf8" : PUT,
                    opacity: pNeg ? 0.85 : 0.9,
                  }}
                />
                <span className="num ml-1 text-[9px] text-term-dim">{compact(pv)}</span>
              </button>
            </div>
          );
        })}
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
