import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { compact, lakhs, nf, signColor, sk } from "../lib/format";
import type { ChainRow, Leg, UnusualKind } from "../types";
import { OrderTicket } from "./OrderTicket";

type TabKey = "ltp" | "oi" | "greeks";
const TABS: { key: TabKey; label: string }[] = [
  { key: "ltp", label: "LTP" },
  { key: "oi", label: "OI" },
  { key: "greeks", label: "Greeks" },
];

interface Ctx {
  maxOI: number;
  maxAbsChgOI: number;
  isMaxCallOI: boolean;
  isMaxPutOI: boolean;
  isMaxCallChg: boolean; // biggest fresh CE OI build
  isMaxPutChg: boolean; // biggest fresh PE OI build
  isMinCallChg: boolean; // biggest CE OI unwind
  isMinPutChg: boolean; // biggest PE OI unwind
  hotCE: UnusualKind | null; // unusual Greeks move on the call leg
  hotPE: UnusualKind | null;
  isMaxCallVol: boolean; // highest traded volume, call side
  isMaxPutVol: boolean;
  maxDelta: number;
  maxGamma: number;
  maxTheta: number;
  maxVega: number;
  isMaxCallGamma: boolean;
  isMaxPutGamma: boolean;
  // LTP tab (OI-style)
  maxLtp: number;
  maxChgPct: number;
  maxBidQty: number;
  maxAskQty: number;
  maxIV: number;
  isMaxCallBidQty: boolean;
  isMaxPutBidQty: boolean;
  isMaxCallAskQty: boolean;
  isMaxPutAskQty: boolean;
  isMaxCallIV: boolean;
  isMaxPutIV: boolean;
}

/** OI-tab-style bar+value cell for a Greek. */
function greekCell(
  val: number,
  max: number,
  side: "l" | "r",
  digits: number,
  hotCls: string,
  tag: string
) {
  return (
    <>
      <OIBar value={val} max={max} side={side} tone={side === "l" ? "call" : "put"} />
      <span className={`relative text-term-dim ${hotCls}`}>
        {digits === 4 ? val.toFixed(4) : nf(val, digits)}
        {tag && <sup className="ml-0.5 text-[8px]">{tag}</sup>}
      </span>
    </>
  );
}

const volCol: Col = {
  key: "vol",
  label: "Vol",
  render: (l, side, ctx) => {
    const hv = side === "l" ? ctx.isMaxCallVol : ctx.isMaxPutVol;
    return (
      <span
        className={
          hv ? "rounded bg-term-accent/25 px-0.5 font-bold text-term-accent ring-1 ring-term-accent/60" : ""
        }
      >
        {compact(l.volume)}
        {hv && <sup className="ml-0.5 text-[8px]">HV</sup>}
      </span>
    );
  },
};
interface Col {
  key: string;
  label: string;
  render: (leg: Leg, side: "l" | "r", ctx: Ctx) => ReactNode;
}

/** OI-tab-style bar+value cell for the LTP tab. */
function ltpBarCell(
  val: number,
  max: number,
  side: "l" | "r",
  tone: "call" | "put" | "pos" | "neg",
  body: ReactNode,
  strong = false
) {
  return (
    <>
      <OIBar value={val} max={max} side={side} tone={tone} strong={strong} />
      <span className="relative">{body}</span>
    </>
  );
}

const TONE: Record<string, string> = {
  call: "bg-down/30", // Call OI = resistance
  put: "bg-up/30", // Put OI = support
  pos: "bg-up/40",
  neg: "bg-down/40",
};

function OIBar({
  value,
  max,
  side,
  tone,
  strong = false,
}: {
  value: number;
  max: number;
  side: "l" | "r";
  tone: "call" | "put" | "pos" | "neg";
  strong?: boolean;
}) {
  const w = max > 0 ? Math.min(100, (Math.abs(value) / max) * 100) : 0;
  return (
    <div
      className={`pointer-events-none absolute inset-y-[1px] ${
        side === "l" ? "right-0" : "left-0"
      } ${TONE[tone]} ${strong ? "outline outline-1 outline-amber-400/80" : ""}`}
      style={{ width: `${w}%` }}
    />
  );
}

/** LTP tab: price only (change moved to its own column). */
const ltpCol: Col = {
  key: "ltp",
  label: "LTP",
  render: (l, side, ctx) =>
    ltpBarCell(
      l.ltp,
      ctx.maxLtp,
      side,
      side === "l" ? "call" : "put",
      <span className="font-semibold text-term-text">{nf(l.ltp)}</span>
    ),
};

/** LTP tab: % change from previous close, own column, signed bar. */
const chgPctCol: Col = {
  key: "chgpct",
  label: "Chg %",
  render: (l, side, ctx) =>
    ltpBarCell(
      Math.abs(l.chgPct),
      ctx.maxChgPct,
      side,
      l.chgPct >= 0 ? "pos" : "neg",
      <span className={`font-medium ${signColor(l.chgPct)}`}>
        {l.chgPct >= 0 ? "+" : ""}
        {nf(l.chgPct, 2)}%
      </span>
    ),
};

const deltaCol: Col = {
  key: "delta",
  label: "Δ Delta",
  render: (l, side, ctx) =>
    greekCell(
      l.delta,
      ctx.maxDelta,
      side,
      3,
      (side === "l" ? ctx.hotCE : ctx.hotPE) === "DELTA_JUMP"
        ? "rounded bg-term-accent/25 px-0.5 font-bold text-term-accent ring-1 ring-term-accent/70"
        : "",
      (side === "l" ? ctx.hotCE : ctx.hotPE) === "DELTA_JUMP" ? "!" : ""
    ),
};
const gammaCol: Col = {
  key: "gamma",
  label: "Γ Gamma",
  render: (l, side, ctx) => {
    const k = side === "l" ? ctx.hotCE : ctx.hotPE;
    const hot = k === "GAMMA_SPIKE" || k === "GAMMA_COLLAPSE";
    const peak = side === "l" ? ctx.isMaxCallGamma : ctx.isMaxPutGamma;
    const cls = hot
      ? `rounded px-0.5 font-bold ring-1 ${
          k === "GAMMA_SPIKE"
            ? "bg-amber-500/25 text-amber-400 ring-amber-500/70"
            : "bg-down/25 text-down ring-down/70"
        }`
      : peak
      ? "font-bold text-term-text"
      : "";
    const tag = hot ? (k === "GAMMA_SPIKE" ? "▲" : "▼") : peak ? "Γ" : "";
    return greekCell(l.gamma, ctx.maxGamma, side, 4, cls, tag);
  },
};
const thetaCol: Col = {
  key: "theta",
  label: "Θ Theta",
  render: (l, side, ctx) => greekCell(l.theta, ctx.maxTheta, side, 2, "", ""),
};
const vegaCol: Col = {
  key: "vega",
  label: "V Vega",
  render: (l, side, ctx) => greekCell(l.vega, ctx.maxVega, side, 2, "", ""),
};
const ivCol: Col = { key: "iv", label: "IV", render: (l) => nf(l.ivCalc ?? l.iv, 1) };

const COLS: Record<TabKey, Col[]> = {
  // reading from the centre STRIKE outward: LTP · Chg% · Δ · Γ · Θ · V
  // (array order = calls left→right, so the last entry sits against STRIKE)
  ltp: [vegaCol, thetaCol, gammaCol, deltaCol, chgPctCol, ltpCol],
  oi: [
    {
      key: "oi",
      label: "OI",
      render: (l, side, ctx) => {
        const wall = side === "l" ? ctx.isMaxCallOI : ctx.isMaxPutOI;
        return (
          <>
            <OIBar value={l.oi} max={ctx.maxOI} side={side} tone={side === "l" ? "call" : "put"} />
            <span
              className={`relative ${
                wall ? (side === "l" ? "font-bold text-down" : "font-bold text-up") : ""
              }`}
            >
              {compact(l.oi)}
              {wall && (
                <sup className="ml-0.5 text-[8px]">{side === "l" ? "R" : "S"}</sup>
              )}
            </span>
          </>
        );
      },
    },
    {
      key: "chgoi",
      label: "Chg OI",
      render: (l, side, ctx) => {
        const build = side === "l" ? ctx.isMaxCallChg : ctx.isMaxPutChg;
        const unwind = side === "l" ? ctx.isMinCallChg : ctx.isMinPutChg;
        return (
          <>
            <OIBar
              value={l.oiChg}
              max={ctx.maxAbsChgOI}
              side={side}
              tone={l.oiChg >= 0 ? "pos" : "neg"}
              strong={build || unwind}
            />
            <span
              className={`relative ${signColor(l.oiChg)} ${
                build || unwind
                  ? "rounded bg-amber-400/15 px-0.5 font-bold ring-1 ring-amber-400/70"
                  : ""
              }`}
            >
              {compact(l.oiChg)}
              {build && <sup className="ml-0.5 text-[8px] text-amber-400">▲</sup>}
              {unwind && <sup className="ml-0.5 text-[8px] text-amber-400">▽</sup>}
            </span>
          </>
        );
      },
    },
    {
      key: "chgoipct",
      label: "Chg %",
      render: (l) => <span className={signColor(l.oiChgPct)}>{nf(l.oiChgPct, 1)}</span>,
    },
    volCol,
  ],
  greeks: [deltaCol, gammaCol, thetaCol, vegaCol, ivCol],
};

function QuickTrade({
  strike,
  ot,
  lots,
  onTicket,
}: {
  strike: number;
  ot: "CE" | "PE";
  lots: number;
  onTicket: () => void;
}) {
  const placeOrder = useStore((s) => s.placeOrder);
  const queueBuilderLeg = useStore((s) => s.queueBuilderLeg);
  return (
    <div className="flex gap-0.5">
      <button
        title={`Buy ${lots} lot(s)`}
        onClick={() => placeOrder({ strike, optionType: ot, side: "BUY", lots })}
        className="rounded bg-up/15 px-1 text-[10px] font-bold text-up hover:bg-up/30"
      >
        B
      </button>
      <button
        title={`Sell ${lots} lot(s)`}
        onClick={() => placeOrder({ strike, optionType: ot, side: "SELL", lots })}
        className="rounded bg-down/15 px-1 text-[10px] font-bold text-down hover:bg-down/30"
      >
        S
      </button>
      <button
        title={`Add ${ot} ${strike} to the Strategy Builder (Buy ${lots} lot — flip side in the builder)`}
        onClick={() =>
          queueBuilderLeg({ optionType: ot, strike, side: "BUY", lots: Math.max(1, lots) })
        }
        className="rounded bg-term-accent/20 px-1 text-[10px] font-bold text-term-accent hover:bg-term-accent/40"
      >
        ＋
      </button>
      <button
        title="Order ticket"
        onClick={onTicket}
        className="rounded bg-term-border px-1 text-[10px] text-term-dim hover:text-term-text"
      >
        ⋯
      </button>
    </div>
  );
}

export function OptionChain() {
  const { chain, chainError } = useStore();
  const [lots, setLots] = useState(1);
  const [tab, setTab] = useState<TabKey>("ltp");
  const [count, setCount] = useState<number>(20);
  const [ticket, setTicket] = useState<{ strike: number; ot: "CE" | "PE"; ltp: number } | null>(
    null
  );
  const atmRef = useRef<HTMLTableRowElement>(null);
  const didScroll = useRef(false);

  const visibleRows = useMemo(() => {
    if (!chain) return [];
    const rows = chain.rows;
    let atmIdx = rows.findIndex((r) => r.strike === chain.atmStrike);
    if (atmIdx < 0) atmIdx = Math.floor(rows.length / 2);
    return rows.slice(Math.max(0, atmIdx - count), atmIdx + count + 1);
  }, [chain, count]);

  const hotMap = useMemo(() => {
    const m = new Map<string, UnusualKind>();
    for (const h of chain?.hotGreeks ?? []) m.set(`${h.strike}:${h.optionType}`, h.kind);
    return m;
  }, [chain?.hotGreeks]);

  const oiStats = useMemo(() => {
    const base = {
      maxOI: 1,
      maxAbsChgOI: 1,
      maxCallStrike: -1,
      maxPutStrike: -1,
      maxCallChgStrike: -1,
      maxPutChgStrike: -1,
      minCallChgStrike: -1,
      minPutChgStrike: -1,
      maxCallVolStrike: -1,
      maxPutVolStrike: -1,
      maxDelta: 1,
      maxGamma: 1e-6,
      maxTheta: 1,
      maxVega: 1,
      maxCallGammaStrike: -1,
      maxPutGammaStrike: -1,
      maxLtp: 1,
      maxChgPct: 1,
      maxBidQty: 1,
      maxAskQty: 1,
      maxIV: 1,
      maxCallBidQtyStrike: -1,
      maxPutBidQtyStrike: -1,
      maxCallAskQtyStrike: -1,
      maxPutAskQtyStrike: -1,
      maxCallIVStrike: -1,
      maxPutIVStrike: -1,
    };
    if (visibleRows.length === 0) return base;
    let maxOI = 1;
    let maxAbsChgOI = 1;
    let maxCall = { v: -1, k: -1 };
    let maxPut = { v: -1, k: -1 };
    let maxCallChg = { v: 0, k: -1 };
    let maxPutChg = { v: 0, k: -1 };
    let minCallChg = { v: 0, k: -1 };
    let minPutChg = { v: 0, k: -1 };
    let maxCallVol = { v: -1, k: -1 };
    let maxPutVol = { v: -1, k: -1 };
    let maxDelta = 0.01;
    let maxGamma = 1e-6;
    let maxTheta = 0.01;
    let maxVega = 0.01;
    let maxCallGamma = { v: -1, k: -1 };
    let maxPutGamma = { v: -1, k: -1 };
    let maxLtp = 0.01;
    let maxChgPct = 0.01;
    let maxBidQty = 1;
    let maxAskQty = 1;
    let maxIV = 0.01;
    let maxCallBidQty = { v: -1, k: -1 };
    let maxPutBidQty = { v: -1, k: -1 };
    let maxCallAskQty = { v: -1, k: -1 };
    let maxPutAskQty = { v: -1, k: -1 };
    let maxCallIV = { v: -1, k: -1 };
    let maxPutIV = { v: -1, k: -1 };
    for (const r of visibleRows) {
      const cIV = r.call.ivCalc ?? r.call.iv ?? 0;
      const pIV = r.put.ivCalc ?? r.put.iv ?? 0;
      maxLtp = Math.max(maxLtp, r.call.ltp, r.put.ltp);
      maxChgPct = Math.max(maxChgPct, Math.abs(r.call.chgPct || 0), Math.abs(r.put.chgPct || 0));
      maxBidQty = Math.max(maxBidQty, r.call.bidQty || 0, r.put.bidQty || 0);
      maxAskQty = Math.max(maxAskQty, r.call.askQty || 0, r.put.askQty || 0);
      maxIV = Math.max(maxIV, cIV, pIV);
      if ((r.call.bidQty || 0) > maxCallBidQty.v) maxCallBidQty = { v: r.call.bidQty || 0, k: r.strike };
      if ((r.put.bidQty || 0) > maxPutBidQty.v) maxPutBidQty = { v: r.put.bidQty || 0, k: r.strike };
      if ((r.call.askQty || 0) > maxCallAskQty.v) maxCallAskQty = { v: r.call.askQty || 0, k: r.strike };
      if ((r.put.askQty || 0) > maxPutAskQty.v) maxPutAskQty = { v: r.put.askQty || 0, k: r.strike };
      if (cIV > maxCallIV.v) maxCallIV = { v: cIV, k: r.strike };
      if (pIV > maxPutIV.v) maxPutIV = { v: pIV, k: r.strike };
      maxDelta = Math.max(maxDelta, Math.abs(r.call.delta), Math.abs(r.put.delta));
      maxGamma = Math.max(maxGamma, r.call.gamma, r.put.gamma);
      maxTheta = Math.max(maxTheta, Math.abs(r.call.theta), Math.abs(r.put.theta));
      maxVega = Math.max(maxVega, Math.abs(r.call.vega), Math.abs(r.put.vega));
      if (r.call.gamma > maxCallGamma.v) maxCallGamma = { v: r.call.gamma, k: r.strike };
      if (r.put.gamma > maxPutGamma.v) maxPutGamma = { v: r.put.gamma, k: r.strike };
      maxOI = Math.max(maxOI, r.call.oi, r.put.oi);
      maxAbsChgOI = Math.max(maxAbsChgOI, Math.abs(r.call.oiChg), Math.abs(r.put.oiChg));
      if (r.call.oi > maxCall.v) maxCall = { v: r.call.oi, k: r.strike };
      if (r.put.oi > maxPut.v) maxPut = { v: r.put.oi, k: r.strike };
      if (r.call.oiChg > maxCallChg.v) maxCallChg = { v: r.call.oiChg, k: r.strike };
      if (r.put.oiChg > maxPutChg.v) maxPutChg = { v: r.put.oiChg, k: r.strike };
      if (r.call.oiChg < minCallChg.v) minCallChg = { v: r.call.oiChg, k: r.strike };
      if (r.put.oiChg < minPutChg.v) minPutChg = { v: r.put.oiChg, k: r.strike };
      if (r.call.volume > maxCallVol.v) maxCallVol = { v: r.call.volume, k: r.strike };
      if (r.put.volume > maxPutVol.v) maxPutVol = { v: r.put.volume, k: r.strike };
    }
    return {
      maxOI,
      maxAbsChgOI,
      maxCallStrike: maxCall.k,
      maxPutStrike: maxPut.k,
      maxCallChgStrike: maxCallChg.k,
      maxPutChgStrike: maxPutChg.k,
      minCallChgStrike: minCallChg.k,
      minPutChgStrike: minPutChg.k,
      maxCallVolStrike: maxCallVol.k,
      maxPutVolStrike: maxPutVol.k,
      maxDelta,
      maxGamma,
      maxTheta,
      maxVega,
      maxCallGammaStrike: maxCallGamma.k,
      maxPutGammaStrike: maxPutGamma.k,
      maxLtp,
      maxChgPct,
      maxBidQty,
      maxAskQty,
      maxIV,
      maxCallBidQtyStrike: maxCallBidQty.k,
      maxPutBidQtyStrike: maxPutBidQty.k,
      maxCallAskQtyStrike: maxCallAskQty.k,
      maxPutAskQtyStrike: maxPutAskQty.k,
      maxCallIVStrike: maxCallIV.k,
      maxPutIVStrike: maxPutIV.k,
    };
  }, [visibleRows]);

  useEffect(() => {
    if (chain && !didScroll.current && atmRef.current) {
      atmRef.current.scrollIntoView({ block: "center" });
      didScroll.current = true;
    }
  }, [chain]);
  useEffect(() => {
    didScroll.current = false;
  }, [chain?.symbol, chain?.expiry, count]);

  if (chainError && !chain)
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-down">
        {chainError}
      </div>
    );
  if (!chain)
    return <div className="flex h-full items-center justify-center text-term-dim">loading…</div>;

  const spot = chain.spot;
  const cols = COLS[tab];

  const renderRow = (row: ChainRow) => {
    const c = row.call;
    const p = row.put;
    const isATM = row.strike === chain.atmStrike;
    const cbg = row.strike < spot ? "bg-call/40" : "";
    const pbg = row.strike > spot ? "bg-put/40" : "";
    const hotCE = hotMap.get(`${row.strike}:CE`) ?? null;
    const hotPE = hotMap.get(`${row.strike}:PE`) ?? null;
    const ctx: Ctx = {
      maxOI: oiStats.maxOI,
      maxAbsChgOI: oiStats.maxAbsChgOI,
      isMaxCallOI: row.strike === oiStats.maxCallStrike,
      isMaxPutOI: row.strike === oiStats.maxPutStrike,
      isMaxCallChg: row.strike === oiStats.maxCallChgStrike,
      isMaxPutChg: row.strike === oiStats.maxPutChgStrike,
      isMinCallChg: row.strike === oiStats.minCallChgStrike,
      isMinPutChg: row.strike === oiStats.minPutChgStrike,
      isMaxCallVol: row.strike === oiStats.maxCallVolStrike,
      isMaxPutVol: row.strike === oiStats.maxPutVolStrike,
      maxDelta: oiStats.maxDelta,
      maxGamma: oiStats.maxGamma,
      maxTheta: oiStats.maxTheta,
      maxVega: oiStats.maxVega,
      isMaxCallGamma: row.strike === oiStats.maxCallGammaStrike,
      isMaxPutGamma: row.strike === oiStats.maxPutGammaStrike,
      maxLtp: oiStats.maxLtp,
      maxChgPct: oiStats.maxChgPct,
      maxBidQty: oiStats.maxBidQty,
      maxAskQty: oiStats.maxAskQty,
      maxIV: oiStats.maxIV,
      isMaxCallBidQty: row.strike === oiStats.maxCallBidQtyStrike,
      isMaxPutBidQty: row.strike === oiStats.maxPutBidQtyStrike,
      isMaxCallAskQty: row.strike === oiStats.maxCallAskQtyStrike,
      isMaxPutAskQty: row.strike === oiStats.maxPutAskQtyStrike,
      isMaxCallIV: row.strike === oiStats.maxCallIVStrike,
      isMaxPutIV: row.strike === oiStats.maxPutIVStrike,
      hotCE,
      hotPE,
    };
    const hotRow = tab === "greeks" && (hotCE || hotPE);
    return (
      <tr
        key={row.strike}
        ref={isATM ? atmRef : undefined}
        className={`hover:bg-term-panel/60 ${
          isATM
            ? "bg-term-accent/20 font-semibold text-term-text outline outline-2 -outline-offset-2 outline-term-accent"
            : ""
        } ${hotRow ? "bg-amber-500/10" : ""}`}
      >
        {/* ---- CALL side ---- */}
        <td className={`cell border-l-2 border-up/40 text-left ${cbg}`}>
          <QuickTrade
            strike={row.strike}
            ot="CE"
            lots={lots}
            onTicket={() => setTicket({ strike: row.strike, ot: "CE", ltp: c.ltp })}
          />
        </td>
        {cols.map((col) => (
          <td key={"c" + col.key} className={`relative cell text-term-dim ${cbg}`}>
            {col.render(c, "l", ctx)}
          </td>
        ))}

        {/* ---- STRIKE ---- */}
        <td
          className={`num border-x-2 px-2 text-center text-xs font-semibold ${
            isATM
              ? "border-term-accent bg-term-accent text-white"
              : "border-term-border bg-term-bg text-term-text"
          }`}
        >
          {isATM ? (
            <span className="inline-flex items-center gap-1">
              {sk(row.strike)}
              <span className="rounded-sm bg-white/25 px-1 text-[8px] font-bold leading-none tracking-wide">
                ATM
              </span>
            </span>
          ) : (
            sk(row.strike)
          )}
        </td>

        {/* ---- PUT side ---- */}
        {[...cols].reverse().map((col) => (
          <td key={"p" + col.key} className={`relative cell text-left text-term-dim ${pbg}`}>
            {col.render(p, "r", ctx)}
          </td>
        ))}
        <td className={`cell border-r-2 border-down/40 text-right ${pbg}`}>
          <QuickTrade
            strike={row.strike}
            ot="PE"
            lots={lots}
            onTicket={() => setTicket({ strike: row.strike, ot: "PE", ltp: p.ltp })}
          />
        </td>
      </tr>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
        <div className="seg">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={tab === t.key ? "on" : ""}
            >
              {t.label}
            </button>
          ))}
        </div>

        <span className="ml-1">Strikes</span>
        <div className="seg">
          {[10, 20, 30].map((n) => (
            <button key={n} onClick={() => setCount(n)} className={count === n ? "on" : ""}>
              {n}
            </button>
          ))}
        </div>

        <span className="ml-1">Lots</span>
        <div className="seg">
          <button onClick={() => setLots((l) => Math.max(1, l - 1))}>−</button>
          <button className="on pointer-events-none">{lots}</button>
          <button onClick={() => setLots((l) => l + 1)}>+</button>
        </div>

        <span className="ml-3 text-up">■ CALLS</span>
        <span className="text-down">■ PUTS</span>
        {tab === "oi" ? (
          <span className="ml-auto">
            <span className="text-down">■ Call OI = Resistance</span>
            {"  "}
            <span className="text-up">■ Put OI = Support</span>
            {"  "}
            <span className="text-term-dim">R/S = max wall ·</span>{" "}
            <span className="text-amber-400">▲ biggest build · ▽ biggest unwind</span>
          </span>
        ) : tab === "greeks" ? (
          <span className="ml-auto">
            <span className="text-term-accent">! delta jump</span> ·{" "}
            <span className="text-amber-400">▲ gamma spike</span> ·{" "}
            <span className="text-down">▼ gamma collapse</span>{" "}
            <span className="text-term-dim">→ Unusual Activity 🔔</span>
          </span>
        ) : (
          <span className="ml-auto text-term-dim">
            from STRIKE outward: LTP · Chg% · Δ · Γ · Θ · V{"  "}
            <span className="text-up">■ up</span> <span className="text-down">■ down</span> bars
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="oc-grid">
          <thead className="sticky top-0 z-10 bg-term-panel text-term-dim">
            <tr>
              <th
                colSpan={cols.length + 1}
                className="border-b-2 border-up/50 bg-up/15 py-1 text-center text-[11px] font-bold uppercase tracking-wider text-up"
              >
                Calls ▸{" "}
                <span className="num text-[9px] font-semibold normal-case text-up/80">
                  Total OI {lakhs(chain.totals.ceOI)}
                </span>
              </th>
              <th className="border-x-2 border-term-border bg-term-bg" />
              <th
                colSpan={cols.length + 1}
                className="border-b-2 border-down/50 bg-down/15 py-1 text-center text-[11px] font-bold uppercase tracking-wider text-down"
              >
                ◂ Puts{" "}
                <span className="num text-[9px] font-semibold normal-case text-down/80">
                  Total OI {lakhs(chain.totals.peOI)}
                </span>
              </th>
            </tr>
            <tr>
              <th className="border-l-2 border-up/50 text-left">Trade</th>
              {cols.map((col) => (
                <th key={"hc" + col.key} className="text-right">
                  {col.label}
                </th>
              ))}
              <th className="border-x-2 border-term-border bg-term-bg text-center font-semibold text-term-text">
                STRIKE
              </th>
              {[...cols].reverse().map((col) => (
                <th key={"hp" + col.key} className="text-left">
                  {col.label}
                </th>
              ))}
              <th className="border-r-2 border-down/50 text-right">Trade</th>
            </tr>
          </thead>
          <tbody>{visibleRows.map(renderRow)}</tbody>
        </table>
      </div>

      {ticket && (
        <OrderTicket
          strike={ticket.strike}
          optionType={ticket.ot}
          ltp={ticket.ltp}
          onClose={() => setTicket(null)}
        />
      )}
    </div>
  );
}
