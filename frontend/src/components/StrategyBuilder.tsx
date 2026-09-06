import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, signColor, sk } from "../lib/format";
import type { Analysis, OptionType, SavedStrategy, StrategyLeg } from "../types";
import { PayoffChart } from "./PayoffChart";
import { BacktestPanel } from "./BacktestPanel";

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
    (ls: StrategyLeg[]) => ls.map((l) => ({ ...l, lots: Math.max(1, l.lots * mult) })),
    [mult]
  );

  // "book at profit": paper only — execute, then attach an amount target to each
  // freshly-created position so check_stops() auto-squares it off at profit.
  const [bookProfit, setBookProfit] = useState("");
  const [showBacktest, setShowBacktest] = useState(false);
  // customise "+ Add leg": pick type / strike / side / lots for the next leg
  const [newLegOT, setNewLegOT] = useState<OptionType>("CE");
  const [newLegSide, setNewLegSide] = useState<"BUY" | "SELL">("BUY");
  const [newLegLots, setNewLegLots] = useState(1);
  const [newLegStrike, setNewLegStrike] = useState(0); // 0 => ATM
  const [addingLeg, setAddingLeg] = useState(false); // collapse the add-leg form
  const doExecute = useCallback(async () => {
    const ls = scaled(legs);
    const tgt = parseFloat(bookProfit);
    const exp = expiry ?? chain?.expiry;
    if (orderMode === "live" || !(tgt > 0) || !exp || ls.length === 0) {
      requestStrategyExecute(ls);
      return;
    }
    const before = new Set((useStore.getState().paper?.positions ?? []).map((p) => p.id));
    const r = await api.executeStrategy({ symbol, expiry: exp, legs: ls, mode: "paper" });
    useStore.setState({ paper: r.paper });
    const fresh = (r.paper.positions ?? []).filter((p) => !before.has(p.id));
    const totalQty = fresh.reduce((s, p) => s + Math.abs(p.qty), 0) || 1;
    for (const p of fresh) {
      await api.setStop({
        position_id: p.id,
        mode: "amount",
        value: 0,
        trailValue: 0,
        targetValue: (tgt * Math.abs(p.qty)) / totalQty,
      });
    }
    useStore.setState({ paper: await api.paper() });
  }, [scaled, legs, bookProfit, expiry, chain?.expiry, orderMode, symbol, requestStrategyExecute]);

  const strikes = useMemo(
    () => (chain ? chain.rows.map((r) => r.strike) : []),
    [chain]
  );
  const atm = chain?.atmStrike ?? 0;

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
        lots: newLegLots,
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
        selectSymbol(d.symbol, true);
        selectExpiry(d.expiry);
        setLegs(d.legs);
        setAnalysis(d.analysis);
        setErr(null);
      },
      (e) => setErr(String(e.message || e))
    );

  const loadFromBroker = () =>
    api.strategyFromBroker().then(
      (d) => {
        setFromBroker(true);
        selectSymbol(d.symbol, true);
        selectExpiry(d.expiry);
        setLegs(d.legs);
        setAnalysis(d.analysis);
        setErr(null);
      },
      (e) => setErr(String(e.message || e))
    );

  const doSave = () => {
    if (!saveName.trim() || !legs.length || !expiry) return;
    api
      .saveStrategy({ name: saveName.trim(), symbol, expiry, legs })
      .then((d) => {
        setSaved(d.strategies);
        setSaveName("");
      });
  };

  const loadSaved = (s: SavedStrategy) => update(s.legs.map((l) => ({ ...l })));
  const delSaved = (id: string) =>
    api.deleteStrategy(id).then((d) => setSaved(d.strategies));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[330px_minmax(0,1fr)] md:overflow-hidden">
      {/* ---- leg editor ---- */}
      <div className="flex flex-col border-r border-term-border bg-term-panel2 md:min-h-0 md:overflow-y-auto">
        <div className="flex items-center gap-2 border-b border-term-border px-3 py-2 text-2xs font-semibold uppercase tracking-wide text-term-dim">
          <span>Builder</span>
          <select
            value={symbol}
            onChange={(e) => selectSymbol(e.target.value, true)}
            className="rounded border border-term-border bg-term-bg px-1 py-0.5 text-2xs font-semibold normal-case text-term-text outline-none focus:border-term-accent"
            title="Underlying for this strategy"
          >
            {symOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {expiries.length > 0 && (
            <select
              value={expiry ?? ""}
              onChange={(e) => selectExpiry(e.target.value)}
              className="num ml-auto rounded border border-term-border bg-term-bg px-1 py-0.5 text-2xs font-normal normal-case text-term-text outline-none focus:border-term-accent"
            >
              {expiries.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex flex-col gap-2 border-b border-term-border p-2">
          <select
            onChange={(e) => {
              loadTemplate(e.target.value);
              e.currentTarget.selectedIndex = 0;
            }}
            className="rounded border border-term-border bg-term-bg px-2 py-1 text-xs outline-none focus:border-term-accent"
          >
            <option value="">Load a template…</option>
            {Object.keys(templates).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
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
              className="btn text-2xs text-up hover:text-up"
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
            <div key={i} className="border-b border-term-border/50 p-2 text-2xs">
              <div className="flex items-center gap-1">
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
                  <select
                    value={leg.strike}
                    onChange={(e) => setLeg(i, { strike: Number(e.target.value) })}
                    className="num flex-1 rounded border border-term-border bg-term-bg px-1 py-1"
                  >
                    {(strikes.includes(leg.strike) ? strikes : [leg.strike, ...strikes]).map((k) => (
                      <option key={k} value={k}>
                        {sk(k)}
                        {k === atm ? "  (ATM)" : ""}
                      </option>
                    ))}
                  </select>
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
                    <select
                      value={newLegStrike || atm}
                      onChange={(e) => setNewLegStrike(Number(e.target.value))}
                      className="num rounded border border-term-border bg-term-bg px-2 py-1"
                    >
                      {strikes.map((k) => (
                        <option key={k} value={k}>
                          {sk(k)}
                          {k === atm ? "  (ATM)" : ""}
                        </option>
                      ))}
                    </select>
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
                    value={newLegLots}
                    onChange={(e) => setNewLegLots(Math.max(1, Number(e.target.value) || 1))}
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

        <div className="flex flex-col gap-2 border-t border-term-border p-2 md:mt-auto">
          {fromBroker && orderMode !== "live" && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-2xs text-amber-400">
              ⚠ These are your live positions, but order mode is PAPER — switch to LIVE
              (header) before executing or this hedge won't touch your real position.
            </div>
          )}
          <label
            className="flex items-center gap-1.5 text-2xs text-term-dim"
            title="Paper only: auto-square-off the basket once open P&L reaches this profit"
          >
            <span className="uppercase tracking-wide">Book at profit ₹</span>
            <input
              value={bookProfit}
              onChange={(e) => setBookProfit(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="0 = off"
              className="num w-20 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-term-text outline-none focus:border-term-accent"
            />
          </label>
          <button
            disabled={legs.length === 0}
            onClick={doExecute}
            className={`btn py-2 font-semibold disabled:opacity-40 ${
              orderMode === "live" ? "btn-sell" : "btn-buy"
            }`}
          >
            {orderMode === "live" ? "Execute LIVE" : "Execute (paper)"} · {legs.length} leg
            {legs.length === 1 ? "" : "s"}
            {mult > 1 && <span className="ml-1 text-2xs">(×{mult})</span>}
            {orderMode !== "live" && parseFloat(bookProfit) > 0 && (
              <span className="ml-1 text-2xs text-up">· book +₹{parseFloat(bookProfit)}</span>
            )}
          </button>
          <button
            onClick={() => setShowBacktest((v) => !v)}
            disabled={legs.length === 0 || !expiry}
            className="btn text-2xs disabled:opacity-40"
            title="Replay these legs against Upstox daily history"
          >
            {showBacktest ? "Hide backtest" : "⏱ Backtest"}
          </button>
          {showBacktest && expiry && (
            <BacktestPanel
              symbol={symbol}
              expiry={expiry}
              legs={scaled(legs)}
              onClose={() => setShowBacktest(false)}
            />
          )}
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
            <div key={s.id} className="flex items-center justify-between text-2xs">
              <button className="truncate text-left text-term-accent hover:underline" onClick={() => loadSaved(s)}>
                {s.name} <span className="text-term-dim">· {s.symbol}</span>
              </button>
              <button className="text-term-dim hover:text-down" onClick={() => delSaved(s.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ---- payoff + metrics ---- */}
      <div className="flex min-h-0 flex-col">
        <div className="border-b border-term-border bg-term-panel">
          {analysis ? (
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0 text-xs">
                <tbody>
                  <tr className="border-b border-term-border/60">
                    <StatCol
                      label="Net Premium"
                      value={`₹${nf(Math.abs(analysis.netPremium), 0)}`}
                      cls={analysis.netPremiumType === "CREDIT" ? "text-up" : "text-down"}
                    />
                    <StatCol
                      label="Total Profit (max)"
                      value={analysis.maxProfitUnbounded ? "Unlimited" : `₹${nf(analysis.maxProfit, 0)}`}
                      cls="text-up"
                    />
                    <StatCol
                      label="Total Loss (max)"
                      value={analysis.maxLossUnbounded ? "Unlimited" : `₹${nf(analysis.maxLoss, 0)}`}
                      cls="text-down"
                    />
                    <StatCol
                      label="Breakeven"
                      value={analysis.breakevens.map((b) => nf(b, 0)).join(" / ") || "–"}
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

        <div className="relative min-h-[280px] flex-1 p-3 md:min-h-0">
          {analysis && (
            <PayoffChart
              x={analysis.x}
              expiryPnl={analysis.expiryPnl}
              nowPnl={analysis.nowPnl}
              spot={analysis.spot}
              breakevens={analysis.breakevens}
            />
          )}
          {analysis && (
            <div className="pointer-events-none absolute bottom-4 right-5 flex gap-3 text-[10px] text-term-dim">
              <span className="text-term-text">─ at expiry</span>
              <span className="text-[#a855f7]">╌ now (T+0)</span>
              <span className="text-[#3b82f6]">┆ spot</span>
              <span className="text-[#eab308]">● breakeven</span>
            </div>
          )}
        </div>

        <div className="border-t border-term-border px-4 py-1 text-[10px] text-term-dim">
          {analysis?.margin.basis
            ? `Margin basis: ${analysis.margin.basis}. Payoff/POP use ATM IV and the current chain — indicative, not broker-accurate.`
            : "Payoff at expiry (solid) vs current theoretical value (dashed)."}
        </div>
      </div>
    </div>
  );
}
