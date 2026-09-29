import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { isViewer } from "../lib/auth";
import { api } from "../lib/api";
import { nf, signColor, sk } from "../lib/format";
import {
  strategyPnlCurve,
  legPnlAt,
  legPriceAt,
  positionValue,
  bsGreeks,
} from "../lib/bs";
import { ivRegime, ivFit } from "../lib/iv";
import type {
  Analysis,
  OptionType,
  SavedStrategy,
  StrategyLeg,
  StrategySchedule,
} from "../types";
import { PayoffChart } from "./PayoffChart";
import { BacktestPanel } from "./BacktestPanel";
import { StrategyChart } from "./StrategyChart";
import { SelectMenu } from "./SelectMenu";
import { VSplit, clamp, readNum } from "./VSplit";

// IV points: +1 = IV 12% -> 13% (asked 25-Sep: 1-5% steps instead of 10 / 20 / 30)
const IV_SHIFT_CHIPS = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
const BUILDER_W_LS = "layout.builderW";

/** A Builder section that folds away (Hedge finder, Bracket, Schedule, Saved); remembers open / closed. */
function Fold({
  id,
  title,
  titleCls = "",
  badge,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  titleCls?: string;
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const key = `sb.fold.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? defaultOpen : v === "1";
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !o;
    });
  return (
    <div className="border-t border-term-border">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-term-dim hover:bg-term-bg/40 hover:text-term-text"
      >
        <span className={`inline-block w-2.5 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        <span className={titleCls}>{title}</span>
        {badge && (
          <span className="ml-auto rounded bg-term-accent/15 px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-term-accent">
            {badge}
          </span>
        )}
      </button>
      {open && <div className="px-2 pb-2.5">{children}</div>}
    </div>
  );
}

/** compact labelled number input for the hedge finder's advanced targets */
function AdvNum({
  label,
  value,
  onChange,
  title,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  title?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-1 text-[10px] text-term-dim" title={title}>
      {label}
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="off"
        className="w-16 rounded border border-term-border bg-term-bg px-1 py-0.5 text-right text-2xs num text-term-text outline-none focus:border-term-accent"
      />
    </label>
  );
}

/** one column of the strategy-details table: label on top, value below, bordered */
function StatCol({
  label,
  value,
  cls = "",
  title,
}: {
  label: string;
  value: React.ReactNode;
  cls?: string;
  title?: string;
}) {
  return (
    <td className="border-r border-term-border/60 px-3 py-1.5 text-left last:border-r-0" title={title}>
      <div className="text-[9px] uppercase tracking-wide text-term-dim">{label}</div>
      <div className={`num whitespace-nowrap text-sm font-semibold ${cls}`}>{value}</div>
    </td>
  );
}

/** ‹ strike › : step one strike down / up; the strike itself still opens the full list.
 *  Shows the distance from ATM ("ATM", "ATM+2", "ATM-1"). */
/** A price box that keeps what is being typed ("125." on the way to "125.50") and only passes on a
 *  real number -- a type=number input reports a half-typed "125." as empty, which cleared the leg's
 *  price. Blank = no price (use the live LTP). Decimal keypad on phones. */
function PriceInput({
  value,
  onChange,
  placeholder,
  className,
  id,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  // follow outside changes (↺ back to live, a strategy loaded) but not our own keystrokes
  useEffect(() => {
    setDraft((d) => {
      const cur = d.trim() === "" ? null : Number(d);
      return cur === (value ?? null) ? d : value == null ? "" : String(value);
    });
  }, [value]);
  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => {
        let v = e.target.value.replace(/[^\d.]/g, "");
        const dot = v.indexOf(".");
        if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "").slice(0, 2);
        setDraft(v);
        if (v === "") onChange(null);
        else if (v !== "." && Number.isFinite(Number(v))) onChange(Number(v));
      }}
      onBlur={() => setDraft(value == null ? "" : String(value))}
      className={className}
    />
  );
}

function StrikeStepper({
  value,
  strikes,
  atm,
  onChange,
}: {
  value: number;
  strikes: number[];
  atm: number;
  onChange: (k: number) => void;
}) {
  const sorted = strikes.length ? strikes : [value];
  const i = sorted.indexOf(value);
  const ai = sorted.indexOf(atm);
  const off = i >= 0 && ai >= 0 ? i - ai : null;
  const tag = off == null ? "" : off === 0 ? "ATM" : `ATM${off > 0 ? "+" : ""}${off}`;
  const step = (d: number) => {
    const j = (i >= 0 ? i : sorted.findIndex((k) => k > value)) + d;
    if (j >= 0 && j < sorted.length) onChange(sorted[j]);
  };
  const btn =
    "flex h-7 w-7 items-center justify-center rounded border border-term-border text-[15px] font-bold text-term-text active:bg-term-accent/25 disabled:opacity-30";
  return (
    <span className="inline-flex items-center gap-1">
      <button onClick={() => step(-1)} disabled={i === 0} className={btn} title="Previous strike" aria-label="Previous strike">
        ‹
      </button>
      <SelectMenu
        value={value}
        options={sorted.map((k) => [`${sk(k)}${k === atm ? "  (ATM)" : ""}`, k] as [string, number])}
        onChange={(k) => onChange(Number(k))}
        title="Strike"
        width={96}
        highlightValue={atm}
      />
      <button
        onClick={() => step(1)}
        disabled={i === sorted.length - 1}
        className={btn}
        title="Next strike"
        aria-label="Next strike"
      >
        ›
      </button>
      {tag && off !== 0 && <span className="whitespace-nowrap text-[10px] font-semibold text-term-dim">{tag}</span>}
    </span>
  );
}

export function StrategyBuilder() {
  const symbol = useStore((s) => s.symbol);
  const chain = useStore((s) => s.chain);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const selectExpiry = useStore((s) => s.selectExpiry);
  const orderMode = useStore((s) => s.orderMode);
  const broker = useStore((s) => s.broker);
  const requestStrategyExecute = useStore((s) => s.requestStrategyExecute);
  const expiry = useStore((s) => s.expiry) ?? chain?.expiry ?? null;
  const expiries = chain?.expiries ?? [];

  const [symChoices, setSymChoices] = useState<string[]>([]);
  useEffect(() => {
    api.symbols().then(
      (d) => setSymChoices([...new Set([...(d.indices ?? []), ...(d.fo ?? []), ...(d.defaults ?? [])])].sort()),
      () => {}
    );
  }, []);

  const [legs, setLegs] = useState<StrategyLeg[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<Record<string, StrategyLeg[]>>({});
  const [saved, setSaved] = useState<SavedStrategy[]>([]);
  const symClass = useStore((s) => s.symClass);
  const symClassOk = useStore((s) => s.symClassOk);
  const symOptions = useMemo(
    () =>
      [...new Set([...symChoices, symbol, ...saved.map((s) => s.symbol)])]
        .filter(Boolean)
        .filter((s) => s === symbol || symClassOk(s))
        .sort(),
    [symChoices, symbol, saved, symClass]
  );
  const [saveName, setSaveName] = useState("");
  const timer = useRef<number | null>(null);

  // ---- scheduled run (time-based entry / exit) ----
  const [schedEntry, setSchedEntry] = useState("");
  const [schedExit, setSchedExit] = useState("");
  const [schedRepeat, setSchedRepeat] = useState(false);
  const [schedMode, setSchedMode] = useState<"paper" | "live">("paper");
  const [schedules, setSchedules] = useState<StrategySchedule[]>([]);
  const loadSchedules = useCallback(() => {
    api.strategySchedules().then(
      (d) => setSchedules(d.schedules),
      () => {}
    );
  }, []);
  useEffect(() => {
    if (isViewer()) return; // schedules place orders -- the owner's only
    loadSchedules();
    const id = window.setInterval(loadSchedules, 30000);
    return () => window.clearInterval(id);
  }, [loadSchedules]);

  // the loss cap as typed: blank until the user enters one (a number input bound to a
  // Number showed an undeletable "0" when cleared)
  const [hedgeMaxStr, setHedgeMaxStr] = useState("");
  const hedgeMax = parseFloat(hedgeMaxStr) || 0;
  const [hedgeAdvOpen, setHedgeAdvOpen] = useState(false);
  const [hedgeAdv, setHedgeAdv] = useState<{
    maxProfitCap: string;
    minPop: string;
    maxAbsDelta: string;
    maxAbsTheta: string;
    maxAbsVega: string;
    maxAbsGamma: string;
    maxHedgeIv: string;
  }>({
    maxProfitCap: "",
    minPop: "",
    maxAbsDelta: "",
    maxAbsTheta: "",
    maxAbsVega: "",
    maxAbsGamma: "",
    maxHedgeIv: "",
  });
  const [hedge, setHedge] = useState<Awaited<ReturnType<typeof api.findHedge>> | null>(null);
  const [hedgeBusy, setHedgeBusy] = useState(false);
  // one-click delta-neutral hedge via the underlying future (delta=1/unit,
  // no gamma/theta/vega drag) -- distinct from the loss-cap hedge finder
  // above, which only treats delta as an optional filter, not the goal
  const [deltaHedge, setDeltaHedge] = useState<{
    leg: StrategyLeg;
    label: string;
    cost: number;
    resultMaxLoss: number;
    resultMaxProfit: number;
    resultMaxProfitUnbounded: boolean;
    resultPop: number | null;
    resultGreeks: Record<string, number>;
  } | null>(null);
  const [deltaHedgeBusy, setDeltaHedgeBusy] = useState(false);
  const [deltaHedgeNote, setDeltaHedgeNote] = useState<string | null>(null);
  // which instrument neutralizes the delta: the future (pure delta=1/unit,
  // no gamma/theta/vega drag) or the ATM call/put (adds its own gamma/theta/vega)
  const [hedgeInstrument, setHedgeInstrument] = useState<"FUT" | "CE" | "PE">("FUT");
  const [fromBroker, setFromBroker] = useState(false);
  const [mult, setMult] = useState(1);

  const scaled = useCallback(
    (ls: StrategyLeg[]) =>
      ls.map(({ held: _h, ...l }) => ({ ...l, lots: Math.max(1, l.lots * mult) })),
    [mult]
  );
  // legs to actually send on Execute: skip already-open ("held") positions
  // unless the user ticks "also execute held legs".
  const [executeHeld, setExecuteHeld] = useState(false);

  // paper bracket: after executing, attach an auto SL / target to each fresh
  // leg via check_stops() — either ₹ amount (split by qty) or premium points
  const [slVal, setSlVal] = useState("");
  const [tgtVal, setTgtVal] = useState("");
  const [slTgtBasis, setSlTgtBasis] = useState<"amount" | "points">("amount");
  const [panel, setPanel] = useState<"payoff" | "schart" | "sgreeks" | "backtest">("payoff");
  const [payoffTab, setPayoffTab] = useState<"stats" | "chart" | "table" | "legs" | "greeks">(
    "chart"
  );
  // folded phone (layout "B", 28-Sep): chart first, then Legs | P&L table | Greeks under it
  const [phoneTab, setPhoneTab] = useState<"legs" | "table" | "greeks">("table");
  // P&L table time view (Sensibull-style): Today + Expiry, one column per trading day, or by the hour
  const [timeMode, setTimeMode] = useState<"basic" | "day" | "hour">("basic");
  const [hourDay, setHourDay] = useState(0); // which trading day the hour view shows
  const [phonePt, setPhonePt] = useState("now"); // phone: the point in time the middle column shows
  const [phoneRows, setPhoneRows] = useState(3); // P&L table: rows each side of spot
  // width of the leg-editor column vs. the payoff/chart column, drag-resizable like the watchlist panel
  const [builderW, setBuilderW] = useState(() => readNum(BUILDER_W_LS, 330));
  useEffect(() => {
    try {
      localStorage.setItem(BUILDER_W_LS, String(builderW));
    } catch {}
  }, [builderW]);
  const bumpBuilder = useCallback((dx: number) => setBuilderW((w) => clamp(w + dx, 260, 600)), []);
  const [strikeSpan, setStrikeSpan] = useState(0); // ATM ± N strikes in the P&L table; 0 = All
  const [tableInterval, setTableInterval] = useState(0); // 0 = chain strikes; else ₹ step
  const [showPct, setShowPct] = useState(true); // show the "Move %" column
  const [gMulLot, setGMulLot] = useState(true); // greeks × lot size
  const [gMulQty, setGMulQty] = useState(true); // greeks × number of lots
  const [manualPnl, setManualPnl] = useState(0); // booked / manual P&L offset added to every P&L
  const [manualStr, setManualStr] = useState("");
  // what the loaded strategy is called (template / saved name / "Live positions"), for the header
  const [stratName, setStratName] = useState("");
  const [ivSeries, setIvSeries] = useState<number[]>([]);
  // "time to expiry" payoff: days from today (0 = now / T+0, dte = expiry)
  const [tDays, setTDays] = useState(0);
  // "what-if IV shift" payoff: % change applied to every leg's IV (0 = current IV)
  const [ivShift, setIvShift] = useState(0);
  // "target price" — the underlying level the leg tables / stats project to
  const [tPrice, setTPrice] = useState(0);
  // customise "+ Add leg": pick type / strike / side / lots for the next leg
  const [newLegOT, setNewLegOT] = useState<OptionType>("CE");
  const [newLegSide, setNewLegSide] = useState<"BUY" | "SELL">("BUY");
  const [newLegLots, setNewLegLots] = useState(1);
  const [newLegPrice, setNewLegPrice] = useState<number | null>(null); // blank = live LTP
  const [newLegStrike, setNewLegStrike] = useState(0); // 0 => ATM
  const [addingLeg, setAddingLeg] = useState(false); // collapse the add-leg form
  const doExecute = useCallback(async () => {
    const toRun = executeHeld ? legs : legs.filter((l) => !l.held);
    const ls = scaled(toRun);
    if (ls.length === 0) return; // everything is a held position and "execute held" is off
    const exp = expiry ?? chain?.expiry;
    const sl = parseFloat(slVal);
    const tgt = parseFloat(tgtVal);
    const hasBracket = sl > 0 || tgt > 0;
    if (orderMode === "live" || !hasBracket || !exp || ls.length === 0) {
      requestStrategyExecute(ls);
      return;
    }
    const before = new Set((useStore.getState().paper?.positions ?? []).map((p) => p.id));
    const r = await api.executeStrategy({ symbol, expiry: exp, legs: ls, mode: "paper" });
    useStore.setState({ paper: r.paper });
    const fresh = (r.paper.positions ?? []).filter((p) => !before.has(p.id));
    const totalQty = fresh.reduce((s, p) => s + Math.abs(p.qty), 0) || 1;
    for (const p of fresh) {
      // points basis: same premium-points move on every leg
      // amount basis: split the ₹ target/SL across legs by qty
      const w = Math.abs(p.qty) / totalQty;
      await api.setStop({
        position_id: p.id,
        mode: slTgtBasis,
        value: sl > 0 ? (slTgtBasis === "points" ? sl : sl * w) : 0,
        trailValue: 0,
        targetValue: tgt > 0 ? (slTgtBasis === "points" ? tgt : tgt * w) : 0,
      });
    }
    useStore.setState({ paper: await api.paper() });
  }, [
    scaled,
    legs,
    executeHeld,
    slVal,
    tgtVal,
    slTgtBasis,
    expiry,
    chain?.expiry,
    orderMode,
    symbol,
    requestStrategyExecute,
  ]);

  const strikes = useMemo(
    () => (chain ? chain.rows.map((r) => r.strike) : []),
    [chain]
  );
  const atm = chain?.atmStrike ?? 0;
  const heldCount = legs.filter((l) => l.held).length;
  const runLegCount = executeHeld ? legs.length : legs.length - heldCount;

  // keep "Current P&L" live for a running position -- the other runAnalyze
  // triggers only fire on a leg/mult/symbol change, so a held leg's P&L
  // would otherwise go stale the moment you stop touching the builder.
  useEffect(() => {
    if (heldCount === 0) return;
    const t = window.setInterval(() => runAnalyze(scaled(legs)), 8000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldCount > 0, legs, scaled]);

  useEffect(() => {
    api.strategyTemplates(symbol, expiry ?? undefined).then(
      (d) => setTemplates(d.templates),
      () => {}
    );
  }, [symbol, expiry]);

  useEffect(() => {
    if (isViewer()) return; // the saved strategies are the owner's
    api.listStrategies().then((d) => setSaved(d.strategies), () => {});
  }, []);

  const runAnalyze = useCallback(
    (nextLegs: StrategyLeg[]) => {
      if (timer.current) window.clearTimeout(timer.current);
      if (nextLegs.length === 0) {
        setAnalysis(null);
        return;
      }
      timer.current = window.setTimeout(() => {
        setBusy(true);
        api
          .analyzeStrategy({ symbol, expiry: expiry ?? undefined, legs: nextLegs, points: 401 })
          .then(
            (a) => {
              setAnalysis(a);
              setErr(null);
            },
            (e) => setErr(String(e.message || e))
          )
          .finally(() => setBusy(false));
      }, 250);
    },
    [symbol, expiry]
  );

  const update = (next: StrategyLeg[]) => {
    setLegs(next);
    setHedge(null);
    setDeltaHedge(null);
    runAnalyze(scaled(next));
  };

  // legs queued from the option chain ("＋ Builder" on a strike)
  const builderQueue = useStore((s) => s.builderQueue);
  const clearBuilderQueue = useStore((s) => s.clearBuilderQueue);
  const handledQueue = useRef<StrategyLeg[] | null>(null);
  useEffect(() => {
    if (!builderQueue.length || handledQueue.current === builderQueue) return;
    handledQueue.current = builderQueue;
    setHedge(null);
    setLegs((cur) => {
      const merged = [...cur];
      for (const q of builderQueue) {
        const i = merged.findIndex(
          (l) => l.optionType === q.optionType && l.strike === q.strike && l.side === q.side
        );
        if (i >= 0) merged[i] = { ...merged[i], lots: merged[i].lots + q.lots };
        else merged.push({ ...q });
      }
      runAnalyze(scaled(merged));
      return merged;
    });
    clearBuilderQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builderQueue]);

  useEffect(() => {
    if (legs.length) runAnalyze(scaled(legs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mult]);

  const findHedge = async () => {
    if (!legs.length || !expiry) return;
    if (!(hedgeMax > 0)) return alert("Enter the max loss (₹) to cap the position at.");
    setHedgeBusy(true);
    const n = (v: string) => (v.trim() === "" ? undefined : Number(v));
    try {
      setHedge(
        await api.findHedge({
          symbol,
          expiry,
          legs: scaled(legs),
          maxLoss: hedgeMax,
          maxProfitCap: n(hedgeAdv.maxProfitCap),
          minPop: n(hedgeAdv.minPop),
          maxAbsDelta: n(hedgeAdv.maxAbsDelta),
          maxAbsTheta: n(hedgeAdv.maxAbsTheta),
          maxAbsVega: n(hedgeAdv.maxAbsVega),
          maxAbsGamma: n(hedgeAdv.maxAbsGamma),
          maxHedgeIv: n(hedgeAdv.maxHedgeIv),
        })
      );
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setHedgeBusy(false);
    }
  };

  const applyHedge = (leg: StrategyLeg | StrategyLeg[]) => {
    const add = Array.isArray(leg) ? leg : [leg];
    update([...legs, ...add.map((l) => ({ ...l }))]);
  };

  const findDeltaHedge = async () => {
    if (!analysis || !chain || !legs.length) return;
    const lotSize = chain.lotSize || 1;
    const atmRow = chain.rows.find((r) => r.strike === chain.atmStrike);
    // delta contributed per ONE lot of the chosen hedge instrument. Futures
    // track the underlying 1:1; an ATM call/put's own per-share delta (from
    // the live chain) scaled up by lot size -- much smaller than a future's,
    // so it takes more lots, and it drags its own gamma/theta/vega along.
    const perLotDelta =
      hedgeInstrument === "FUT" ? lotSize : (atmRow?.[hedgeInstrument === "CE" ? "call" : "put"].delta ?? 0) * lotSize;
    if (Math.abs(perLotDelta) < 0.01 * lotSize) {
      setDeltaHedge(null);
      setDeltaHedgeNote(
        hedgeInstrument === "FUT"
          ? "Couldn't read the future's delta."
          : `The ATM ${hedgeInstrument}'s delta is ~0 right now — pick a different instrument.`
      );
      return;
    }
    // signed lot count: >0 = BUY that many, <0 = SELL that many, of whichever
    // instrument is picked -- unifies FUT/CE/PE under one formula since a
    // put's per-lot delta is itself negative
    const signedLots = -analysis.greeks.delta / perLotDelta;
    if (Math.round(signedLots) === 0) {
      setDeltaHedge(null);
      setDeltaHedgeNote("Already ~delta-neutral — under one lot either way, nothing to hedge.");
      return;
    }
    setDeltaHedgeNote(null);
    // `update()` runs every leg through scaled() (lots * mult) before
    // sending it to the engine, so a leg computed against the already-
    // scaled analysis.greeks.delta needs to be pre-divided by mult, or
    // applying it would double the hedge size whenever mult > 1
    const rawLots = Math.max(1, Math.round(Math.abs(signedLots) / Math.max(1, mult)));
    const side: "BUY" | "SELL" = signedLots > 0 ? "BUY" : "SELL";
    const leg: StrategyLeg =
      hedgeInstrument === "FUT"
        ? { optionType: "FUT", strike: 0, side, lots: rawLots }
        : { optionType: hedgeInstrument, strike: chain.atmStrike, side, lots: rawLots };
    setDeltaHedgeBusy(true);
    try {
      const result = await api.analyzeStrategy({
        symbol,
        expiry: expiry ?? undefined,
        legs: scaled([...legs, leg]),
      });
      const wholeLots = Math.round(Math.abs(signedLots));
      const perUnitPrice =
        hedgeInstrument === "FUT" ? chain.forward ?? chain.spot ?? 0 : atmRow?.[hedgeInstrument === "CE" ? "call" : "put"].ltp ?? 0;
      setDeltaHedge({
        leg,
        label: `${side} ${wholeLots} lot${wholeLots > 1 ? "s" : ""} ${symbol}${
          hedgeInstrument === "FUT" ? " FUT" : ` ${chain.atmStrike} ${hedgeInstrument}`
        }`,
        cost: (side === "BUY" ? 1 : -1) * perUnitPrice * lotSize * rawLots * Math.max(1, mult),
        resultMaxLoss: result.maxLoss,
        resultMaxProfit: result.maxProfit,
        resultMaxProfitUnbounded: result.maxProfitUnbounded,
        resultPop: result.pop,
        resultGreeks: result.greeks,
      });
      setErr(null);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setDeltaHedgeBusy(false);
    }
  };

  useEffect(() => {
    if (legs.length) runAnalyze(scaled(legs));
    setNewLegStrike(0); // back to ATM for the new symbol/expiry
    // re-analyze when the terminal symbol/expiry changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, expiry]);

  const addLeg = (ot: OptionType = newLegOT, side: "BUY" | "SELL" = newLegSide) =>
    update([
      ...legs,
      {
        optionType: ot,
        strike:
          ot === "FUT"
            ? 0
            : newLegStrike || atm || strikes[Math.floor(strikes.length / 2)] || 0,
        side,
        lots: Math.max(1, newLegLots || 1),
        ...(newLegPrice != null ? { price: newLegPrice } : {}),
      },
    ]);

  const setLeg = (i: number, patch: Partial<StrategyLeg>) =>
    update(legs.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const removeLeg = (i: number) => update(legs.filter((_, idx) => idx !== i));

  const loadTemplate = (name: string) => {
    if (name && templates[name]) {
      setStratName(name);
      setFromBroker(false);
      setAddingLeg(false);
      update(templates[name].map((l) => ({ ...l })));
    }
  };

  const loadFromPaper = () =>
    api.strategyFromPaper().then(
      (d) => {
        setStratName("Paper positions");
        setFromBroker(false);
        setExecuteHeld(false);
        selectSymbol(d.symbol, true);
        selectExpiry(d.expiry);
        setLegs(d.legs.map((l) => ({ ...l, held: true })));
        setAnalysis(d.analysis);
        setErr(null);
      },
      (e) => setErr(String(e.message || e))
    );

  const loadFromBroker = () =>
    api.strategyFromBroker(symbol).then(
      (d) => {
        setStratName("Live positions");
        setFromBroker(true);
        setExecuteHeld(false);
        selectSymbol(d.symbol, true);
        selectExpiry(d.expiry);
        setLegs(d.legs.map((l) => ({ ...l, held: true })));
        setAnalysis(d.analysis);
        setErr(null);
      },
      (e) => setErr(String(e.message || e))
    );

  const doSave = () => {
    if (!saveName.trim() || !legs.length || !expiry) return;
    api
      .saveStrategy({
        name: saveName.trim(),
        symbol,
        expiry,
        legs: legs.map(({ held: _h, ...l }) => l),
      })
      .then((d) => {
        setSaved(d.strategies);
        setSaveName("");
      });
  };

  const loadSaved = (s: SavedStrategy) => {
    setStratName(s.name);
    update(s.legs.map((l) => ({ ...l })));
  };
  const delSaved = (id: string) =>
    api.deleteStrategy(id).then((d) => setSaved(d.strategies));

  const addSchedule = async () => {
    const exp = expiry ?? chain?.expiry;
    if (!exp || legs.length === 0 || (!schedEntry && !schedExit)) return;
    try {
      const d = await api.strategyScheduleAdd({
        symbol,
        expiry: exp,
        legs: scaled(legs),
        entryTime: schedEntry || null,
        exitTime: schedExit || null,
        repeat: schedRepeat,
        mode: schedMode,
      });
      setSchedules(d.schedules);
      setSchedEntry("");
      setSchedExit("");
    } catch {
      /* ignore */
    }
  };
  const delSchedule = (id: string) =>
    api.strategyScheduleDel(id).then((d) => setSchedules(d.schedules), () => {});

  // clamp the "time to expiry" slider whenever the position / expiry changes
  // exact time left (the server's fractional days, e.g. 1.3 or 0.3 on expiry morning) for PRICING;
  // `dte` = whole-day steps for the slider, whose last step is always expiry
  const dteExact = Math.max(analysis?.dte ?? 0, 0);
  const dte = Math.max(1, Math.ceil(dteExact - 0.01));
  /** days left after moving `t` whole days ahead (0 at the slider's last step = expiry) */
  const daysLeft = (t: number) => (t >= dte ? 0 : Math.max(dteExact - t, 0));
  /** "1.3d left" / "7h left" */
  const leftLbl = (t: number) => {
    const d = daysLeft(t);
    return d <= 0 ? "0d left" : d < 1 ? `${Math.max(1, Math.round(d * 24))}h left` : `${nf(d, 1)}d left`;
  };
  useEffect(() => {
    setTDays((d) => Math.min(d, dte));
  }, [dte, analysis?.symbol, analysis?.expiry, legs.length]);

  // intermediate payoff curve at (dte - tDays) days left / ivShift% IV, computed client-side
  const tPnl = useMemo(() => {
    if (!analysis || (tDays <= 0 && !ivShift)) return null;
    const remYears = daysLeft(tDays) / 365;
    return strategyPnlCurve(analysis.legs, analysis.x, remYears, ivShift);
  }, [analysis, tDays, dte, dteExact, ivShift]);
  const tDate = new Date(Date.now() + tDays * 86400000);
  const tDateLbl = tDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  const remYears = daysLeft(tDays) / 365;
  // combined what-if label for the chart legend, e.g. "T+7d (18 Sep) · +20% IV" or "now · -15% IV"
  const tLineLabel = tPnl
    ? [tDays > 0 ? `T+${tDays}d (${tDateLbl})` : "now", ivShift ? `${ivShift > 0 ? "+" : ""}${ivShift}% IV` : ""]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  // short column-header variant for the strikewise payoff table
  const tvColLabel =
    tDays > 0 && ivShift
      ? `${tDateLbl} · IV ${ivShift > 0 ? "+" : ""}${ivShift}%`
      : tDays > 0
      ? `On ${tDateLbl}`
      : `IV ${ivShift > 0 ? "+" : ""}${ivShift}%`;
  // "@ date" label for the Legs P&L / Greeks tab headers
  const tLegLabel =
    (tDays === 0 ? "now" : tDateLbl) + (ivShift ? ` · IV ${ivShift > 0 ? "+" : ""}${ivShift}%` : "");

  // reset the target price to spot when the position / symbol changes
  useEffect(() => {
    if (analysis) setTPrice(Math.round(analysis.spot));
  }, [analysis?.symbol, analysis?.expiry]);
  const tgtPrice = tPrice > 0 ? tPrice : analysis?.spot ?? 0;

  // position time value / intrinsic value (Sensibull-style), current
  const posVal = useMemo(
    () => (analysis ? positionValue(analysis.legs, analysis.spot, dteExact / 365) : null),
    [analysis, dteExact]
  );

  // per-leg P&L at the (target price, target date)
  const legRows = useMemo(() => {
    if (!analysis) return [];
    const nowY = dteExact / 365;
    return analysis.legs.map((leg) => ({
      leg,
      label: `${leg.side === "BUY" ? "B" : "S"} ${leg.lots}×${
        leg.optionType === "FUT" ? "FUT" : `${sk(leg.strike)}${leg.optionType}`
      }`,
      entry: leg.entry,
      ltp: legPriceAt(leg, analysis.spot, nowY),
      tgtPx: legPriceAt(leg, tgtPrice, remYears, ivShift),
      tgtPnl: legPnlAt(leg, tgtPrice, remYears, ivShift),
    }));
  }, [analysis, tgtPrice, remYears, dteExact, ivShift]);

  // per-leg greeks at the target (price, date)
  const greekRows = useMemo(() => {
    if (!analysis) return [];
    const lot = analysis.lotSize || 1;
    return analysis.legs.map((leg) => {
      const ivEff = ivShift ? Math.max(0.5, (leg.iv || 0) + ivShift) : leg.iv || 0;
      const g =
        leg.optionType === "FUT"
          ? { delta: 1, gamma: 0, theta: 0, vega: 0 }
          : bsGreeks(leg.optionType, tgtPrice, leg.strike, remYears, ivEff / 100);
      const sgn = leg.side === "BUY" ? 1 : -1;
      const mul = sgn * (gMulLot ? lot : 1) * (gMulQty ? leg.lots : 1);
      return {
        leg,
        label: `${leg.side === "BUY" ? "B" : "S"} ${leg.lots}×${
          leg.optionType === "FUT" ? "FUT" : `${sk(leg.strike)}${leg.optionType}`
        }`,
        delta: g.delta * mul,
        gamma: g.gamma * mul,
        theta: g.theta * mul,
        vega: g.vega * mul,
      };
    });
  }, [analysis, tgtPrice, remYears, gMulLot, gMulQty, ivShift]);
  const greekTot = greekRows.reduce(
    (a, r) => ({
      delta: a.delta + r.delta,
      gamma: a.gamma + r.gamma,
      theta: a.theta + r.theta,
      vega: a.vega + r.vega,
    }),
    { delta: 0, gamma: 0, theta: 0, vega: 0 }
  );
  const legTot = legRows.reduce((a, r) => a + r.tgtPnl, 0);

  // ---- payoff table: strikewise P&L (ATM ± strikeSpan strikes) ----
  const levelRows = useMemo(() => {
    if (!analysis) return [];
    const spot = analysis.spot;
    const step = chain?.strikeStep || 50;

    const ks = chain?.rows.length ? chain.rows.map((r) => r.strike).sort((a, b) => a - b) : [];
    // "All" with nothing to bound it (no chain loaded) falls back to ±20 rows
    const span = strikeSpan || 20;
    let strikes: number[];
    if (tableInterval > 0) {
      // fixed ₹ interval around spot (Sensibull "Target Interval")
      strikes = [];
      if (strikeSpan === 0 && ks.length) {
        // "All": the chain's own strike range, at the chosen ₹ step
        for (let k = Math.floor(ks[0] / tableInterval) * tableInterval; k <= ks[ks.length - 1]; k += tableInterval)
          strikes.push(k);
      } else {
        const base = Math.round(spot / tableInterval) * tableInterval;
        for (let i = -span; i <= span; i++) strikes.push(base + i * tableInterval);
      }
    } else if (ks.length) {
      if (strikeSpan === 0) {
        strikes = ks;
      } else {
        let ai = ks.indexOf(chain!.atmStrike);
        if (ai < 0)
          ai = ks.reduce(
            (best, k, i) => (Math.abs(k - spot) < Math.abs(ks[best] - spot) ? i : best),
            0
          );
        strikes = ks.slice(Math.max(0, ai - strikeSpan), ai + strikeSpan + 1);
      }
    } else {
      const base = Math.round(spot / step) * step;
      strikes = [];
      for (let i = -span; i <= span; i++) strikes.push(base + i * step);
    }

    // biggest Call / Put OI within the visible slice = wall / floor
    let wall = { v: -1, k: 0 };
    let floor = { v: -1, k: 0 };
    if (chain) {
      for (const k of strikes) {
        const r = chain.rows.find((x) => x.strike === k);
        if (!r) continue;
        if ((r.call.oi ?? 0) > wall.v) wall = { v: r.call.oi ?? 0, k };
        if ((r.put.oi ?? 0) > floor.v) floor = { v: r.put.oi ?? 0, k };
      }
    }

    const exp = strategyPnlCurve(analysis.legs, strikes, 0);
    const now = strategyPnlCurve(analysis.legs, strikes, dteExact / 365);
    const remYears = daysLeft(tDays) / 365;
    const tv = tDays > 0 || ivShift ? strategyPnlCurve(analysis.legs, strikes, remYears, ivShift) : null;

    return strikes
      .map((k, i) => ({
        K: k,
        pct: (k - spot) / spot,
        now: now[i],
        exp: exp[i],
        tv: tv ? tv[i] : null,
        isATM: chain ? k === chain.atmStrike : Math.abs(k - spot) <= step / 2,
        isWall: k === wall.k && wall.v > 0,
        isFloor: k === floor.k && floor.v > 0,
      }))
      .reverse(); // high strike on top, like the chain ladder
  }, [analysis, tDays, dte, dteExact, strikeSpan, tableInterval, chain, ivShift]);

  // ---- day-wise / hour-wise P&L (Sensibull "by date and time") ----
  /** the expiry's 15:30 IST close from its date ("06-Oct-2026"); the days-left figure if it won't parse */
  const expiryTs = (exp: string, daysLeft: number) => {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(exp || "");
    const mi = m ? ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2].toLowerCase()) : -1;
    return m && mi >= 0
      ? Date.UTC(Number(m[3]), mi, Number(m[1]), 15, 30) - 5.5 * 3600e3
      : Date.now() + daysLeft * 86400000;
  };
  // Every point is priced with the time left from IT to expiry (IST, 15:30 close); weekends skipped
  // (exchange holidays aren't known here, so a holiday still gets a column).
  const tradeDays = useMemo(() => {
    if (!analysis) return [] as { key: string; label: string; close: number; points: { key: string; label: string; ts: number }[] }[];
    const IST = 5.5 * 3600e3;
    const nowTs = Date.now();
    const expTs = expiryTs(analysis.expiry, dteExact);
    const at = (y: number, m: number, d: number, hh: number, mm: number) => Date.UTC(y, m, d, hh, mm) - IST;
    const out: { key: string; label: string; close: number; points: { key: string; label: string; ts: number }[] }[] = [];
    const t0 = new Date(nowTs + IST);
    for (let i = 0; i <= Math.ceil((expTs - nowTs) / 86400000) + 1 && out.length < 40; i++) {
      const d = new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth(), t0.getUTCDate() + i));
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
      const close = Math.min(at(y, m, dd, 15, 30), expTs);
      if (close <= nowTs) continue;
      const isExp = close >= expTs - 60000;
      const lbl = i === 0 ? "Today" : d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", timeZone: "UTC" });
      const points = [10, 11, 12, 13, 14, 15]
        .map((h) => ({ key: `${y}-${m}-${dd}-${h}`, label: `${h > 12 ? h - 12 : h}:00`, ts: at(y, m, dd, h, 0) }))
        .filter((pt) => pt.ts > nowTs && pt.ts < close);
      points.push({ key: `${y}-${m}-${dd}-close`, label: isExp ? "Expiry" : "3:30", ts: close });
      out.push({ key: `${y}-${m}-${dd}`, label: isExp ? `${lbl} · Expiry` : lbl, close, points });
      if (isExp) break;
    }
    return out;
  }, [analysis, dteExact]);
  const expTsNow = analysis ? expiryTs(analysis.expiry, dteExact) : 0;
  /** the columns the table shows for the chosen time view */
  const timeCols = useMemo(() => {
    if (!analysis || timeMode === "basic") return [] as { key: string; label: string; sub?: string; rem: number }[];
    const rem = (ts: number) => Math.max(0, (expTsNow - ts) / 86400000);
    if (timeMode === "day")
      return [
        { key: "now", label: "Now", rem: dteExact },
        ...tradeDays.map((d) => ({
          key: d.key,
          label: d.label.replace(" · Expiry", ""),
          sub: d.close >= expTsNow - 60000 ? "expiry" : "3:30",
          rem: rem(d.close),
        })),
      ];
    const day = tradeDays[Math.min(hourDay, tradeDays.length - 1)];
    if (!day) return [];
    return day.points.map((pt) => ({ key: pt.key, label: pt.label, sub: day.label.replace(" · Expiry", ""), rem: rem(pt.ts) }));
  }, [analysis, timeMode, tradeDays, hourDay, dteExact]);
  const timeVals = useMemo(() => {
    if (!analysis || !timeCols.length) return [] as number[][];
    const ks = levelRows.map((r) => r.K);
    return timeCols.map((c) => strategyPnlCurve(analysis.legs, ks, c.rem / 365, ivShift));
  }, [analysis, timeCols, levelRows, ivShift]);
  /** phone: the middle column's point in time ("now", a day's close, or an hour) */
  const phoneCol = useMemo(() => {
    if (!analysis || phonePt === "now") return null;
    for (const d of tradeDays)
      for (const pt of d.points)
        if (pt.key === phonePt) {
          const ks = levelRows.map((r) => r.K);
          const rem = Math.max(0, (expTsNow - pt.ts) / 86400000);
          return {
            label: `${d.label.replace(" · Expiry", "")} ${pt.label}`,
            vals: strategyPnlCurve(analysis.legs, ks, rem / 365, ivShift),
          };
        }
    return null;
  }, [analysis, phonePt, tradeDays, levelRows, ivShift]);

  // scroll the P&L table to the ATM row by default instead of the top of the ladder
  const atmRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (payoffTab !== "table" || !levelRows.length) return;
    const id = requestAnimationFrame(() => {
      atmRowRef.current?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(id);
  }, [payoffTab, analysis?.symbol, analysis?.expiry, strikeSpan, tableInterval]);

  const pnlCls = (v: number) => (v >= 0 ? "text-up" : "text-down");
  const mp = (v: number | null | undefined) => (v == null ? null : v + manualPnl);
  const pnlTxt = (v: number | null) => (v == null ? "–" : `${v >= 0 ? "+" : ""}${nf(v, 0)}`);

  // P&L right now, at the actual current spot -- same "now" curve the payoff
  // chart already plots, just read off at the one point that matters instead
  // of having to eyeball where it crosses the live-price line.
  // payoff chart extras: one SD of the move to expiry (sizes its default window, like Sensibull's
  // "SD dynamic") and the chain's open interest per strike -- only when the chain on screen is the
  // analysed symbol / expiry
  const payoffSd = useMemo(() => {
    if (!analysis || !chain?.atmIV) return undefined;
    return analysis.spot * (chain.atmIV / 100) * Math.sqrt(Math.max(analysis.dte, 0.25) / 365);
  }, [analysis, chain?.atmIV]);
  const payoffOi = useMemo(() => {
    if (!analysis || !chain || chain.symbol !== analysis.symbol || chain.expiry !== analysis.expiry) return undefined;
    return chain.rows.map((r) => ({ strike: r.strike, call: r.call.oi ?? 0, put: r.put.oi ?? 0 }));
  }, [analysis, chain]);

  const currentPnl = useMemo(() => {
    if (!analysis || analysis.x.length === 0) return null;
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < analysis.x.length; i++) {
      const d = Math.abs(analysis.x[i] - analysis.spot);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    return analysis.nowPnl[bestI] + manualPnl;
  }, [analysis, manualPnl]);

  // session ATM-IV history → IV regime + strategy fit
  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    api.history(symbol).then(
      (d) =>
        alive &&
        setIvSeries(d.points.map((p) => p.atmIV).filter((v): v is number => v != null)),
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [symbol]);
  const ivReg = useMemo(() => ivRegime(ivSeries, chain?.atmIV ?? null), [ivSeries, chain?.atmIV]);
  const ivFitMsg = analysis ? ivFit(ivReg, analysis.greeks.vega) : null;

  // discrete "T+n" day chips from today to expiry (capped ~12)
  const dayChips = useMemo(() => {
    if (dte <= 1) return Array.from(new Set([0, dte]));
    const MAX = 12;
    if (dte <= MAX) return Array.from({ length: dte + 1 }, (_, i) => i);
    const step = Math.ceil(dte / (MAX - 1));
    const out: number[] = [];
    for (let d = 0; d < dte; d += step) out.push(d);
    out.push(dte);
    return out;
  }, [dte]);

  const num2 = (v: number, d = 2) => (v >= 0 ? "+" : "") + nf(v, d);
  const gCell = (v: number, d = 2) =>
    `border-b border-r border-term-border/50 px-2 py-1 text-right num ${
      Math.abs(v) < 1e-9 ? "text-term-dim" : v > 0 ? "text-up" : "text-down"
    }`;

  // ---- Legs P&L tab: per-leg P&L at the (target price, target date) ----
  const legMax = Math.max(1, ...legRows.map((r) => Math.abs(r.tgtPnl)), Math.abs(manualPnl));
  const legsEl = analysis && (
    <div className="m-2 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
        <span className="text-[13px] font-semibold text-term-text">
          Legs{" "}
          <span className="font-normal text-term-dim">
            · P&amp;L at {nf(tgtPrice, 0)} · {tLegLabel}
          </span>
        </span>
        <span className="text-[12px] text-term-dim">
          Total{" "}
          <span className={`num text-[15px] font-bold ${pnlCls(legTot + manualPnl)}`}>{pnlTxt(legTot + manualPnl)}</span>
        </span>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {legRows.map((r, i) => {
          const buy = r.leg.side === "BUY";
          return (
            <div
              key={i}
              className={`rounded-lg border border-l-[3px] border-term-border bg-term-panel2/60 p-2.5 ${buy ? "border-l-up" : "border-l-down"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${buy ? "bg-up/20 text-up" : "bg-down/20 text-down"}`}>
                    {r.leg.side}
                  </span>
                  <span className="num truncate text-[13px] font-semibold text-term-text">
                    {r.leg.optionType === "FUT" ? "FUT" : `${sk(r.leg.strike)} ${r.leg.optionType}`}
                  </span>
                  <span className="shrink-0 text-[11px] text-term-dim">
                    × {r.leg.lots} lot{r.leg.lots === 1 ? "" : "s"}
                  </span>
                </span>
                <span className={`num shrink-0 text-[15px] font-bold ${pnlCls(r.tgtPnl)}`}>{pnlTxt(r.tgtPnl)}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-term-border/60">
                <div
                  className={`h-full ${r.tgtPnl >= 0 ? "bg-up" : "bg-down"}`}
                  style={{ width: `${Math.min(100, (Math.abs(r.tgtPnl) / legMax) * 100)}%` }}
                />
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-1 text-[11px]">
                {(
                  [
                    ["Entry", r.entry],
                    ["LTP now", r.ltp],
                    ["At target", r.tgtPx],
                  ] as [string, number][]
                ).map(([k, v]) => (
                  <div key={k}>
                    <div className="text-[9.5px] uppercase tracking-wide text-term-dim">{k}</div>
                    <div className="num text-term-text">{nf(v, 2)}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {manualPnl !== 0 && (
          <div className="rounded-lg border border-l-[3px] border-term-border border-l-amber-500 bg-term-panel2/60 p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-term-text">Manual P&amp;L</span>
              <span className={`num text-[15px] font-bold ${pnlCls(manualPnl)}`}>{pnlTxt(manualPnl)}</span>
            </div>
            <div className="mt-1 text-[11px] text-term-dim">booked / adjustments, from the Builder</div>
          </div>
        )}
      </div>
      <p className="px-1 text-[10px] text-term-dim">
        At target = Black-Scholes at the target price and date (the what-if controls below). LTP now = theoretical now.
      </p>
    </div>
  );

  // ---- Greeks tab: per-leg greeks at the (target price, target date) ----
  const greeksEl = analysis && (
    <div className="m-2 rounded border border-term-border bg-term-bg/20 p-3">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
        <span className="text-2xs font-semibold uppercase tracking-wide text-term-dim">
          Greeks @ {nf(tgtPrice, 0)} · {tLegLabel}
        </span>
        <div className="flex gap-1 text-[10px]">
          <button
            onClick={() => setGMulLot((v) => !v)}
            className={`chipbtn ${gMulLot ? "on" : ""}`}
          >
            × lot size
          </button>
          <button
            onClick={() => setGMulQty((v) => !v)}
            className={`chipbtn ${gMulQty ? "on" : ""}`}
          >
            × num lots
          </button>
        </div>
      </div>
      {(() => {
        const inRs = gMulLot && gMulQty; // the tiles speak in rupees only for the whole position
        const lot = analysis.lotSize || 1;
        const d = greekTot.delta, th = greekTot.theta, v = greekTot.vega, ga = greekTot.gamma;
        const words = {
          delta: !inRs
            ? "per unit"
            : Math.abs(d) < lot * 0.1
            ? "nearly neutral to small moves"
            : d > 0
            ? `gains ≈ ₹${nf(d, 0)} per 1-pt rise`
            : `gains ≈ ₹${nf(-d, 0)} per 1-pt fall`,
          theta: !inRs ? "per unit" : th >= 0 ? `you earn ≈ ₹${nf(th, 0)} a day if price stays` : `time costs ≈ ₹${nf(-th, 0)} a day`,
          vega: !inRs
            ? "per unit"
            : v <= 0
            ? `loses ≈ ₹${nf(-v, 0)} if IV rises 1 pt, gains if it falls`
            : `gains ≈ ₹${nf(v, 0)} if IV rises 1 pt`,
          gamma: ga < 0 ? "short gamma: big moves hurt, delta turns against you" : "long gamma: big moves help you",
        };
        const tile = (k: string, val: number, dp: number, w: string) => (
          <div key={k} className="rounded-lg border border-term-border bg-term-panel2/60 px-2.5 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-term-dim">{k}</div>
            <div className={`num text-[17px] font-bold ${signColor(val)}`}>{num2(val, dp)}</div>
            <div className="text-[10.5px] leading-snug text-term-dim">{w}</div>
          </div>
        );
        return (
          <>
            <div className="mb-2 grid grid-cols-2 gap-1.5 lg:grid-cols-4">
              {tile("Δ Delta", d, 1, words.delta)}
              {tile("Θ Theta / day", th, 0, words.theta)}
              {tile("V Vega", v, 0, words.vega)}
              {tile("Γ Gamma", ga, 4, words.gamma)}
            </div>
            <div className="mb-2 flex flex-wrap gap-x-4 gap-y-0.5 px-0.5 text-[11px] text-term-dim">
              <span>
                Time value{" "}
                <span className={`num ${posVal ? signColor(posVal.timeValue) : ""}`}>{posVal ? `₹${nf(posVal.timeValue, 0)}` : "–"}</span>
              </span>
              <span>
                Intrinsic{" "}
                <span className={`num ${posVal ? signColor(posVal.intrinsic) : ""}`}>{posVal ? `₹${nf(posVal.intrinsic, 0)}` : "–"}</span>
              </span>
              <span>
                R : R <span className="num text-term-text">{analysis.rr != null ? `1:${nf(analysis.rr, 2)}` : "–"}</span>
              </span>
            </div>
          </>
        );
      })()}
      <table className="block w-full overflow-x-auto whitespace-nowrap border-separate border-spacing-0 border border-term-border text-2xs [&_td:last-child]:border-r-0 [&_td]:border-b [&_td]:border-r [&_td]:border-term-border/60 [&_th:last-child]:border-r-0 [&_th]:border-b [&_th]:border-r [&_th]:border-term-border">
        <thead className="text-[10px] uppercase text-term-dim">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Instrument</th>
            <th className="px-2 py-1 text-right font-medium">Delta</th>
            <th className="px-2 py-1 text-right font-medium">Gamma</th>
            <th className="px-2 py-1 text-right font-medium">Theta / day</th>
            <th className="px-2 py-1 text-right font-medium">Vega</th>
          </tr>
        </thead>
        <tbody>
          {greekRows.map((r, i) => (
            <tr key={i}>
              <td className="num border-b border-r border-term-border/50 px-2 py-1">{r.label}</td>
              <td className={gCell(r.delta)}>{num2(r.delta)}</td>
              <td className={gCell(r.gamma, 4)}>{num2(r.gamma, 4)}</td>
              <td className={gCell(r.theta, 0)}>{num2(r.theta, 0)}</td>
              <td className={gCell(r.vega, 0)}>{num2(r.vega, 0)}</td>
            </tr>
          ))}
          <tr className="bg-term-panel2 font-semibold">
            <td className="border-b border-r border-term-border/50 px-2 py-1">Total</td>
            <td className={gCell(greekTot.delta)}>{num2(greekTot.delta)}</td>
            <td className={gCell(greekTot.gamma, 4)}>{num2(greekTot.gamma, 4)}</td>
            <td className={gCell(greekTot.theta, 0)}>{num2(greekTot.theta, 0)}</td>
            <td className={gCell(greekTot.vega, 0)}>{num2(greekTot.vega, 0)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col border-t border-term-border lg:grid lg:overflow-hidden"
      style={{ gridTemplateColumns: `${builderW}px 4px minmax(0,1fr)` }}
    >
      {/* ---- leg editor ---- */}
      <div className="flex flex-col border-r border-term-border bg-term-panel2 lg:min-h-0 lg:overflow-y-auto">
        <div className="flex items-center gap-2 border-b border-term-border px-3 py-2 text-2xs font-semibold uppercase tracking-wide text-term-dim">
          <span>Builder</span>
          <SelectMenu
            value={symbol}
            options={symOptions.map((s) => [s, s] as [string, string])}
            onChange={(v) => selectSymbol(v, true)}
            title="Underlying for this strategy"
            width={130}
          />
          {expiries.length > 0 && (
            <span className="ml-auto">
              <SelectMenu
                value={expiry ?? ""}
                options={expiries.map((e) => [e, e] as [string, string])}
                onChange={selectExpiry}
                title="Expiry"
                width={130}
              />
            </span>
          )}
        </div>

        <div className="flex flex-col gap-2 border-b border-term-border p-2">
          <SelectMenu
            value=""
            options={[
              ["Load a template…", ""],
              ...Object.keys(templates).map((t) => [t, t] as [string, string]),
            ]}
            onChange={(t) => t && loadTemplate(t)}
            title="Load a template"
            width={180}
          />
          <div className="flex gap-1">
            {!isViewer() && (
              <button className="btn flex-1 text-2xs" onClick={loadFromPaper}>
                From paper positions
              </button>
            )}
            <button
              className="btn flex-1 text-2xs"
              onClick={() => {
                setFromBroker(false);
                setStratName("");
                update([]);
              }}
            >
              Clear
            </button>
          </div>
          {broker?.authed && !isViewer() && (
            <button
              className="w-full rounded border border-up/60 bg-up/10 px-2 py-1.5 text-xs font-semibold text-up hover:bg-up/20"
              onClick={loadFromBroker}
              title="Load your live Flattrade option positions into the builder so you can hedge / cap the running loss"
            >
              ⚡ From live positions
            </button>
          )}
          <div className="flex items-center gap-1 text-2xs">
            <span className="text-term-dim">Lot multiplier</span>
            <button className="btn px-1.5 py-0.5" onClick={() => setMult((m) => Math.max(1, m - 1))}>
              −
            </button>
            <span className="num w-6 text-center font-semibold text-term-text">×{mult}</span>
            <button className="btn px-1.5 py-0.5" onClick={() => setMult((m) => m + 1)}>
              +
            </button>
            {[1, 2, 3, 5, 10].map((n) => (
              <button
                key={n}
                onClick={() => setMult(n)}
                className={`rounded border px-1.5 py-0.5 ${
                  mult === n
                    ? "border-term-accent bg-term-accent/20 text-term-text"
                    : "border-term-dim/70 text-term-dim"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5 p-2">
          <div className="flex items-baseline justify-between px-0.5 text-[11px]">
            <span className="font-semibold uppercase tracking-wide text-term-dim">
              Legs{legs.length ? ` (${legs.length})` : ""}
            </span>
            {analysis && legs.length > 0 && (
              <span className="text-term-dim">
                net {analysis.netPremiumType === "CREDIT" ? "credit" : "debit"}{" "}
                <span className={`num font-semibold ${analysis.netPremiumType === "CREDIT" ? "text-up" : "text-down"}`}>
                  ₹{nf(Math.abs(analysis.netPremium), 0)}
                </span>
              </span>
            )}
          </div>
          {legs.length === 0 && (
            <div className="rounded-md border border-dashed border-term-border px-2 py-4 text-center text-2xs text-term-dim">
              No legs yet — load a template or add one below.
            </div>
          )}
          {legs.map((leg, i) => {
            const lr = legRows[i];
            const atNow = tDays === 0 && !ivShift && analysis != null && Math.round(tgtPrice) === Math.round(analysis.spot);
            return (
            <div
              key={i}
              className={`rounded-md border border-l-[3px] border-term-border p-2 text-2xs ${
                leg.side === "BUY" ? "border-l-up" : "border-l-down"
              } ${leg.held ? "bg-amber-500/[0.07]" : "bg-term-panel/70"}`}
            >
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setLeg(i, { held: !leg.held })}
                  title={
                    leg.held
                      ? "Held position — tap to include it in Execute"
                      : "Tap to mark as an already-open position (skipped on Execute)"
                  }
                  className={`rounded border px-1.5 py-1 leading-none ${
                    leg.held
                      ? "border-amber-500/50 bg-amber-500/15 text-amber-400"
                      : "border-term-dim/70 text-term-dim hover:text-term-text"
                  }`}
                >
                  {leg.held ? "🔒" : "🔓"}
                </button>
                <button
                  onClick={() =>
                    setLeg(i, {
                      optionType: leg.optionType === "CE" ? "PE" : leg.optionType === "PE" ? "FUT" : "CE",
                    })
                  }
                  title="tap to switch CE / PE / FUT"
                  className={`rounded px-2 py-1 font-bold ${
                    leg.optionType === "CE"
                      ? "bg-up/20 text-up"
                      : leg.optionType === "PE"
                      ? "bg-down/20 text-down"
                      : "bg-term-border text-term-dim"
                  }`}
                >
                  {leg.optionType}
                </button>
                {leg.optionType !== "FUT" && (
                  <StrikeStepper
                    value={leg.strike}
                    strikes={strikes.includes(leg.strike) ? strikes : [...strikes, leg.strike].sort((a, b) => a - b)}
                    atm={atm}
                    onChange={(k) => setLeg(i, { strike: k })}
                  />
                )}
                <button
                  onClick={() => setLeg(i, { side: leg.side === "BUY" ? "SELL" : "BUY" })}
                  className={`rounded px-2 py-1 font-bold ${
                    leg.side === "BUY" ? "bg-up/20 text-up" : "bg-down/20 text-down"
                  }`}
                >
                  {leg.side}
                </button>
                <button
                  onClick={() => removeLeg(i)}
                  className="rounded border border-term-dim/70 px-1.5 py-1 text-term-dim hover:text-down"
                >
                  ×
                </button>
              </div>
              <div className="mt-1 flex items-center gap-2 text-term-dim">
                <span>Lots</span>
                <button className="btn px-1 py-0" onClick={() => setLeg(i, { lots: Math.max(1, leg.lots - 1) })}>
                  −
                </button>
                <span className="num text-term-text">
                  {leg.lots}
                  {mult > 1 && <span className="text-term-accent"> → {leg.lots * mult}</span>}
                </span>
                <button className="btn px-1 py-0" onClick={() => setLeg(i, { lots: leg.lots + 1 })}>
                  +
                </button>
                <label className="ml-auto flex items-center gap-1">
                  <span>@</span>
                  <PriceInput
                    value={leg.price}
                    placeholder={analysis?.legs[i] ? nf(analysis.legs[i].entry) : "LTP"}
                    onChange={(v) => setLeg(i, { price: v })}
                    className="num w-20 rounded border border-term-border bg-term-bg px-1.5 py-1 text-right text-term-text"
                  />
                  {leg.price != null && (
                    <button
                      onClick={() => setLeg(i, { price: null })}
                      title="use live LTP"
                      className="text-term-dim hover:text-term-text"
                    >
                      ↺
                    </button>
                  )}
                </label>
                {analysis?.legs[i] && (
                  <span className="num text-term-dim">IV {nf(analysis.legs[i].iv, 1)}</span>
                )}
              </div>
              {lr && (
                <div className="mt-1.5 flex items-center justify-between border-t border-term-border/40 pt-1 text-[10.5px]">
                  <span className="text-term-dim">
                    now <span className="num text-term-text">{nf(lr.ltp, 2)}</span>
                    <span className="ml-1.5">entry {nf(lr.entry, 2)}</span>
                  </span>
                  <span className="text-term-dim">
                    {atNow ? "P&L now" : "P&L @ target"}{" "}
                    <span className={`num font-semibold ${pnlCls(lr.tgtPnl)}`}>{pnlTxt(lr.tgtPnl)}</span>
                  </span>
                </div>
              )}
              {leg.held && (
                <div className="mt-1 text-[9px] text-amber-400/80">
                  held position ·{" "}
                  {executeHeld ? "will be sent on Execute" : "in payoff, skipped on Execute"}
                </div>
              )}
            </div>
            );
          })}
        </div>

        {/* ---- manual P&L: booked / adjustment P&L added to every figure (moved here from under the payoff) ---- */}
        {legs.length > 0 && (
          <div className="flex items-center gap-2 border-t border-term-border px-3 py-2 text-2xs">
            <label htmlFor="sb-manual-pnl" className="shrink-0 font-semibold uppercase tracking-wide text-term-dim">
              Manual P&amp;L ₹
            </label>
            <input
              id="sb-manual-pnl"
              inputMode="decimal"
              value={manualStr}
              onChange={(e) => {
                const s = e.target.value.replace(/[^\d.-]/g, "");
                setManualStr(s);
                setManualPnl(parseFloat(s) || 0);
              }}
              placeholder="0"
              title="Booked / adjustment P&L added to every P&L figure and the payoff curves"
              className={`num w-28 rounded border border-term-border bg-term-bg px-2 py-1 text-right text-[12px] outline-none focus:border-term-accent ${
                manualPnl > 0 ? "text-up" : manualPnl < 0 ? "text-down" : "text-term-text"
              }`}
            />
            {manualPnl !== 0 && (
              <button
                onClick={() => {
                  setManualStr("");
                  setManualPnl(0);
                }}
                className="chipbtn"
              >
                clear
              </button>
            )}
            <span className="min-w-0 truncate text-[10px] text-term-dim">booked / adjustments — added to every P&amp;L</span>
          </div>
        )}

        {/* ---- add a leg (collapsed by default; hidden clutter when a template is loaded) ---- */}
        <div className="border-t-2 border-term-border bg-term-panel2 p-2">
          {!addingLeg ? (
            <button
              onClick={() => setAddingLeg(true)}
              className="btn w-full py-1.5 text-2xs font-semibold"
            >
              + Add leg
            </button>
          ) : (
            <div className="text-2xs">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-term-dim">
                  New leg
                </span>
                <button
                  onClick={() => setAddingLeg(false)}
                  className="text-term-dim hover:text-down"
                >
                  ✕
                </button>
              </div>
              <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                <label className="flex flex-col gap-0.5">
                  <span className="text-[9px] uppercase text-term-dim">Type</span>
                  <button
                    onClick={() =>
                      setNewLegOT((o) => (o === "CE" ? "PE" : o === "PE" ? "FUT" : "CE"))
                    }
                    title="tap to switch CE / PE / FUT"
                    className={`rounded px-3 py-1 font-bold ${
                      newLegOT === "CE"
                        ? "bg-up/20 text-up"
                        : newLegOT === "PE"
                        ? "bg-down/20 text-down"
                        : "bg-term-border text-term-dim"
                    }`}
                  >
                    {newLegOT}
                  </button>
                </label>
                {newLegOT !== "FUT" && strikes.length > 0 && (
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] uppercase text-term-dim">Strike</span>
                    <StrikeStepper
                      value={newLegStrike || atm}
                      strikes={strikes}
                      atm={atm}
                      onChange={(k) => setNewLegStrike(k)}
                    />
                  </label>
                )}
                <label className="flex flex-col gap-0.5">
                  <span className="text-[9px] uppercase text-term-dim">Side</span>
                  <button
                    onClick={() => setNewLegSide((s) => (s === "BUY" ? "SELL" : "BUY"))}
                    className={`rounded px-3 py-1 font-bold ${
                      newLegSide === "BUY" ? "bg-up/20 text-up" : "bg-down/20 text-down"
                    }`}
                  >
                    {newLegSide}
                  </button>
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[9px] uppercase text-term-dim">Lots</span>
                  <input
                    type="number"
                    min="1"
                    inputMode="numeric"
                    value={newLegLots || ""}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^\d]/g, "");
                      setNewLegLots(v === "" ? 0 : Math.min(999, Number(v)));
                    }}
                    onBlur={() => setNewLegLots((n) => n || 1)}
                    className="num w-14 rounded border border-term-border bg-term-bg px-2 py-1 text-term-text"
                  />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[9px] uppercase text-term-dim">Price</span>
                  <PriceInput
                    value={newLegPrice}
                    onChange={setNewLegPrice}
                    placeholder="live"
                    className="num w-20 rounded border border-term-border bg-term-bg px-2 py-1 text-right text-term-text"
                  />
                </label>
                <button
                  onClick={() => {
                    addLeg();
                    setNewLegPrice(null);
                    setAddingLeg(false);
                  }}
                  className="btn ml-auto px-4 py-1 font-semibold"
                >
                  Add
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ---- hedge finder ---- */}
        {legs.length > 0 && (
          <Fold
            id="hedge"
            title="🛡 Hedge finder"
            titleCls="text-amber-400"
            badge={hedge ? `${hedge.suggestions.length} idea${hedge.suggestions.length === 1 ? "" : "s"}` : deltaHedge ? "1 idea" : undefined}
          >
            <div className="mb-1 text-2xs text-term-dim">Cap the running loss at</div>
            <div className="flex items-center gap-1">
              <span className="text-2xs text-term-dim">₹</span>
              <input
                id="hedge-max-loss"
                inputMode="decimal"
                value={hedgeMaxStr}
                onChange={(e) => setHedgeMaxStr(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="max loss"
                className="w-24 rounded border border-term-border bg-term-bg px-2 py-1 text-xs num outline-none focus:border-term-accent"
              />
              <button
                onClick={findHedge}
                disabled={hedgeBusy}
                className="flex-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-2xs font-semibold text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-40"
              >
                {hedgeBusy ? "Searching…" : "Find best hedge"}
              </button>
              <button
                onClick={() => setHedgeAdvOpen((o) => !o)}
                title="Also target Delta / IV / POP / Theta / Vega / Gamma, or cap max profit"
                className={`btn px-1.5 py-1 text-2xs ${hedgeAdvOpen ? "text-term-accent" : ""}`}
              >
                ⚙
              </button>
            </div>

            <div className="mt-1.5 flex items-center gap-1">
              <span className="text-2xs text-term-dim">with</span>
              <div className="segx">
                {(["FUT", "CE", "PE"] as const).map((it) => (
                  <button
                    key={it}
                    onClick={() => {
                      setHedgeInstrument(it);
                      setDeltaHedge(null);
                      setDeltaHedgeNote(null);
                    }}
                    title={
                      it === "FUT"
                        ? "Underlying future — pure delta, no gamma/theta/vega drag"
                        : `ATM ${it === "CE" ? "call" : "put"} — also adds its own gamma/theta/vega`
                    }
                    className={`px-1.5 py-0.5 text-[10px] ${hedgeInstrument === it ? "bg-term-accent text-white" : "text-term-dim"}`}
                  >
                    {it}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={findDeltaHedge}
              disabled={deltaHedgeBusy || !analysis}
              title={
                hedgeInstrument === "FUT"
                  ? "Buy/sell the underlying future to bring net delta to ~0 — no loss-cap number needed"
                  : `Buy/sell the ATM ${hedgeInstrument === "CE" ? "call" : "put"} to bring net delta to ~0`
              }
              className="mt-1 w-full rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-2xs font-semibold text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:opacity-40"
            >
              {deltaHedgeBusy ? "Calculating…" : `🎯 Neutralize Δ${analysis ? ` (now ${nf(analysis.greeks.delta, 0)})` : ""}`}
            </button>
            {deltaHedgeNote && <div className="mt-1 text-2xs text-term-dim">{deltaHedgeNote}</div>}
            {deltaHedge && (
              <div className="mt-1.5 rounded border border-cyan-500/40 bg-term-panel p-1.5 text-2xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-term-text">{deltaHedge.label}</span>
                  <button
                    onClick={() => {
                      applyHedge(deltaHedge.leg);
                      setDeltaHedge(null);
                    }}
                    className="btn btn-buy px-2 py-0.5 text-[10px]"
                  >
                    Apply
                  </button>
                </div>
                <div className="num mt-0.5 text-[10px] text-term-dim">
                  {deltaHedge.cost >= 0 ? "cost" : "credit"} ₹{nf(Math.abs(deltaHedge.cost), 0)} · max loss{" "}
                  <span className="text-down">₹{nf(Math.abs(deltaHedge.resultMaxLoss), 0)}</span> · max profit{" "}
                  <span className="text-up">
                    {deltaHedge.resultMaxProfitUnbounded ? "∞" : `₹${nf(deltaHedge.resultMaxProfit, 0)}`}
                  </span>{" "}
                  · POP {deltaHedge.resultPop != null ? `${nf(deltaHedge.resultPop, 0)}%` : "–"}
                </div>
                <div className="num mt-0.5 text-[10px] text-term-dim">
                  Δ {nf(deltaHedge.resultGreeks.delta, 1)} · Γ {nf(deltaHedge.resultGreeks.gamma, 3)} · Θ{" "}
                  {nf(deltaHedge.resultGreeks.theta, 0)} · V {nf(deltaHedge.resultGreeks.vega, 0)}
                </div>
                <div className="mt-1 text-[10px] text-term-dim">
                  {deltaHedge.leg.optionType === "FUT"
                    ? "Futures carry no gamma/theta/vega of their own, so this hedges delta only — the rest of the Greeks above are unchanged from your position before the hedge."
                    : `The ATM ${deltaHedge.leg.optionType === "CE" ? "call" : "put"} brings its own gamma/theta/vega along, so the Greeks above have shifted too — not delta alone.`}
                </div>
              </div>
            )}

            {hedgeAdvOpen && (
              <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1 rounded border border-term-border bg-term-bg/50 p-1.5">
                <AdvNum
                  label="Cap max profit ₹"
                  value={hedgeAdv.maxProfitCap}
                  onChange={(v) => setHedgeAdv((a) => ({ ...a, maxProfitCap: v }))}
                  title="Also sell a wing so max profit doesn't exceed this — not just cap the loss"
                />
                <AdvNum
                  label="Min POP %"
                  value={hedgeAdv.minPop}
                  onChange={(v) => setHedgeAdv((a) => ({ ...a, minPop: v }))}
                />
                <AdvNum
                  label="Max |Δ Delta|"
                  value={hedgeAdv.maxAbsDelta}
                  onChange={(v) => setHedgeAdv((a) => ({ ...a, maxAbsDelta: v }))}
                  title="Keep the resulting position within this delta band (0 = delta-neutral)"
                />
                <AdvNum
                  label="Max |Θ| /day"
                  value={hedgeAdv.maxAbsTheta}
                  onChange={(v) => setHedgeAdv((a) => ({ ...a, maxAbsTheta: v }))}
                />
                <AdvNum
                  label="Max |Vega|"
                  value={hedgeAdv.maxAbsVega}
                  onChange={(v) => setHedgeAdv((a) => ({ ...a, maxAbsVega: v }))}
                />
                <AdvNum
                  label="Max |Γ Gamma|"
                  value={hedgeAdv.maxAbsGamma}
                  onChange={(v) => setHedgeAdv((a) => ({ ...a, maxAbsGamma: v }))}
                />
                <AdvNum
                  label="Max hedge IV %"
                  value={hedgeAdv.maxHedgeIv}
                  onChange={(v) => setHedgeAdv((a) => ({ ...a, maxHedgeIv: v }))}
                  title="Skip hedge legs whose own IV is above this (avoid overpaying for inflated IV)"
                />
                <button
                  className="col-span-2 text-left text-[10px] text-term-dim hover:text-down"
                  onClick={() =>
                    setHedgeAdv({
                      maxProfitCap: "",
                      minPop: "",
                      maxAbsDelta: "",
                      maxAbsTheta: "",
                      maxAbsVega: "",
                      maxAbsGamma: "",
                      maxHedgeIv: "",
                    })
                  }
                >
                  clear targets
                </button>
              </div>
            )}

            {hedge && (
              <div className="mt-2 flex flex-col gap-1.5 text-2xs">
                <div className="num text-term-dim">
                  now: max loss{" "}
                  <span className="text-down">
                    {hedge.current.maxLossUnbounded
                      ? "Unlimited"
                      : `₹${nf(Math.abs(hedge.current.maxLoss), 0)}`}
                  </span>{" "}
                  · max profit{" "}
                  <span className="text-up">
                    {hedge.current.maxProfitUnbounded ? "Unlimited" : `₹${nf(hedge.current.maxProfit, 0)}`}
                  </span>{" "}
                  · Δ {nf(hedge.current.greeks.delta, 1)} · Θ {nf(hedge.current.greeks.theta, 0)} · V{" "}
                  {nf(hedge.current.greeks.vega, 0)}
                </div>
                {hedge.note && <div className="text-amber-400">{hedge.note}</div>}
                {hedge.suggestions.map((s, i) => (
                  <div key={i} className="rounded border border-term-border bg-term-panel p-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-term-text">{s.label}</span>
                      <button
                        onClick={() => applyHedge(s.leg)}
                        className="btn btn-buy px-2 py-0.5 text-[10px]"
                      >
                        Apply
                      </button>
                    </div>
                    <div className="num mt-0.5 text-[10px] text-term-dim">
                      {s.cost >= 0 ? "cost" : "credit"} ₹{nf(Math.abs(s.cost), 0)} · max loss{" "}
                      <span className="text-down">₹{nf(Math.abs(s.resultMaxLoss), 0)}</span> · keeps{" "}
                      <span className="text-up">
                        {s.resultMaxProfitUnbounded ? "∞" : `₹${nf(s.resultMaxProfit, 0)}`}
                      </span>{" "}
                      · POP {s.resultPop != null ? `${nf(s.resultPop, 0)}%` : "–"}
                    </div>
                    <div className="num mt-0.5 text-[10px] text-term-dim">
                      Δ {nf(s.resultGreeks.delta, 1)} · Γ {nf(s.resultGreeks.gamma, 3)} · Θ{" "}
                      {nf(s.resultGreeks.theta, 0)} · V {nf(s.resultGreeks.vega, 0)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Fold>
        )}

        {isViewer() ? (
          <div className="flex flex-col gap-2 border-t border-term-border p-2 lg:mt-auto">
            <button
              disabled={legs.length === 0 || runLegCount === 0}
              onClick={doExecute}
              className="btn btn-buy py-2 font-semibold disabled:opacity-40"
            >
              Execute (paper) · {runLegCount} leg{runLegCount === 1 ? "" : "s"}
              {mult > 1 && <span className="ml-1 text-2xs">(×{mult})</span>}
            </button>
            <div className="text-2xs text-term-dim">
              Paper trades only — they go to your own paper positions. Scheduling and saving are off.
            </div>
          </div>
        ) : (
        <div className="flex flex-col lg:mt-auto">
          {fromBroker && orderMode !== "live" && (
            <div className="px-2 pt-2">
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-2xs text-amber-400">
              ⚠ These are your live positions, but order mode is PAPER — switch to LIVE
              (header) before executing or this hedge won't touch your real position.
            </div>
            </div>
          )}
          <Fold
            id="bracket"
            title="Bracket · paper SL / target"
            badge={parseFloat(slVal) > 0 || parseFloat(tgtVal) > 0 ? "set" : undefined}
          >
          {/* paper bracket: auto-square each fresh leg on SL / target */}
          <div
            className="flex flex-wrap items-center gap-1.5 text-2xs text-term-dim"
            title="Paper only: attach an auto SL / target to every leg created by this execute"
          >
            <span className="uppercase tracking-wide">Bracket</span>
            <div className="seg">
              {(["amount", "points"] as const).map((b) => (
                <button
                  key={b}
                  onClick={() => setSlTgtBasis(b)}
                  className={slTgtBasis === b ? "on" : ""}
                >
                  {b === "amount" ? "₹" : "pts"}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1">
              SL
              <input
                value={slVal}
                onChange={(e) => setSlVal(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="–"
                className="num w-16 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-term-text outline-none focus:border-down"
              />
            </label>
            <label className="flex items-center gap-1">
              Target
              <input
                value={tgtVal}
                onChange={(e) => setTgtVal(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="–"
                className="num w-16 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-term-text outline-none focus:border-up"
              />
            </label>
            <span className="text-[9px] normal-case text-term-dim/70">
              {slTgtBasis === "points"
                ? "premium points per leg"
                : "₹ split across legs by qty"}
            </span>
          </div>
          </Fold>
          <div className="flex flex-col gap-2 border-t border-term-border p-2">
          {heldCount > 0 && (
            <label
              className="flex items-center gap-1.5 text-2xs text-amber-400"
              title="Execute skips positions fetched from the broker / paper book and only sends the new legs (e.g. the hedge). Tick this to also re-send the held legs."
            >
              <input
                type="checkbox"
                checked={executeHeld}
                onChange={(e) => setExecuteHeld(e.target.checked)}
              />
              also execute {heldCount} held leg{heldCount === 1 ? "" : "s"}
            </label>
          )}
          <button
            disabled={legs.length === 0 || runLegCount === 0}
            onClick={doExecute}
            className={`btn py-2 font-semibold disabled:opacity-40 ${
              orderMode === "live" ? "btn-sell" : "btn-buy"
            }`}
          >
            {orderMode === "live" ? "Execute LIVE" : "Execute (paper)"} · {runLegCount} leg
            {runLegCount === 1 ? "" : "s"}
            {heldCount > 0 && !executeHeld && (
              <span className="ml-1 text-2xs text-amber-400">· {heldCount} held</span>
            )}
            {mult > 1 && <span className="ml-1 text-2xs">(×{mult})</span>}
            {orderMode !== "live" && (parseFloat(slVal) > 0 || parseFloat(tgtVal) > 0) && (
              <span className="ml-1 text-2xs">
                {parseFloat(slVal) > 0 && (
                  <span className="text-down">· SL {slVal}{slTgtBasis === "points" ? "p" : "₹"}</span>
                )}
                {parseFloat(tgtVal) > 0 && (
                  <span className="ml-1 text-up">
                    · TGT {tgtVal}
                    {slTgtBasis === "points" ? "p" : "₹"}
                  </span>
                )}
              </span>
            )}
          </button>

          </div>
          <Fold
            id="sched"
            title="⏰ Schedule run"
            badge={(() => {
              const n = schedules.filter((x) => x.status === "armed" || x.status === "entered").length;
              return n ? `${n} active` : undefined;
            })()}
          >
          {/* scheduled run */}
          <div className="rounded border border-term-border bg-term-bg/40 p-2 text-2xs">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-term-dim">Place the legs at a set time</span>
              <div className="seg">
                {(["paper", "live"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setSchedMode(m)}
                    className={schedMode === m ? "on" : ""}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <label className="flex items-center gap-1 text-term-dim">
                Entry
                <input
                  type="time"
                  value={schedEntry}
                  onChange={(e) => setSchedEntry(e.target.value)}
                  className="num rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text [color-scheme:dark]"
                />
              </label>
              <label className="flex items-center gap-1 text-term-dim">
                Exit
                <input
                  type="time"
                  value={schedExit}
                  onChange={(e) => setSchedExit(e.target.value)}
                  className="num rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text [color-scheme:dark]"
                />
              </label>
              <label className="flex items-center gap-1 text-term-dim">
                <input
                  type="checkbox"
                  checked={schedRepeat}
                  onChange={(e) => setSchedRepeat(e.target.checked)}
                />
                daily
              </label>
              <button
                disabled={legs.length === 0 || (!schedEntry && !schedExit)}
                onClick={addSchedule}
                className="btn ml-auto px-2 py-0.5 font-semibold disabled:opacity-40"
              >
                + Schedule
              </button>
            </div>
            {schedMode === "live" && (
              <div className="mt-1 text-[9px] text-amber-400">
                ⚠ live places real orders at the set time (IST, market hours).
              </div>
            )}
            {schedules
              .filter((s) => s.status === "armed" || s.status === "entered")
              .map((s) => (
                <div
                  key={s.id}
                  className="mt-1 flex items-center justify-between gap-1 rounded bg-term-panel px-1.5 py-1"
                >
                  <span className="num truncate">
                    <span
                      className={
                        s.status === "entered" ? "font-semibold text-up" : "text-term-accent"
                      }
                    >
                      {s.status}
                    </span>{" "}
                    {s.symbol} · {s.legs.length}L · {s.mode}
                    {s.entryTime ? ` · in ${s.entryTime}` : ""}
                    {s.exitTime ? ` · out ${s.exitTime}` : ""}
                    {s.repeat ? " · daily" : ""}
                  </span>
                  <button
                    className="shrink-0 text-term-dim hover:text-down"
                    onClick={() => delSchedule(s.id)}
                    title="cancel schedule"
                  >
                    ×
                  </button>
                </div>
              ))}
          </div>

          </Fold>
          <Fold id="saved" title="Saved strategies" badge={saved.length ? String(saved.length) : undefined}>
            <div className="flex flex-col gap-1.5">
          <div className="flex gap-1">
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Save as…"
              className="min-w-0 flex-1 rounded border border-term-border bg-term-bg px-2 py-1 text-2xs outline-none focus:border-term-accent"
            />
            <button className="btn text-2xs" onClick={doSave}>
              Save
            </button>
          </div>
          {saved.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-1.5 rounded border border-term-border/60 bg-term-bg/40 px-2 py-1 text-2xs"
            >
              <span className="num min-w-0 flex-1 truncate">
                {s.name} <span className="text-term-dim">· {s.symbol}</span>
              </span>
              <button
                onClick={() => loadSaved(s)}
                className="shrink-0 rounded border border-term-dim/70 px-1.5 py-0.5 font-semibold text-term-accent hover:bg-term-accent/15"
              >
                Edit
              </button>
              <button
                onClick={() => {
                  loadSaved(s);
                  setPanel("backtest");
                }}
                className="shrink-0 rounded border border-term-dim/70 px-1.5 py-0.5 text-term-dim hover:text-term-text"
              >
                Backtest
              </button>
              <button
                onClick={() => delSaved(s.id)}
                className="shrink-0 rounded border border-term-dim/70 px-1.5 py-0.5 text-term-dim hover:border-down hover:text-down"
              >
                Delete
              </button>
            </div>
          ))}
            </div>
          </Fold>
        </div>
        )}
      </div>

      <VSplit onDrag={bumpBuilder} className="hidden lg:block" />

      {/* ---- payoff / backtest ---- */}
      <div className="flex flex-col lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-term-border">
        {/* strategy name + the numbers that matter, on every tab (laptop / unfolded; the folded phone has its own) */}
        {analysis && (
          <div className="hidden shrink-0 border-b border-term-border bg-term-panel px-3 pb-2 pt-2.5 sm:block">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className="text-[14px] font-semibold text-term-text">
                {stratName || `${legs.length} leg${legs.length === 1 ? "" : "s"}`}
                <span className="font-normal text-term-dim">
                  {" "}
                  · {analysis.symbol} {analysis.expiry}
                </span>
              </span>
              <span className="text-[11px] text-term-dim">
                spot <span className="num text-amber-300">{nf(analysis.spot, 2)}</span> · {leftLbl(0)} · ATM IV{" "}
                {chain?.atmIV ? `${nf(chain.atmIV, 1)}%` : "–"} <span className={ivReg.cls}>({ivReg.label})</span>
                {busy && " · updating…"}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1.5 2xl:grid-cols-8">
              {(
                [
                  [
                    heldCount > 0 ? "P&L now · live" : "P&L now",
                    currentPnl != null ? pnlTxt(currentPnl) : "–",
                    currentPnl != null ? pnlCls(currentPnl) : "text-term-text",
                  ],
                  [
                    "Max profit",
                    analysis.maxProfitUnbounded ? "Unlimited" : pnlTxt(analysis.maxProfit + manualPnl),
                    "text-up",
                  ],
                  ["Max loss", analysis.maxLossUnbounded ? "Unlimited" : pnlTxt(analysis.maxLoss + manualPnl), "text-down"],
                  ["POP", analysis.pop != null ? `${nf(analysis.pop, 0)}%` : "–", "text-term-text"],
                  ["Breakevens", analysis.breakevens.map((b) => nf(b, 0)).join(" · ") || "–", "text-term-text"],
                  [
                    analysis.netPremiumType === "CREDIT" ? "Credit" : "Debit",
                    `₹${nf(Math.abs(analysis.netPremium), 0)}`,
                    analysis.netPremiumType === "CREDIT" ? "text-up" : "text-down",
                  ],
                  [
                    "Margin",
                    analysis.margin.estimate >= 1e5
                      ? `${nf(analysis.margin.estimate / 1e5, 2)} L`
                      : `₹${nf(analysis.margin.estimate, 0)}`,
                    "text-term-text",
                  ],
                  ["Theta / day", pnlTxt(analysis.greeks.theta), pnlCls(analysis.greeks.theta)],
                ] as [string, string, string][]
              ).map(([k, v, c]) => (
                <div key={k} className="min-w-0 rounded-md border border-term-border bg-term-panel2/70 px-2 py-1.5">
                  <div className="truncate text-[9.5px] font-semibold uppercase tracking-wide text-term-dim">{k}</div>
                  <div className={`num truncate font-bold ${k === "Breakevens" ? "text-[12.5px]" : "text-[14px]"} ${c}`} title={v}>
                    {v}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* one tab bar (was two rows: Payoff / Strategy chart / Greek charts / Backtest + Stats / Chart / ...) */}
        {(() => {
          const active = panel === "payoff" ? (payoffTab === "stats" ? "chart" : payoffTab) : panel;
          const TABS: [string, string, boolean][] = [
            ["chart", "Payoff", true],
            ["table", "P&L table", false],
            ["legs", "Legs", false],
            ["greeks", "Greeks", false],
            ["schart", "Strategy chart", true],
            ["sgreeks", "Greek charts", true],
            ["backtest", "Backtest", true],
          ];
          const pick = (k: string) => {
            if (k === "schart" || k === "sgreeks" || k === "backtest") setPanel(k);
            else {
              setPanel("payoff");
              setPayoffTab(k as "chart" | "table" | "legs" | "greeks");
            }
          };
          const hint: Record<string, string> = {
            chart: "Payoff at expiry, today and any day in between",
            table: "P&L at each price — today, by day or by hour",
            legs: "Each leg's P&L at the target price and date",
            greeks: "What moves your P&L: price, time, volatility",
            schart: "The legs' combined premium (or P&L) through the day",
            sgreeks: "Net and per-leg Greeks through the day",
            backtest: "Replay these legs against past daily data",
          };
          return (
            <div className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-term-border bg-term-panel px-2 pt-1 [scrollbar-width:none]">
              {TABS.map(([k, l, phone]) => (
                <button
                  key={k}
                  onClick={() => pick(k)}
                  className={`${phone ? "" : "hidden sm:block"} shrink-0 border-b-2 px-3 py-2 text-[12px] font-semibold transition-colors ${
                    active === k
                      ? "border-term-accent text-term-accent"
                      : "border-transparent text-term-dim hover:text-term-text"
                  }`}
                >
                  {l}
                </button>
              ))}
              <span className="ml-auto hidden shrink-0 self-center pl-3 text-[10.5px] text-term-dim xl:inline">{hint[active]}</span>
            </div>
          );
        })()}

        {panel === "backtest" ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {legs.length === 0 ? (
              <div className="text-xs text-term-dim">Add legs (or load a template) to backtest.</div>
            ) : !expiry ? (
              <div className="text-xs text-term-dim">Pick an expiry to backtest.</div>
            ) : (
              <BacktestPanel
                symbol={symbol}
                expiry={expiry}
                legs={scaled(legs)}
                onClose={() => setPanel("payoff")}
              />
            )}
          </div>
        ) : panel === "schart" || panel === "sgreeks" ? (
          <StrategyChart
            key={panel}
            mode={panel === "schart" ? "premium" : "greeks"}
            symbol={symbol}
            expiry={expiry}
            legs={scaled(legs)}
            analysis={analysis}
            held={heldCount > 0}
          />
        ) : (
          <>
        {!analysis && (
          <div className="border-b border-term-border bg-term-panel px-4 py-2 text-xs text-term-dim">
            {err ? <span className="text-down">{err}</span> : "Pick a template or add legs to build a position."}
          </div>
        )}

        {/* ---- folded phone (Galaxy Z Fold6 cover, ~370 px): layout B -- the chart first and big, the
             P&L now on top, 3 key numbers, then Legs | P&L table | Greeks sized to the width ---- */}
        {analysis && (
          <div className="sm:hidden">
            <div className="flex items-baseline justify-between px-3 pt-2">
              <span className="text-[13px] font-semibold text-term-text">
                {analysis.symbol} <span className="font-normal text-term-dim">{analysis.expiry}</span>
              </span>
              <span className="text-[11px] text-term-dim">
                P&amp;L now{" "}
                <span className={`num text-[14px] font-bold ${currentPnl != null ? signColor(currentPnl) : ""}`}>
                  {currentPnl != null ? `${currentPnl >= 0 ? "+" : ""}${nf(currentPnl, 0)}` : "–"}
                </span>
              </span>
            </div>
            <div className="relative mx-1.5 mt-1 flex h-[320px] flex-col rounded border border-term-border bg-term-bg/20 p-1.5">
              <PayoffChart
                x={analysis.x}
                expiryPnl={analysis.expiryPnl}
                nowPnl={analysis.nowPnl}
                spot={analysis.spot}
                breakevens={analysis.breakevens}
                tPnl={tPnl}
                symbol={analysis.symbol}
                tLabel={tLineLabel}
                offset={manualPnl}
                sd={payoffSd}
                margin={analysis.margin?.estimate}
                oi={payoffOi}
              />
            </div>
            <div className="mx-1.5 mt-1.5 grid grid-cols-3 gap-1">
              <div className="rounded border border-term-border bg-term-panel2 px-1.5 py-1">
                <div className="text-[9px] uppercase text-term-dim">Max P / L</div>
                <div className="num text-[12px] font-bold leading-tight">
                  <div className="text-up">
                    {analysis.maxProfitUnbounded ? "Unlimited" : `+${nf(analysis.maxProfit + manualPnl, 0)}`}
                  </div>
                  <div className="text-down">{analysis.maxLossUnbounded ? "Unlimited" : nf(analysis.maxLoss + manualPnl, 0)}</div>
                </div>
              </div>
              <div className="rounded border border-term-border bg-term-panel2 px-1.5 py-1">
                <div className="text-[9px] uppercase text-term-dim">POP</div>
                <div className="num text-[12px] font-bold text-term-text">{analysis.pop != null ? `${nf(analysis.pop, 0)}%` : "–"}</div>
              </div>
              <div className="rounded border border-term-border bg-term-panel2 px-1.5 py-1">
                <div className="text-[9px] uppercase text-term-dim">Margin</div>
                <div className="num text-[12px] font-bold text-term-text">
                  ~{analysis.margin.estimate >= 1e5 ? `${nf(analysis.margin.estimate / 1e5, 2)} L` : nf(analysis.margin.estimate, 0)}
                </div>
              </div>
            </div>
            <div className="mx-1.5 mt-1 flex flex-wrap justify-between gap-x-2 text-[10.5px] text-term-dim">
              <span>BE {analysis.breakevens.map((x) => nf(x, 0)).join(" · ") || "–"}</span>
              <span>
                {analysis.netPremiumType === "CREDIT" ? "credit" : "debit"}{" "}
                <span className={analysis.netPremiumType === "CREDIT" ? "text-up" : "text-down"}>
                  ₹{nf(Math.abs(analysis.netPremium), 0)}
                </span>
              </span>
            </div>
            <div className="seg mx-1.5 mt-2 flex text-[11px]">
              {(
                [
                  ["legs", "Legs"],
                  ["table", "P&L table"],
                  ["greeks", "Greeks"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} onClick={() => setPhoneTab(k)} className={`flex-1 ${phoneTab === k ? "on" : ""}`}>
                  {l}
                </button>
              ))}
            </div>
            <div className="mx-1.5 mb-2 mt-1 text-[11.5px]">
              {phoneTab === "legs" ? (
                <>
                  <div className="py-1 text-[10px] text-term-dim">
                    P&amp;L @ {nf(tgtPrice, 0)} · {tLegLabel}
                  </div>
                  {legRows.map((r, i) => (
                    <div key={i} className="flex items-baseline justify-between gap-2 border-b border-term-border/50 py-1.5">
                      <span className="num min-w-0 truncate font-semibold">
                        <span className={r.leg.side === "BUY" ? "text-up" : "text-down"}>{r.label.slice(0, 1)}</span>
                        {r.label.slice(1)}
                      </span>
                      <span className="num shrink-0 text-term-dim">
                        {nf(r.entry, 1)} → {nf(r.ltp, 1)}
                      </span>
                      <span className={`num w-16 shrink-0 text-right font-semibold ${pnlCls(r.tgtPnl)}`}>{pnlTxt(r.tgtPnl)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between py-1.5 font-semibold">
                    <span>Total</span>
                    <span className={`num ${pnlCls(legTot + manualPnl)}`}>{pnlTxt(legTot + manualPnl)}</span>
                  </div>
                </>
              ) : phoneTab === "table" ? (
                (() => {
                  const all = levelRows;
                  const ai = Math.max(0, all.findIndex((r) => r.isATM));
                  const rowsP = all.slice(Math.max(0, ai - phoneRows), ai + phoneRows + 1);
                  const off = Math.max(0, ai - phoneRows); // rowsP[j] = all[off + j]
                  const selDay = tradeDays.find((d) => d.points.some((pt) => pt.key === phonePt));
                  return (
                    <>
                      <div className="flex gap-1 overflow-x-auto py-1 text-[11px] [scrollbar-width:none]">
                        <button onClick={() => setPhonePt("now")} className={`chipbtn shrink-0 ${phonePt === "now" ? "on" : ""}`}>
                          Now
                        </button>
                        {tradeDays.map((d) => (
                          <button
                            key={d.key}
                            onClick={() => setPhonePt(d.points[d.points.length - 1].key)}
                            className={`chipbtn shrink-0 ${selDay?.key === d.key ? "on" : ""}`}
                          >
                            {d.label.replace(" · Expiry", "")}
                          </button>
                        ))}
                      </div>
                      {selDay && selDay.points.length > 1 && (
                        <div className="flex gap-1 overflow-x-auto pb-1 text-[10.5px] [scrollbar-width:none]">
                          {selDay.points.map((pt) => (
                            <button key={pt.key} onClick={() => setPhonePt(pt.key)} className={`chipbtn shrink-0 ${phonePt === pt.key ? "on" : ""}`}>
                              {pt.label}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex border-b border-term-border py-1 text-[10px] uppercase text-term-dim">
                        <span className="flex-1">{tableInterval > 0 ? "Target" : "Strike"}</span>
                        <span className="flex-1 text-right normal-case">{phoneCol ? phoneCol.label : "Now"}</span>
                        <span className="flex-1 text-right">Expiry</span>
                      </div>
                      {rowsP.map((r, i) => (
                        <div
                          key={i}
                          className={`num flex border-b border-term-border/50 py-1.5 ${r.isATM ? "bg-amber-500/15" : ""}`}
                        >
                          <span className="flex-1 font-medium text-term-text">
                            {sk(r.K)}
                            {r.isATM && <span className="text-amber-400"> ●</span>}
                          </span>
                          {(() => {
                            const v = (phoneCol ? phoneCol.vals[off + i] : r.now) + manualPnl;
                            return <span className={`flex-1 text-right ${pnlCls(v)}`}>{pnlTxt(v)}</span>;
                          })()}
                          <span className={`flex-1 text-right ${pnlCls(r.exp + manualPnl)}`}>{pnlTxt(r.exp + manualPnl)}</span>
                        </div>
                      ))}
                      <button
                        onClick={() => setPhoneRows((n) => (n > 3 ? 3 : 10))}
                        className="mt-1 w-full py-1 text-center text-[11px] font-semibold text-term-accent"
                      >
                        {phoneRows > 3 ? "Fewer rows" : "More rows"}
                      </button>
                    </>
                  );
                })()
              ) : (
                <>
                  <div className="grid grid-cols-4 gap-1 py-1.5">
                    {(
                      [
                        ["Δ Delta", greekTot.delta, 1],
                        ["Γ Gamma", greekTot.gamma, 4],
                        ["Θ / day", greekTot.theta, 0],
                        ["V Vega", greekTot.vega, 0],
                      ] as [string, number, number][]
                    ).map(([k, v, d]) => (
                      <div key={k} className="rounded border border-term-border bg-term-panel2 px-1 py-1 text-center">
                        <div className="text-[9px] uppercase text-term-dim">{k}</div>
                        <div className={`num text-[12px] font-bold ${signColor(v)}`}>{nf(v, d)}</div>
                      </div>
                    ))}
                  </div>
                  <div className="flex border-b border-term-border py-1 text-[10px] uppercase text-term-dim">
                    <span className="w-[34%]">Leg</span>
                    <span className="flex-1 text-right">Δ</span>
                    <span className="flex-1 text-right">Θ</span>
                    <span className="flex-1 text-right">V</span>
                  </div>
                  {greekRows.map((r, i) => (
                    <div key={i} className="num flex border-b border-term-border/50 py-1.5">
                      <span className="w-[34%] truncate font-semibold">{r.label}</span>
                      <span className={`flex-1 text-right ${signColor(r.delta)}`}>{nf(r.delta, 2)}</span>
                      <span className={`flex-1 text-right ${signColor(r.theta)}`}>{nf(r.theta, 0)}</span>
                      <span className={`flex-1 text-right ${signColor(r.vega)}`}>{nf(r.vega, 0)}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        )}

        <div className="hidden sm:contents">
        {payoffTab === "chart" || payoffTab === "stats" ? (
          <div className="relative m-2 flex h-[480px] flex-col rounded-lg border border-term-border bg-term-bg/20 p-3 lg:h-auto lg:min-h-[460px] lg:flex-1">
            {analysis && (
              <PayoffChart
                x={analysis.x}
                expiryPnl={analysis.expiryPnl}
                nowPnl={analysis.nowPnl}
                spot={analysis.spot}
                breakevens={analysis.breakevens}
                tPnl={tPnl}
                symbol={analysis.symbol}
                tLabel={tLineLabel}
                offset={manualPnl}
                sd={payoffSd}
                margin={analysis.margin?.estimate}
                oi={payoffOi}
              />
            )}
          </div>
        ) : payoffTab === "table" ? (
          <div className="m-2 rounded border border-term-border bg-term-bg/20">
            {analysis &&
              (() => {
                // one set of columns for every view: Today + Expiry (+ the slider's what-if), or day / hour columns
                type Col = { key: string; label: string; sub?: string; exp?: boolean; val: (i: number) => number };
                const cols: Col[] =
                  timeMode === "basic"
                    ? [
                        { key: "now", label: "Today", sub: "now", val: (i) => levelRows[i].now },
                        ...(tDays > 0 || ivShift !== 0
                          ? [{ key: "tv", label: tvColLabel, sub: "what-if", val: (i: number) => levelRows[i].tv ?? 0 }]
                          : []),
                        { key: "exp", label: "Expiry", sub: analysis.expiry, exp: true, val: (i) => levelRows[i].exp },
                      ]
                    : timeCols.map((c, ci) => ({
                        key: c.key,
                        label: c.label,
                        sub: c.sub,
                        exp: c.rem <= 0.0001,
                        val: (i: number) => timeVals[ci]?.[i] ?? 0,
                      }));
                let maxAbs = 1;
                levelRows.forEach((_, i) => cols.forEach((c) => (maxAbs = Math.max(maxAbs, Math.abs(c.val(i) + manualPnl)))));
                // heatmap: green profit / red loss, deeper the bigger (sqrt so small amounts still show)
                const heat = (v: number) => {
                  const a = 0.06 + 0.34 * Math.sqrt(Math.min(1, Math.abs(v) / maxAbs));
                  return v >= 0 ? `rgba(34,197,94,${a.toFixed(3)})` : `rgba(239,68,68,${a.toFixed(3)})`;
                };
                // spot + breakeven lines drawn BETWEEN the rows they fall between (rows run high -> low)
                const marks = [
                  { v: analysis.spot, kind: "spot" as const },
                  ...analysis.breakevens.map((v) => ({ v, kind: "be" as const })),
                ].sort((x, y) => y.v - x.v);
                const nCols = 1 + (showPct ? 1 : 0) + cols.length;
                const lbl = "text-[9px] font-semibold uppercase tracking-wider text-term-dim";
                const body: React.ReactNode[] = [];
                let mi = 0;
                levelRows.forEach((r, i) => {
                  while (mi < marks.length && marks[mi].v > r.K) {
                    const m = marks[mi++];
                    if (i === 0) continue; // above the table's top row: nothing to draw between
                    body.push(
                      <tr key={`m${mi}`}>
                        <td colSpan={nCols} className="p-0">
                          <div
                            className={`flex items-center gap-2 px-2 py-0.5 text-[10px] font-semibold ${
                              m.kind === "spot" ? "bg-amber-500/15 text-amber-300" : "text-sky-300"
                            }`}
                            style={{
                              borderTop: `1px ${m.kind === "spot" ? "solid rgba(245,158,11,.7)" : "dashed rgba(56,189,248,.7)"}`,
                            }}
                          >
                            {m.kind === "spot" ? `▶ Spot ${nf(m.v, 2)}` : `Breakeven ${nf(m.v, 0)}`}
                            <span className="font-normal opacity-70">
                              {m.kind === "be" &&
                                `${m.v >= analysis.spot ? "+" : ""}${nf(((m.v - analysis.spot) / analysis.spot) * 100, 1)}% from spot`}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  }
                  body.push(
                    <tr key={i} ref={r.isATM ? atmRowRef : undefined} className="group">
                      <td
                        className={`num sticky left-0 z-[1] border-b border-r border-term-border/50 bg-term-panel px-3 py-1.5 text-right text-[12px] font-semibold text-term-text group-hover:bg-term-panel2 ${
                          r.isATM ? "text-amber-300" : ""
                        }`}
                        style={{
                          boxShadow: r.isWall ? "inset 3px 0 0 #ef4444" : r.isFloor ? "inset 3px 0 0 #22c55e" : undefined,
                        }}
                        title={r.isWall ? "biggest Call OI (resistance)" : r.isFloor ? "biggest Put OI (support)" : undefined}
                      >
                        {sk(r.K)}
                        {r.isWall && <sup className="ml-0.5 text-down">R</sup>}
                        {r.isFloor && <sup className="ml-0.5 text-up">S</sup>}
                      </td>
                      {showPct && (
                        <td
                          className={`num border-b border-r border-term-border/50 px-2 py-1.5 text-right text-[11px] ${
                            r.pct >= 0 ? "text-up" : "text-down"
                          }`}
                        >
                          {r.pct >= 0 ? "+" : ""}
                          {nf(r.pct * 100, 1)}%
                        </td>
                      )}
                      {cols.map((c) => {
                        const v = c.val(i) + manualPnl;
                        return (
                          <td
                            key={c.key}
                            className={`num border-b border-r border-term-border/40 px-3 py-1.5 text-right text-[12px] font-medium group-hover:brightness-125 ${
                              v >= 0 ? "text-green-300" : "text-red-300"
                            } ${c.exp ? "border-l border-l-term-border" : ""}`}
                            style={{ backgroundColor: heat(v) }}
                          >
                            {pnlTxt(v)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                });
                return (
                  <>
                    {/* header: what the table is + the controls, grouped */}
                    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-term-border bg-term-panel2/60 px-3 py-2">
                      <div>
                        <div className="text-[13px] font-semibold text-term-text">
                          P&amp;L table <span className="font-normal text-term-dim">· {analysis.symbol} {analysis.expiry}</span>
                        </div>
                        <div className="text-[11px] text-term-dim">
                          spot <span className="num text-amber-300">{nf(analysis.spot, 2)}</span> · by{" "}
                          {tableInterval > 0 ? `${tableInterval}-pt targets` : "strike"}
                          {ivShift ? ` · IV ${ivShift > 0 ? "+" : ""}${ivShift}%` : ""}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-end gap-3">
                        <div>
                          <div className={lbl}>View</div>
                          <div className="seg mt-0.5 text-[10.5px]" title="Sensibull-style: P&L on each trading day, or by the hour">
                            {(
                              [
                                ["basic", "Today · Expiry"],
                                ["day", "Day-wise"],
                                ["hour", "Hour-wise"],
                              ] as const
                            ).map(([k, l]) => (
                              <button key={k} onClick={() => setTimeMode(k)} className={timeMode === k ? "on" : ""}>
                                {l}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className={lbl}>Rows</div>
                          <div className="seg mt-0.5 text-[10.5px]">
                            {[5, 10, 15, 20, 0].map((n) => (
                              <button key={n} onClick={() => setStrikeSpan(n)} className={strikeSpan === n ? "on" : ""}>
                                {n === 0 ? "All" : `±${n}`}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className={lbl}>Step</div>
                          <div className="seg mt-0.5 text-[10.5px]">
                            {([["strikes", 0], ["50", 50], ["100", 100], ["200", 200]] as const).map(([l, v]) => (
                              <button
                                key={l}
                                onClick={() => setTableInterval(v)}
                                className={tableInterval === v ? "on" : ""}
                                title={v ? `one row every ${v} points of the index (a target level, not an option strike)` : "one row per real strike in the option chain"}
                              >
                                {l}
                              </button>
                            ))}
                          </div>
                        </div>
                        {timeMode === "basic" && (
                          <div>
                            <div className={lbl}>
                              Time{" "}
                              <span className="normal-case tracking-normal text-amber-300">
                                {tDays === 0 ? "now" : tDays >= dte ? "expiry" : `${tDateLbl} · ${leftLbl(tDays)}`}
                              </span>
                            </div>
                            <div className="seg mt-0.5 text-[10.5px]" title="adds a what-if column: P&L on that day">
                              {dayChips.map((d) => (
                                <button
                                  key={d}
                                  onClick={() => setTDays(d)}
                                  title={
                                    d === 0
                                      ? "today (T+0)"
                                      : `${new Date(Date.now() + d * 86400000).toLocaleDateString("en-IN", {
                                          day: "2-digit",
                                          month: "short",
                                        })} · ${leftLbl(d)}`
                                  }
                                  className={tDays === d ? "on" : ""}
                                >
                                  {d === 0 ? "Now" : d === dte ? "Exp" : `+${d}`}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        <div>
                          <div className={lbl}>IV shift</div>
                          <div className="mt-0.5 flex items-center gap-1 text-[10.5px]" title="moves every leg's IV by this many points, in every column">
                            <button onClick={() => setIvShift((v) => Math.max(-15, v - 1))} className="chipbtn px-2">
                              −
                            </button>
                            <span
                              className={`num w-14 text-center font-semibold ${
                                ivShift > 0 ? "text-up" : ivShift < 0 ? "text-down" : "text-term-text"
                              }`}
                            >
                              {ivShift === 0 ? "0 (now)" : `${ivShift > 0 ? "+" : ""}${ivShift}%`}
                            </span>
                            <button onClick={() => setIvShift((v) => Math.min(15, v + 1))} className="chipbtn px-2">
                              +
                            </button>
                            {ivShift !== 0 && (
                              <button onClick={() => setIvShift(0)} className="chipbtn">
                                reset
                              </button>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => setShowPct((v) => !v)}
                          className={`chipbtn ${showPct ? "on" : ""}`}
                          title="add a Move column: how far each row is from spot, in %"
                        >
                          % move
                        </button>
                      </div>
                    </div>
                    {timeMode === "hour" && (
                      <div className="flex flex-wrap items-center gap-1 border-b border-term-border px-3 py-1.5 text-[11px]">
                        <span className="mr-1 text-term-dim">Day</span>
                        {tradeDays.map((d, i) => (
                          <button key={d.key} onClick={() => setHourDay(i)} className={`chipbtn ${hourDay === i ? "on" : ""}`}>
                            {d.label}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="max-h-[560px] overflow-auto">
                      <table className="w-full border-separate border-spacing-0 whitespace-nowrap">
                        <thead className="sticky top-0 z-[2]">
                          <tr>
                            <th className="sticky left-0 z-[3] border-b border-r border-term-border bg-term-panel2 px-3 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-term-dim">
                              {tableInterval > 0 ? "Target" : "Strike"}
                            </th>
                            {showPct && (
                              <th className="border-b border-r border-term-border bg-term-panel2 px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-term-dim">
                                Move
                              </th>
                            )}
                            {cols.map((c) => (
                              <th
                                key={c.key}
                                className={`border-b border-r border-term-border bg-term-panel2 px-3 py-1.5 text-right ${
                                  c.exp ? "border-l border-l-term-border" : ""
                                }`}
                              >
                                <div className={`text-[11.5px] font-semibold ${c.exp ? "text-term-accent" : "text-term-text"}`}>{c.label}</div>
                                {c.sub && <div className="text-[9.5px] font-normal text-term-dim">{c.sub}</div>}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>{body}</tbody>
                      </table>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-term-border px-3 py-1.5 text-[10px] text-term-dim">
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: "rgba(34,197,94,.35)" }} /> profit
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: "rgba(239,68,68,.35)" }} /> loss · deeper = bigger
                      </span>
                      <span>
                        <span className="text-amber-300">▶ spot</span> · <span className="text-sky-300">┄ breakeven</span>
                      </span>
                      <span>
                        <span className="text-down">R</span> biggest call OI · <span className="text-up">S</span> biggest put OI
                      </span>
                    </div>
                  </>
                );
              })()}
          </div>
        ) : payoffTab === "legs" ? (
          legsEl
        ) : (
          greeksEl
        )}
        </div>

        {analysis && (
          <div className="m-2 mt-0 rounded border border-term-border bg-term-bg/20 p-3 text-[10px]">
            {/* on the P&L table (laptop / unfolded) Time + IV shift sit in the table's own header instead */}
            <div className={payoffTab === "table" ? "sm:hidden" : ""}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-semibold uppercase tracking-wide text-term-dim">
                Time to expiry
              </span>
              <input
                type="range"
                min={0}
                max={dte}
                step={1}
                value={Math.min(tDays, dte)}
                onChange={(e) => setTDays(Number(e.target.value))}
                className="h-1 flex-1 min-w-[140px] cursor-pointer accent-amber-500"
              />
              <span className="num w-[188px] shrink-0 text-right text-term-text">
                {tDays === 0 ? (
                  <>now · T+0 · {leftLbl(0)}</>
                ) : tDays >= dte ? (
                  <>expiry day · 0d left</>
                ) : (
                  <>
                    T+{tDays}d · {tDateLbl} · {leftLbl(tDays)}
                  </>
                )}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="text-term-dim">Day</span>
              {dayChips.map((d) => (
                <button
                  key={d}
                  onClick={() => setTDays(d)}
                  title={
                    d === 0
                      ? "today (T+0)"
                      : `${new Date(Date.now() + d * 86400000).toLocaleDateString("en-IN", {
                          day: "2-digit",
                          month: "short",
                        })} · ${leftLbl(d)}`
                  }
                  className={`chipbtn num ${tDays === d ? "border-transparent bg-amber-500 text-black" : ""}`}
                >
                  {d === 0 ? "Now" : d === dte ? "Exp" : `+${d}`}
                </button>
              ))}
            </div>
            {/* what-if IV shift — applied to every leg's IV for the T+n curve/table/greeks */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-term-border/50 pt-1.5">
              <span className="font-semibold uppercase tracking-wide text-term-dim">IV shift</span>
              <input
                type="range"
                min={-15}
                max={15}
                step={1}
                value={ivShift}
                onChange={(e) => setIvShift(Number(e.target.value))}
                className="h-1 flex-1 min-w-[140px] cursor-pointer accent-fuchsia-500"
              />
              <span className="num w-[188px] shrink-0 text-right text-term-text">
                {ivShift === 0 ? (
                  "unchanged"
                ) : (
                  <span className={ivShift > 0 ? "text-up" : "text-down"}>
                    {ivShift > 0 ? "+" : ""}
                    {ivShift}% IV
                  </span>
                )}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="text-term-dim">IV</span>
              {IV_SHIFT_CHIPS.map((v) => (
                <button
                  key={v}
                  onClick={() => setIvShift(v)}
                  title={v === 0 ? "current IV" : `IV ${v > 0 ? "+" : ""}${v} points (e.g. 12% -> ${12 + v}%)`}
                  className={`chipbtn num ${ivShift === v ? "border-transparent bg-fuchsia-500 text-black" : ""}`}
                >
                  {v === 0 ? "0" : `${v > 0 ? "+" : ""}${v}%`}
                </button>
              ))}
            </div>
            </div>
            {/* target price — drives Legs P&L, Greeks and the T+n column */}
            <div
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${
                payoffTab === "table" ? "sm:mt-0 sm:border-t-0 sm:pt-0" : ""
              } mt-1.5 border-t border-term-border/50 pt-1.5`}
            >
              <span className="font-semibold uppercase tracking-wide text-term-dim">
                {symbol} target
              </span>
              <input
                type="range"
                min={Math.round(analysis.spot * 0.85)}
                max={Math.round(analysis.spot * 1.15)}
                step={chain?.strikeStep || 50}
                value={Math.round(tgtPrice)}
                onChange={(e) => setTPrice(Number(e.target.value))}
                className="h-1 flex-1 min-w-[140px] cursor-pointer accent-sky-500"
              />
              <span className="num w-[188px] shrink-0 text-right text-term-text">
                {nf(tgtPrice, 0)}{" "}
                <span className={tgtPrice >= analysis.spot ? "text-up" : "text-down"}>
                  ({tgtPrice >= analysis.spot ? "+" : ""}
                  {nf(((tgtPrice - analysis.spot) / analysis.spot) * 100, 1)}%)
                </span>
              </span>
              <button
                onClick={() => setTPrice(Math.round(analysis.spot))}
                className="chipbtn"
              >
                reset
              </button>
            </div>
          </div>
        )}

        {analysis && (
          <div className="flex flex-wrap items-center gap-x-3 border-t border-term-border px-4 py-1 text-[10px]">
            <span className="uppercase tracking-wide text-term-dim">IV regime</span>
            <span className={`font-semibold ${ivReg.cls}`} title={ivReg.hint}>
              {ivReg.label}
              {ivReg.pctile != null ? ` · ${ivReg.pctile}%ile` : ""}
            </span>
            <span className="num text-term-dim">
              ATM IV {chain?.atmIV ? `${nf(chain.atmIV, 1)}%` : "–"}
            </span>
            <span className="num text-term-dim">
              net vega {nf(analysis.greeks.vega, 0)}
            </span>
            {ivFitMsg && <span className={ivFitMsg.cls}>→ {ivFitMsg.txt}</span>}
          </div>
        )}

        <div className="border-t border-term-border px-4 py-1 text-[10px] text-term-dim">
          {payoffTab === "table"
            ? "Today = now (T+0) at current IV. Expiry = intrinsic value. The extra column follows the sliders. Black-Scholes with per-leg IV — indicative."
            : analysis?.margin.basis
            ? `Margin basis: ${analysis.margin.basis}. Payoff / T+n curve use per-leg IV & Black-Scholes — indicative, not broker-accurate.`
            : "White = at expiry · amber = the T+n day on the slider · purple dashed = now (T+0)."}
        </div>
          </>
        )}
      </div>
    </div>
  );
}
