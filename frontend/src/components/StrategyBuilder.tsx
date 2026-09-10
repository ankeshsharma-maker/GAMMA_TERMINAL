import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
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
import { SelectMenu } from "./SelectMenu";

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
function StatCol({ label, value, cls = "" }: { label: string; value: React.ReactNode; cls?: string }) {
  return (
    <td className="border-r border-term-border/60 px-3 py-1.5 text-left last:border-r-0">
      <div className="text-[9px] uppercase tracking-wide text-term-dim">{label}</div>
      <div className={`num text-sm font-semibold ${cls}`}>{value}</div>
    </td>
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
    loadSchedules();
    const id = window.setInterval(loadSchedules, 30000);
    return () => window.clearInterval(id);
  }, [loadSchedules]);

  const [hedgeMax, setHedgeMax] = useState<number>(5000);
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
  const [panel, setPanel] = useState<"payoff" | "backtest">("payoff");
  const [payoffTab, setPayoffTab] = useState<"chart" | "table" | "legs" | "greeks">("chart");
  const [strikeSpan, setStrikeSpan] = useState(10); // ATM ± N strikes in the P&L table
  const [dayPct, setDayPct] = useState(3); // ± move for the day-by-day P&L columns
  const [tableInterval, setTableInterval] = useState(0); // 0 = chain strikes; else ₹ step
  const [showPct, setShowPct] = useState(true); // show the "Move %" column
  const [gMulLot, setGMulLot] = useState(true); // greeks × lot size
  const [gMulQty, setGMulQty] = useState(true); // greeks × number of lots
  const [manualPnl, setManualPnl] = useState(0); // booked / manual P&L offset added to every P&L
  const [manualStr, setManualStr] = useState("");
  const [ivSeries, setIvSeries] = useState<number[]>([]);
  // "time to expiry" payoff: days from today (0 = now / T+0, dte = expiry)
  const [tDays, setTDays] = useState(0);
  // "target price" — the underlying level the leg tables / stats project to
  const [tPrice, setTPrice] = useState(0);
  // customise "+ Add leg": pick type / strike / side / lots for the next leg
  const [newLegOT, setNewLegOT] = useState<OptionType>("CE");
  const [newLegSide, setNewLegSide] = useState<"BUY" | "SELL">("BUY");
  const [newLegLots, setNewLegLots] = useState(1);
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

  useEffect(() => {
    api.strategyTemplates(symbol, expiry ?? undefined).then(
      (d) => setTemplates(d.templates),
      () => {}
    );
  }, [symbol, expiry]);

  useEffect(() => {
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
          .analyzeStrategy({ symbol, expiry: expiry ?? undefined, legs: nextLegs })
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
    if (!legs.length || !expiry || !(hedgeMax > 0)) return;
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
      },
    ]);

  const setLeg = (i: number, patch: Partial<StrategyLeg>) =>
    update(legs.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const removeLeg = (i: number) => update(legs.filter((_, idx) => idx !== i));

  const loadTemplate = (name: string) => {
    if (name && templates[name]) {
      setFromBroker(false);
      setAddingLeg(false);
      update(templates[name].map((l) => ({ ...l })));
    }
  };

  const loadFromPaper = () =>
    api.strategyFromPaper().then(
      (d) => {
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
    api.strategyFromBroker().then(
      (d) => {
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

  const loadSaved = (s: SavedStrategy) => update(s.legs.map((l) => ({ ...l })));
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
  const dte = Math.max(1, Math.round(analysis?.dte ?? 0));
  useEffect(() => {
    setTDays((d) => Math.min(d, dte));
  }, [dte, analysis?.symbol, analysis?.expiry, legs.length]);

  // intermediate payoff curve at (dte - tDays) days left, computed client-side
  const tPnl = useMemo(() => {
    if (!analysis || tDays <= 0) return null;
    const remYears = Math.max((dte - tDays) / 365, 0);
    return strategyPnlCurve(analysis.legs, analysis.x, remYears);
  }, [analysis, tDays, dte]);
  const tDate = new Date(Date.now() + tDays * 86400000);
  const tDateLbl = tDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  const remYears = Math.max((dte - tDays) / 365, 0);

  // reset the target price to spot when the position / symbol changes
  useEffect(() => {
    if (analysis) setTPrice(Math.round(analysis.spot));
  }, [analysis?.symbol, analysis?.expiry]);
  const tgtPrice = tPrice > 0 ? tPrice : analysis?.spot ?? 0;

  // position time value / intrinsic value (Sensibull-style), current
  const posVal = useMemo(
    () => (analysis ? positionValue(analysis.legs, analysis.spot, dte / 365) : null),
    [analysis, dte]
  );

  // per-leg P&L at the (target price, target date)
  const legRows = useMemo(() => {
    if (!analysis) return [];
    const nowY = dte / 365;
    return analysis.legs.map((leg) => ({
      leg,
      label: `${leg.side === "BUY" ? "B" : "S"} ${leg.lots}×${
        leg.optionType === "FUT" ? "FUT" : `${sk(leg.strike)}${leg.optionType}`
      }`,
      entry: leg.entry,
      ltp: legPriceAt(leg, analysis.spot, nowY),
      tgtPx: legPriceAt(leg, tgtPrice, remYears),
      tgtPnl: legPnlAt(leg, tgtPrice, remYears),
    }));
  }, [analysis, tgtPrice, remYears, dte]);

  // per-leg greeks at the target (price, date)
  const greekRows = useMemo(() => {
    if (!analysis) return [];
    const lot = analysis.lotSize || 1;
    return analysis.legs.map((leg) => {
      const g =
        leg.optionType === "FUT"
          ? { delta: 1, gamma: 0, theta: 0, vega: 0 }
          : bsGreeks(leg.optionType, tgtPrice, leg.strike, remYears, (leg.iv || 0) / 100);
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
  }, [analysis, tgtPrice, remYears, gMulLot, gMulQty]);
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

    let strikes: number[];
    if (tableInterval > 0) {
      // fixed ₹ interval around spot (Sensibull "Target Interval")
      const base = Math.round(spot / tableInterval) * tableInterval;
      strikes = [];
      for (let i = -strikeSpan; i <= strikeSpan; i++) strikes.push(base + i * tableInterval);
    } else if (chain && chain.rows.length) {
      const ks = chain.rows.map((r) => r.strike).sort((a, b) => a - b);
      let ai = ks.indexOf(chain.atmStrike);
      if (ai < 0)
        ai = ks.reduce(
          (best, k, i) => (Math.abs(k - spot) < Math.abs(ks[best] - spot) ? i : best),
          0
        );
      strikes = ks.slice(Math.max(0, ai - strikeSpan), ai + strikeSpan + 1);
    } else {
      const base = Math.round(spot / step) * step;
      strikes = [];
      for (let i = -strikeSpan; i <= strikeSpan; i++) strikes.push(base + i * step);
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
    const remYears = Math.max((dte - tDays) / 365, 0);
    const tv = tDays > 0 ? strategyPnlCurve(analysis.legs, strikes, remYears) : null;

    return strikes
      .map((k, i) => ({
        K: k,
        pct: (k - spot) / spot,
        exp: exp[i],
        tv: tv ? tv[i] : null,
        isATM: chain ? k === chain.atmStrike : Math.abs(k - spot) <= step / 2,
        isWall: k === wall.k && wall.v > 0,
        isFloor: k === floor.k && floor.v > 0,
      }))
      .reverse(); // high strike on top, like the chain ladder
  }, [analysis, tDays, dte, strikeSpan, tableInterval, chain]);

  // ---- day-by-day P&L at spot and ±dayPct% (theta decay to expiry) ----
  const dayRows = useMemo(() => {
    if (!analysis) return [];
    const spot = analysis.spot;
    const dn = spot * (1 - dayPct / 100);
    const up = spot * (1 + dayPct / 100);
    const step = Math.max(1, Math.ceil((dte + 1) / 16));
    const mk = (d: number) => {
      const [a, b, c] = strategyPnlCurve(analysis.legs, [dn, spot, up], Math.max((dte - d) / 365, 0));
      return {
        d,
        date: new Date(Date.now() + d * 86400000).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
        }),
        left: dte - d,
        dn: a,
        sp: b,
        up: c,
      };
    };
    const rows = [];
    for (let d = 0; d <= dte; d += step) rows.push(mk(d));
    if (!rows.length || rows[rows.length - 1].d !== dte) rows.push(mk(dte));
    return rows;
  }, [analysis, dte, dayPct]);

  const pnlCls = (v: number) => (v >= 0 ? "text-up" : "text-down");
  const mp = (v: number | null | undefined) => (v == null ? null : v + manualPnl);
  const pnlTxt = (v: number | null) => (v == null ? "–" : `${v >= 0 ? "+" : ""}${nf(v, 0)}`);

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
  const legsEl = analysis && (
    <div className="m-2 rounded border border-term-border bg-term-bg/20 p-3 lg:min-h-0 lg:flex-1 lg:overflow-auto">
      <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-term-dim">
        Legs P&amp;L @ {nf(tgtPrice, 0)} · {tDays === 0 ? "now" : tDateLbl}
      </div>
      <table className="block w-full overflow-x-auto whitespace-nowrap border-separate border-spacing-0 border border-term-border text-2xs [&_td:last-child]:border-r-0 [&_td]:border-b [&_td]:border-r [&_td]:border-term-border/60 [&_th:last-child]:border-r-0 [&_th]:border-b [&_th]:border-r [&_th]:border-term-border">
        <thead className="text-[10px] uppercase text-term-dim">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Instrument</th>
            <th className="px-2 py-1 text-right font-medium">Target P&amp;L</th>
            <th className="px-2 py-1 text-right font-medium">Target price</th>
            <th className="px-2 py-1 text-right font-medium">Entry</th>
            <th className="px-2 py-1 text-right font-medium">LTP (now)</th>
          </tr>
        </thead>
        <tbody>
          {legRows.map((r, i) => (
            <tr key={i}>
              <td className="num border-b border-r border-term-border/50 px-2 py-1">{r.label}</td>
              <td className={gCell(r.tgtPnl, 0)}>{pnlTxt(r.tgtPnl)}</td>
              <td className="num border-b border-r border-term-border/50 px-2 py-1 text-right text-term-text">
                {nf(r.tgtPx, 2)}
              </td>
              <td className="num border-b border-r border-term-border/50 px-2 py-1 text-right text-term-dim">
                {nf(r.entry, 2)}
              </td>
              <td className="num border-b border-r border-term-border/50 px-2 py-1 text-right text-term-dim">
                {nf(r.ltp, 2)}
              </td>
            </tr>
          ))}
          {manualPnl !== 0 && (
            <tr>
              <td className="border-b border-r border-term-border/50 px-2 py-1 text-term-dim">
                Manual P&amp;L
              </td>
              <td className={gCell(manualPnl, 0)}>{pnlTxt(manualPnl)}</td>
              <td className="border-b border-r border-term-border/50 px-2 py-1" />
              <td className="border-b border-r border-term-border/50 px-2 py-1" />
              <td className="border-b border-r border-term-border/50 px-2 py-1" />
            </tr>
          )}
          <tr className="bg-term-panel2 font-semibold">
            <td className="border-b border-r border-term-border/50 px-2 py-1">Total (projected)</td>
            <td className={gCell(legTot + manualPnl, 0)}>{pnlTxt(legTot + manualPnl)}</td>
            <td className="border-b border-r border-term-border/50 px-2 py-1" />
            <td className="border-b border-r border-term-border/50 px-2 py-1" />
            <td className="border-b border-r border-term-border/50 px-2 py-1" />
          </tr>
        </tbody>
      </table>
      <p className="mt-1 text-[9px] text-term-dim">
        Target P&amp;L / price = Black-Scholes at the target price &amp; date sliders. LTP = theoretical now.
      </p>
    </div>
  );

  // ---- Greeks tab: per-leg greeks at the (target price, target date) ----
  const greeksEl = analysis && (
    <div className="m-2 rounded border border-term-border bg-term-bg/20 p-3 lg:min-h-0 lg:flex-1 lg:overflow-auto">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
        <span className="text-2xs font-semibold uppercase tracking-wide text-term-dim">
          Greeks @ {nf(tgtPrice, 0)} · {tDays === 0 ? "now" : tDateLbl}
        </span>
        <div className="flex gap-1 text-[10px]">
          <button
            onClick={() => setGMulLot((v) => !v)}
            className={`rounded px-1.5 py-0.5 ${gMulLot ? "bg-term-accent text-white" : "bg-term-border text-term-dim"}`}
          >
            × lot size
          </button>
          <button
            onClick={() => setGMulQty((v) => !v)}
            className={`rounded px-1.5 py-0.5 ${gMulQty ? "bg-term-accent text-white" : "bg-term-border text-term-dim"}`}
          >
            × num lots
          </button>
        </div>
      </div>
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
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-term-border lg:grid lg:grid-cols-[330px_minmax(0,1fr)] lg:overflow-hidden">
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
            <button className="btn flex-1 text-2xs" onClick={loadFromPaper}>
              From paper positions
            </button>
            <button
              className="btn flex-1 text-2xs"
              onClick={() => {
                setFromBroker(false);
                update([]);
              }}
            >
              Clear
            </button>
          </div>
          {broker?.authed && (
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
                    : "border-term-border text-term-dim"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col">
          {legs.length === 0 && (
            <div className="px-2 py-3 text-center text-2xs text-term-dim">
              No legs yet — load a template or build one below.
            </div>
          )}
          {legs.map((leg, i) => (
            <div
              key={i}
              className={`border-b border-term-border/50 p-2 text-2xs ${
                leg.held ? "bg-amber-500/[0.07]" : ""
              }`}
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
                      : "border-term-border text-term-dim hover:text-term-text"
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
                  <SelectMenu
                    value={leg.strike}
                    options={(strikes.includes(leg.strike) ? strikes : [leg.strike, ...strikes]).map(
                      (k) => [`${sk(k)}${k === atm ? "  (ATM)" : ""}`, k] as [string, number]
                    )}
                    onChange={(k) => setLeg(i, { strike: Number(k) })}
                    title="Strike"
                    width={110}
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
                  className="rounded border border-term-border px-1.5 py-1 text-term-dim hover:text-down"
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
                  <input
                    type="number"
                    step="0.05"
                    min="0"
                    value={leg.price ?? ""}
                    placeholder={analysis?.legs[i] ? nf(analysis.legs[i].entry) : "LTP"}
                    onChange={(e) =>
                      setLeg(i, { price: e.target.value === "" ? null : Number(e.target.value) })
                    }
                    className="num w-16 rounded border border-term-border bg-term-bg px-1 py-0.5 text-right text-term-text"
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
              {leg.held && (
                <div className="mt-1 text-[9px] text-amber-400/80">
                  held position ·{" "}
                  {executeHeld ? "will be sent on Execute" : "in payoff, skipped on Execute"}
                </div>
              )}
            </div>
          ))}
        </div>

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
                    <SelectMenu
                      value={newLegStrike || atm}
                      options={strikes.map(
                        (k) => [`${sk(k)}${k === atm ? "  (ATM)" : ""}`, k] as [string, number]
                      )}
                      onChange={(k) => setNewLegStrike(Number(k))}
                      title="Strike"
                      width={110}
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
                <button
                  onClick={() => {
                    addLeg();
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
          <div className="border-t border-term-border p-2">
            <div className="mb-1 flex items-center gap-1 text-2xs">
              <span className="font-semibold text-amber-400">🛡 Hedge finder</span>
              <span className="text-term-dim">— cap the running loss at</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-2xs text-term-dim">₹</span>
              <input
                type="number"
                value={hedgeMax}
                onChange={(e) => setHedgeMax(Number(e.target.value))}
                className="w-24 rounded border border-term-border bg-term-bg px-2 py-1 text-xs num outline-none focus:border-term-accent"
              />
              <button
                onClick={findHedge}
                disabled={hedgeBusy}
                className="btn flex-1 text-2xs disabled:opacity-40"
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
          </div>
        )}

        <div className="flex flex-col gap-2 border-t border-term-border p-2 lg:mt-auto">
          {fromBroker && orderMode !== "live" && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-2xs text-amber-400">
              ⚠ These are your live positions, but order mode is PAPER — switch to LIVE
              (header) before executing or this hedge won't touch your real position.
            </div>
          )}
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
                placeholder="0"
                className="num w-16 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-term-text outline-none focus:border-down"
              />
            </label>
            <label className="flex items-center gap-1">
              Target
              <input
                value={tgtVal}
                onChange={(e) => setTgtVal(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="0"
                className="num w-16 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-term-text outline-none focus:border-up"
              />
            </label>
            <span className="text-[9px] normal-case text-term-dim/70">
              {slTgtBasis === "points"
                ? "premium points per leg"
                : "₹ split across legs by qty"}
            </span>
          </div>
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

          {/* scheduled run */}
          <div className="rounded border border-term-border bg-term-bg/40 p-2 text-2xs">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-semibold uppercase tracking-wide text-term-dim">
                ⏰ Schedule run
              </span>
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
                className="shrink-0 rounded border border-term-border px-1.5 py-0.5 font-semibold text-term-accent hover:bg-term-accent/15"
              >
                Edit
              </button>
              <button
                onClick={() => {
                  loadSaved(s);
                  setPanel("backtest");
                }}
                className="shrink-0 rounded border border-term-border px-1.5 py-0.5 text-term-dim hover:text-term-text"
              >
                Backtest
              </button>
              <button
                onClick={() => delSaved(s.id)}
                className="shrink-0 rounded border border-term-border px-1.5 py-0.5 text-term-dim hover:border-down hover:text-down"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ---- payoff / backtest ---- */}
      <div className="flex min-h-0 flex-col lg:border-l lg:border-term-border">
        <div className="flex flex-wrap items-center gap-1 border-b border-term-border bg-term-panel2 px-2 py-1.5 text-2xs">
          {(
            [
              ["payoff", "Payoff"],
              ["backtest", "⏱ Backtest"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setPanel(k)}
              className={`rounded border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide shadow-sm transition-colors ${
                panel === k
                  ? "border-term-accent bg-term-accent text-white"
                  : "border-term-border bg-term-bg/40 text-term-dim hover:text-term-text"
              }`}
            >
              {label}
            </button>
          ))}
          <span className="ml-2 hidden text-term-dim lg:inline">
            {panel === "payoff"
              ? "Payoff at expiry, T+0, and any day in between"
              : "Replay these legs against Upstox daily history"}
          </span>
          {panel === "payoff" && (
            <div className="ml-auto flex flex-wrap gap-1">
              {(
                [
                  ["chart", "Chart"],
                  ["table", "P&L table"],
                  ["legs", "Legs P&L"],
                  ["greeks", "Greeks"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setPayoffTab(k)}
                  className={`rounded border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide shadow-sm transition-colors ${
                    payoffTab === k
                      ? "border-term-accent bg-term-accent text-white"
                      : "border-term-border bg-term-bg/40 text-term-dim hover:text-term-text"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

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
        ) : (
          <>
        <div className="border-b border-term-border bg-term-panel">
          {analysis ? (
            <div className="overflow-x-auto">
              <table className="grid-table text-xs">
                <tbody>
                  <tr className="border-b border-term-border/60">
                    <StatCol
                      label="Net Premium"
                      value={`₹${nf(Math.abs(analysis.netPremium), 0)}`}
                      cls={analysis.netPremiumType === "CREDIT" ? "text-up" : "text-down"}
                    />
                    <StatCol
                      label="Total Profit (max)"
                      value={
                        analysis.maxProfitUnbounded
                          ? "Unlimited"
                          : `₹${nf(analysis.maxProfit + manualPnl, 0)}`
                      }
                      cls="text-up"
                    />
                    <StatCol
                      label="Total Loss (max)"
                      value={
                        analysis.maxLossUnbounded
                          ? "Unlimited"
                          : `₹${nf(analysis.maxLoss + manualPnl, 0)}`
                      }
                      cls="text-down"
                    />
                    <StatCol
                      label="Breakeven (% from spot)"
                      value={
                        analysis.breakevens
                          .map(
                            (b) =>
                              `${nf(b, 0)} (${b >= analysis.spot ? "+" : ""}${nf(
                                ((b - analysis.spot) / analysis.spot) * 100,
                                1
                              )}%)`
                          )
                          .join(" · ") || "–"
                      }
                    />
                    <StatCol label="POP" value={analysis.pop != null ? `${nf(analysis.pop, 1)}%` : "–"} />
                    <StatCol label="R : R" value={analysis.rr != null ? `1:${nf(analysis.rr, 2)}` : "–"} />
                    <StatCol label="Margin est." value={`~₹${nf(analysis.margin.estimate, 0)}`} />
                  </tr>
                  <tr>
                    <StatCol
                      label="Δ Delta"
                      value={nf(analysis.greeks.delta, 1)}
                      cls={signColor(analysis.greeks.delta)}
                    />
                    <StatCol label="Γ Gamma" value={nf(analysis.greeks.gamma, 3)} />
                    <StatCol
                      label="Θ Theta / day"
                      value={nf(analysis.greeks.theta, 0)}
                      cls={signColor(analysis.greeks.theta)}
                    />
                    <StatCol
                      label="V Vega"
                      value={nf(analysis.greeks.vega, 0)}
                      cls={signColor(analysis.greeks.vega)}
                    />
                    <StatCol
                      label="Time value"
                      value={posVal ? `₹${nf(posVal.timeValue, 0)}` : "–"}
                      cls={posVal ? signColor(posVal.timeValue) : ""}
                    />
                    <StatCol
                      label="Intrinsic value"
                      value={posVal ? `₹${nf(posVal.intrinsic, 0)}` : "–"}
                      cls={posVal ? signColor(posVal.intrinsic) : ""}
                    />
                    <StatCol label="Legs" value={legs.length} />
                    <StatCol label="Spot" value={nf(analysis.spot, 1)} />
                    <StatCol label="" value={busy ? "updating…" : ""} cls="text-term-dim" />
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-4 py-2 text-xs text-term-dim">
              {err ? <span className="text-down">{err}</span> : "Pick a template or add legs to build a position."}
            </div>
          )}
        </div>

        {analysis && (
          <div className="border-b border-term-border bg-term-panel px-3 py-1.5 text-[10px]">
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
                  <>now · T+0 · {dte}d left</>
                ) : tDays >= dte ? (
                  <>expiry day · 0d left</>
                ) : (
                  <>
                    T+{tDays}d · {tDateLbl} · {dte - tDays}d left
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
                        })} · ${dte - d}d left`
                  }
                  className={`num rounded px-1.5 py-0.5 ${
                    tDays === d
                      ? "bg-amber-500 text-black"
                      : "bg-term-border text-term-dim hover:text-term-text"
                  }`}
                >
                  {d === 0 ? "Now" : d === dte ? "Exp" : `+${d}`}
                </button>
              ))}
            </div>
            {/* target price — drives Legs P&L, Greeks and the T+n column */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-term-border/50 pt-1.5">
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
                className="rounded bg-term-border px-1.5 py-0.5 text-term-dim hover:text-term-text"
              >
                reset
              </button>
              <label className="flex items-center gap-1 text-term-dim">
                Manual P&amp;L ₹
                <input
                  value={manualStr}
                  onChange={(e) => {
                    const s = e.target.value.replace(/[^\d.-]/g, "");
                    setManualStr(s);
                    setManualPnl(parseFloat(s) || 0);
                  }}
                  placeholder="0"
                  title="Booked / adjustment P&L added to every P&L figure and the payoff curves"
                  className="num w-24 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-term-text outline-none focus:border-term-accent"
                />
              </label>
            </div>
          </div>
        )}

        {payoffTab === "chart" ? (
          <div className="relative m-2 min-h-[320px] rounded border border-term-border bg-term-bg/20 p-3 lg:min-h-0 lg:flex-1">
            {analysis && (
              <PayoffChart
                x={analysis.x}
                expiryPnl={analysis.expiryPnl}
                nowPnl={analysis.nowPnl}
                spot={analysis.spot}
                breakevens={analysis.breakevens}
                tPnl={tPnl}
                symbol={analysis.symbol}
                tLabel={tPnl ? `T+${tDays}d` : undefined}
                offset={manualPnl}
              />
            )}
            {analysis && (
              <div className="pointer-events-none absolute bottom-4 right-5 flex gap-3 text-[10px] text-term-dim">
                <span className="text-term-text">─ at expiry</span>
                {tPnl && <span className="text-[#f59e0b]">─ T+{tDays}d ({tDateLbl})</span>}
                <span className="text-[#a855f7]">╌ now (T+0)</span>
                <span className="text-[#3b82f6]">┆ spot</span>
                <span className="text-[#eab308]">● breakeven</span>
              </div>
            )}
          </div>
        ) : payoffTab === "table" ? (
          <div className="m-2 rounded border border-term-border bg-term-bg/20 p-3 lg:min-h-0 lg:flex-1 lg:overflow-auto">
            {analysis && (
              <div className="grid gap-5 lg:grid-cols-2">
                {/* P&L by strike (ATM ± N from the chain ladder) */}
                <div className="rounded border border-term-border p-2">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
                    <span className="text-2xs font-semibold uppercase tracking-wide text-term-dim">
                      P&amp;L by {tableInterval > 0 ? "target" : "strike"} — spot {nf(analysis.spot, 0)}
                    </span>
                    <div className="flex flex-wrap items-center gap-1">
                      <div className="seg text-[10px]">
                        {[10, 20, 30].map((n) => (
                          <button
                            key={n}
                            onClick={() => setStrikeSpan(n)}
                            className={strikeSpan === n ? "on" : ""}
                          >
                            ±{n}
                          </button>
                        ))}
                      </div>
                      <div className="seg text-[10px]">
                        {([["strikes", 0], ["50", 50], ["100", 100], ["200", 200]] as const).map(
                          ([lbl, v]) => (
                            <button
                              key={lbl}
                              onClick={() => setTableInterval(v)}
                              className={tableInterval === v ? "on" : ""}
                              title="row interval"
                            >
                              {lbl}
                            </button>
                          )
                        )}
                      </div>
                      <button
                        onClick={() => setShowPct((v) => !v)}
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          showPct ? "bg-term-accent text-white" : "bg-term-border text-term-dim"
                        }`}
                      >
                        %
                      </button>
                    </div>
                  </div>
                  <table className="block w-full overflow-x-auto whitespace-nowrap border-separate border-spacing-0 border border-term-border text-2xs [&_td:last-child]:border-r-0 [&_td]:border-b [&_td]:border-r [&_td]:border-term-border/60 [&_th:last-child]:border-r-0 [&_th]:border-b [&_th]:border-r [&_th]:border-term-border">
                    <thead className="text-[10px] uppercase text-term-dim">
                      <tr>
                        <th className="border-b border-term-border px-2 py-1 text-right font-medium">
                          {tableInterval > 0 ? "Target" : "Strike"}
                        </th>
                        {showPct && (
                          <th className="border-b border-term-border px-2 py-1 text-right font-medium">
                            Move
                          </th>
                        )}
                        <th className="border-b border-term-border px-2 py-1 text-right font-medium">
                          On expiry
                        </th>
                        {tDays > 0 && (
                          <th className="border-b border-term-border px-2 py-1 text-right font-medium">
                            On {tDateLbl}
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {levelRows.map((r, i) => (
                        <tr key={i} className={r.isATM ? "bg-term-accent/10" : ""}>
                          <td
                            className="num border-b border-term-border/40 px-2 py-1 text-right font-medium text-term-text"
                            style={{
                              boxShadow: r.isWall
                                ? "inset 2px 0 0 #ef4444"
                                : r.isFloor
                                ? "inset 2px 0 0 #22c55e"
                                : undefined,
                            }}
                            title={
                              r.isWall
                                ? "biggest Call OI (resistance)"
                                : r.isFloor
                                ? "biggest Put OI (support)"
                                : undefined
                            }
                          >
                            {sk(r.K)}
                            {r.isWall && <sup className="ml-0.5 text-down">R</sup>}
                            {r.isFloor && <sup className="ml-0.5 text-up">S</sup>}
                          </td>
                          {showPct && (
                            <td
                              className={`num border-b border-term-border/40 px-2 py-1 text-right ${
                                r.pct >= 0 ? "text-up" : "text-down"
                              }`}
                            >
                              {r.pct >= 0 ? "+" : ""}
                              {nf(r.pct * 100, 1)}%
                            </td>
                          )}
                          <td
                            className={`num border-b border-term-border/40 px-2 py-1 text-right ${pnlCls(
                              r.exp + manualPnl
                            )}`}
                          >
                            {pnlTxt(r.exp + manualPnl)}
                          </td>
                          {tDays > 0 && (
                            <td
                              className={`num border-b border-term-border/40 px-2 py-1 text-right ${pnlCls(
                                (r.tv ?? 0) + manualPnl
                              )}`}
                            >
                              {pnlTxt(mp(r.tv))}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Day-by-day P&L (theta decay) */}
                <div className="rounded border border-term-border p-2">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
                    <span className="text-2xs font-semibold uppercase tracking-wide text-term-dim">
                      Day-by-day P&amp;L — spot &amp; ±{dayPct}%
                    </span>
                    <div className="seg text-[10px]">
                      {[0.5, 1, 1.5, 2, 2.5, 3].map((p) => (
                        <button
                          key={p}
                          onClick={() => setDayPct(p)}
                          className={dayPct === p ? "on" : ""}
                        >
                          {p}%
                        </button>
                      ))}
                    </div>
                  </div>
                  <table className="block w-full overflow-x-auto whitespace-nowrap border-separate border-spacing-0 border border-term-border text-2xs [&_td:last-child]:border-r-0 [&_td]:border-b [&_td]:border-r [&_td]:border-term-border/60 [&_th:last-child]:border-r-0 [&_th]:border-b [&_th]:border-r [&_th]:border-term-border">
                    <thead className="text-[10px] uppercase text-term-dim">
                      <tr>
                        <th className="border-b border-term-border px-2 py-1 text-left font-medium">
                          Day
                        </th>
                        <th className="border-b border-term-border px-2 py-1 text-right font-medium">
                          Left
                        </th>
                        <th className="border-b border-term-border px-2 py-1 text-right font-medium text-down">
                          −{dayPct}%
                          <span className="block font-normal opacity-70">
                            {sk(analysis.spot * (1 - dayPct / 100))}
                          </span>
                        </th>
                        <th className="border-b border-term-border px-2 py-1 text-right font-medium">
                          Spot
                          <span className="block font-normal opacity-70">{sk(analysis.spot)}</span>
                        </th>
                        <th className="border-b border-term-border px-2 py-1 text-right font-medium text-up">
                          +{dayPct}%
                          <span className="block font-normal opacity-70">
                            {sk(analysis.spot * (1 + dayPct / 100))}
                          </span>
                        </th>
                        <th className="border-b border-term-border px-2 py-1 text-right font-medium">
                          Δ vs today
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {dayRows.map((r, i) => {
                        const decay = r.sp - (dayRows[0]?.sp ?? r.sp);
                        return (
                          <tr
                            key={i}
                            className={
                              r.d === tDays
                                ? "bg-amber-500/10"
                                : r.d === 0
                                ? "bg-term-accent/10"
                                : ""
                            }
                          >
                            <td className="num border-b border-term-border/40 px-2 py-1 text-term-dim">
                              {r.d === 0 ? "Today" : `T+${r.d}d`}{" "}
                              <span className="opacity-60">{r.date}</span>
                            </td>
                            <td className="num border-b border-term-border/40 px-2 py-1 text-right text-term-dim">
                              {r.left}d
                            </td>
                            <td
                              className={`num border-b border-term-border/40 px-2 py-1 text-right ${pnlCls(
                                r.dn + manualPnl
                              )}`}
                            >
                              {pnlTxt(r.dn + manualPnl)}
                            </td>
                            <td
                              className={`num border-b border-term-border/40 px-2 py-1 text-right ${pnlCls(
                                r.sp + manualPnl
                              )}`}
                            >
                              {pnlTxt(r.sp + manualPnl)}
                            </td>
                            <td
                              className={`num border-b border-term-border/40 px-2 py-1 text-right ${pnlCls(
                                r.up + manualPnl
                              )}`}
                            >
                              {pnlTxt(r.up + manualPnl)}
                            </td>
                            <td
                              className={`num border-b border-term-border/40 px-2 py-1 text-right ${
                                i === 0 ? "text-term-dim" : pnlCls(decay)
                              }`}
                            >
                              {i === 0 ? "—" : `${decay >= 0 ? "+" : ""}${nf(decay, 0)}`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : payoffTab === "legs" ? (
          legsEl
        ) : (
          greeksEl
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
            ? "P&L by underlying move and day-by-day (theta decay). T+n column follows the slider. Black-Scholes with per-leg IV — indicative."
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
