import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import type { AutoCondition, AutoRule } from "../types";
import { RuleBacktest } from "./RuleBacktest";

/* ------------------------------------------------------------------ */
/* condition catalogue                                                 */
/* ------------------------------------------------------------------ */
type Field =
  | { key: string; label: string; type: "num"; def: number }
  | { key: string; label: string; type: "sel"; def: string; opts: string[] };

type CondGroup = "indicator" | "oi" | "smart";

const COND_DEFS: Record<string, { label: string; group: CondGroup; fields: Field[] }> = {
  rsi: {
    label: "RSI",
    group: "indicator",
    fields: [
      { key: "period", label: "period", type: "num", def: 14 },
      { key: "op", label: "op", type: "sel", def: "<", opts: ["<", ">", "cross_up", "cross_down"] },
      { key: "value", label: "level", type: "num", def: 30 },
    ],
  },
  ema_cross: {
    label: "EMA cross",
    group: "indicator",
    fields: [
      { key: "fast", label: "fast", type: "num", def: 9 },
      { key: "slow", label: "slow", type: "num", def: 21 },
      { key: "dir", label: "dir", type: "sel", def: "up", opts: ["up", "down"] },
    ],
  },
  price_vs_ema: {
    label: "Price vs EMA",
    group: "indicator",
    fields: [
      { key: "period", label: "period", type: "num", def: 20 },
      {
        key: "op",
        label: "op",
        type: "sel",
        def: "above",
        opts: ["above", "below", "cross_up", "cross_down"],
      },
    ],
  },
  macd: {
    label: "MACD",
    group: "indicator",
    fields: [
      { key: "fast", label: "fast", type: "num", def: 12 },
      { key: "slow", label: "slow", type: "num", def: 26 },
      { key: "signal", label: "signal", type: "num", def: 9 },
      {
        key: "op",
        label: "op",
        type: "sel",
        def: "cross_up",
        opts: ["cross_up", "cross_down", "hist_up", "hist_down"],
      },
    ],
  },
  spot_move_pct: {
    label: "Spot move % (from day open)",
    group: "indicator",
    fields: [
      { key: "op", label: "op", type: "sel", def: ">", opts: [">", "<"] },
      { key: "value", label: "%", type: "num", def: 0.5 },
    ],
  },
  pcr: {
    label: "PCR",
    group: "oi",
    fields: [
      { key: "op", label: "op", type: "sel", def: ">", opts: ["<", ">", "cross_up", "cross_down"] },
      { key: "value", label: "level", type: "num", def: 0.9 },
    ],
  },
  oi_change: {
    label: "OI change",
    group: "oi",
    fields: [
      { key: "leg", label: "leg", type: "sel", def: "call", opts: ["call", "put"] },
      { key: "action", label: "action", type: "sel", def: "build", opts: ["build", "unwind"] },
      { key: "minOi", label: "min ΔOI", type: "num", def: 0 },
    ],
  },
  spot_vs_maxpain: {
    label: "Spot vs Max Pain",
    group: "oi",
    fields: [
      { key: "op", label: "op", type: "sel", def: "above", opts: ["above", "below"] },
      { key: "bufferPct", label: "buffer %", type: "num", def: 0 },
    ],
  },
  net_gex: {
    label: "Net GEX",
    group: "oi",
    fields: [
      {
        key: "op",
        label: "op",
        type: "sel",
        def: "pos",
        opts: ["pos", "neg", "cross_up", "cross_down"],
      },
    ],
  },

  /* ---- smart-money / market-structure ---- */
  bos: {
    label: "Break of structure (swing high/low)",
    group: "smart",
    fields: [
      { key: "lookback", label: "bars", type: "num", def: 20 },
      { key: "dir", label: "dir", type: "sel", def: "up", opts: ["up", "down"] },
    ],
  },
  opening_range: {
    label: "Opening-range break",
    group: "smart",
    fields: [
      { key: "rangeMin", label: "range min", type: "num", def: 15 },
      { key: "dir", label: "dir", type: "sel", def: "up", opts: ["up", "down"] },
    ],
  },
  oi_velocity: {
    label: "OI surge (velocity vs baseline)",
    group: "smart",
    fields: [
      { key: "leg", label: "leg", type: "sel", def: "call", opts: ["call", "put"] },
      { key: "action", label: "action", type: "sel", def: "build", opts: ["build", "unwind"] },
      { key: "bars", label: "bars", type: "num", def: 3 },
      { key: "mult", label: "× median", type: "num", def: 2 },
    ],
  },
  vol_surge: {
    label: "Volume surge",
    group: "smart",
    fields: [
      { key: "leg", label: "leg", type: "sel", def: "call", opts: ["call", "put"] },
      { key: "bars", label: "bars", type: "num", def: 3 },
      { key: "mult", label: "× median", type: "num", def: 2 },
    ],
  },
  oi_divergence: {
    label: "Price / OI divergence",
    group: "smart",
    fields: [
      {
        key: "dir",
        label: "type",
        type: "sel",
        def: "bearish",
        opts: ["bearish", "bullish"],
      },
      { key: "lookback", label: "bars", type: "num", def: 10 },
    ],
  },
  maxpain_shift: {
    label: "Max-pain migration",
    group: "smart",
    fields: [
      { key: "dir", label: "dir", type: "sel", def: "up", opts: ["up", "down"] },
      { key: "bars", label: "bars", type: "num", def: 10 },
      { key: "minPts", label: "min pts", type: "num", def: 0 },
    ],
  },
  pcr_roc: {
    label: "PCR rate-of-change",
    group: "smart",
    fields: [
      { key: "op", label: "op", type: "sel", def: ">", opts: [">", "<"] },
      { key: "bars", label: "bars", type: "num", def: 5 },
      { key: "value", label: "Δ", type: "num", def: 0.1 },
    ],
  },
  iv_skew: {
    label: "IV skew (put vs call)",
    group: "smart",
    fields: [
      {
        key: "op",
        label: "op",
        type: "sel",
        def: "put_rich",
        opts: ["put_rich", "call_rich", "put_rising", "call_rising"],
      },
      { key: "value", label: "min gap", type: "num", def: 0 },
    ],
  },
  gamma_flip: {
    label: "Gamma flip (spot vs zero-γ)",
    group: "smart",
    fields: [
      {
        key: "op",
        label: "op",
        type: "sel",
        def: "below",
        opts: ["above", "below", "cross_up", "cross_down"],
      },
    ],
  },
};

const GROUP_LABEL: Record<CondGroup, string> = {
  indicator: "Indicator",
  oi: "OI / chain",
  smart: "Smart money / structure",
};

const INSTRUMENTS = [
  "ATM_CE",
  "ATM_PE",
  "ITM1_CE",
  "ITM1_PE",
  "ITM2_CE",
  "ITM2_PE",
  "OTM1_CE",
  "OTM1_PE",
  "OTM2_CE",
  "OTM2_PE",
];

function mkCond(kind: string): AutoCondition {
  const d: AutoCondition = { kind };
  for (const f of COND_DEFS[kind].fields) d[f.key] = f.def;
  return d;
}

function blankRule(symbol: string): Partial<AutoRule> {
  return {
    name: "New rule",
    enabled: false,
    symbol,
    expiry: null,
    instrument: "ATM_CE",
    side: "BUY",
    lots: 1,
    product: "NRML",
    mode: "paper",
    entry: [mkCond("rsi")],
    exit: [],
    entryLogic: "all",
    exitLogic: "any",
    slPct: 30,
    targetPct: 60,
    trailPct: 0,
    trailArmPct: 0,
    beArmPct: 0,
    maxTradesPerDay: 3,
    cooldownMin: 5,
    squareOff: "15:20",
    noEntryAfter: "",
  };
}

const fmtTime = (t: number) => new Date(t * 1000).toLocaleTimeString();

/* ------------------------------------------------------------------ */
/* condition editor                                                    */
/* ------------------------------------------------------------------ */
function CondRow({
  cond,
  onChange,
  onRemove,
}: {
  cond: AutoCondition;
  onChange: (c: AutoCondition) => void;
  onRemove: () => void;
}) {
  const def = COND_DEFS[cond.kind];
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded border border-term-border bg-term-bg px-2 py-1.5">
      <select
        value={cond.kind}
        onChange={(e) => onChange(mkCond(e.target.value))}
        className="rounded border border-term-border bg-term-panel px-1 py-0.5 text-2xs"
      >
        {(["indicator", "oi", "smart"] as CondGroup[]).map((g) => (
          <optgroup key={g} label={GROUP_LABEL[g]}>
            {Object.entries(COND_DEFS)
              .filter(([, v]) => v.group === g)
              .map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>

      {def?.fields.map((f) => (
        <label key={f.key} className="flex items-center gap-1 text-[10px] text-term-dim">
          {f.label}
          {f.type === "num" ? (
            <input
              type="number"
              step="any"
              value={Number(cond[f.key] ?? f.def)}
              onChange={(e) => onChange({ ...cond, [f.key]: parseFloat(e.target.value) })}
              className="num w-16 rounded border border-term-border bg-term-panel px-1 py-0.5 text-2xs text-term-text"
            />
          ) : (
            <select
              value={String(cond[f.key] ?? f.def)}
              onChange={(e) => onChange({ ...cond, [f.key]: e.target.value })}
              className="rounded border border-term-border bg-term-panel px-1 py-0.5 text-2xs text-term-text"
            >
              {f.opts.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          )}
        </label>
      ))}

      <button onClick={onRemove} className="ml-auto text-term-dim hover:text-down" title="remove">
        ✕
      </button>
    </div>
  );
}

function CondList({
  title,
  hint,
  list,
  onChange,
  logic = "all",
  onLogic,
}: {
  title: string;
  hint: string;
  list: AutoCondition[];
  onChange: (l: AutoCondition[]) => void;
  logic?: "all" | "any";
  onLogic?: (l: "all" | "any") => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-term-dim">
          {title}
          {onLogic && list.length > 1 && (
            <span className="seg text-[10px]">
              <button onClick={() => onLogic("all")} className={logic === "all" ? "on" : ""}>
                AND
              </button>
              <button onClick={() => onLogic("any")} className={logic === "any" ? "on" : ""}>
                OR
              </button>
            </span>
          )}
          <span className="normal-case text-[10px] text-term-dim/70">
            · {logic === "any" ? "any one true" : "all true"} {hint}
          </span>
        </span>
        <button
          className="btn px-1.5 py-0.5 text-2xs"
          onClick={() => onChange([...list, mkCond("rsi")])}
        >
          + condition
        </button>
      </div>
      {list.length === 0 && (
        <div className="rounded border border-dashed border-term-border px-2 py-1.5 text-[10px] text-term-dim">
          none
        </div>
      )}
      {list.map((c, i) => (
        <CondRow
          key={i}
          cond={c}
          onChange={(nc) => onChange(list.map((x, j) => (j === i ? nc : x)))}
          onRemove={() => onChange(list.filter((_, j) => j !== i))}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* rule editor                                                         */
/* ------------------------------------------------------------------ */
function RuleEditor({
  seed,
  symbols,
  onSave,
  onCancel,
}: {
  seed: Partial<AutoRule>;
  symbols: string[];
  onSave: (r: Partial<AutoRule>) => void;
  onCancel: () => void;
}) {
  const [r, setR] = useState<Partial<AutoRule>>(seed);
  const set = (patch: Partial<AutoRule>) => setR((prev) => ({ ...prev, ...patch }));
  const num = (v: string) => (v === "" ? undefined : parseFloat(v));

  return (
    <div className="space-y-3 rounded-lg border border-term-accent/50 bg-term-panel p-3">
      <label className="flex flex-col text-[10px] text-term-dim">
        name
        <input
          value={r.name ?? ""}
          onChange={(e) => set({ name: e.target.value })}
          className="w-48 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
        />
      </label>

      {/* entry / exit conditions — kept above the instrument config */}
      <div className="space-y-3 rounded border border-term-border/60 bg-term-bg/40 p-2">
        <CondList
          title="Entry"
          hint="to open"
          list={r.entry ?? []}
          onChange={(l) => set({ entry: l })}
          logic={r.entryLogic ?? "all"}
          onLogic={(l) => set({ entryLogic: l })}
        />
        <CondList
          title="Exit"
          hint="(SL / target / square-off always apply)"
          list={r.exit ?? []}
          onChange={(l) => set({ exit: l })}
          logic={r.exitLogic ?? "any"}
          onLogic={(l) => set({ exitLogic: l })}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-[10px] text-term-dim">
          symbol
          <select
            value={r.symbol}
            onChange={(e) => set({ symbol: e.target.value })}
            className="w-32 rounded border border-term-border bg-term-bg px-1 py-1 text-xs text-term-text"
          >
            {symbols.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-[10px] text-term-dim">
          instrument
          <select
            value={r.instrument}
            onChange={(e) => set({ instrument: e.target.value })}
            className="w-28 rounded border border-term-border bg-term-bg px-1 py-1 text-xs text-term-text"
          >
            {INSTRUMENTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-[10px] text-term-dim">
          side
          <select
            value={r.side}
            onChange={(e) => set({ side: e.target.value as "BUY" | "SELL" })}
            className="w-20 rounded border border-term-border bg-term-bg px-1 py-1 text-xs text-term-text"
          >
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
        </label>
        <label className="flex flex-col text-[10px] text-term-dim">
          lots
          <input
            type="number"
            min={1}
            value={r.lots ?? 1}
            onChange={(e) => set({ lots: Math.max(1, parseInt(e.target.value) || 1) })}
            className="num w-16 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
          />
        </label>
        <label className="flex flex-col text-[10px] text-term-dim">
          product
          <select
            value={r.product}
            onChange={(e) => set({ product: e.target.value as "NRML" | "MIS" })}
            className="w-20 rounded border border-term-border bg-term-bg px-1 py-1 text-xs text-term-text"
          >
            <option value="NRML">NRML</option>
            <option value="MIS">MIS</option>
          </select>
        </label>
        <label className="flex flex-col text-[10px] text-term-dim">
          mode
          <select
            value={r.mode}
            onChange={(e) => set({ mode: e.target.value as "paper" | "live" })}
            className={`w-20 rounded border px-1 py-1 text-xs ${
              r.mode === "live"
                ? "border-down text-down"
                : "border-term-border text-term-text"
            } bg-term-bg`}
          >
            <option value="paper">paper</option>
            <option value="live">live</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-[10px] text-term-dim">
          SL % (premium)
          <input
            type="number"
            step="any"
            value={r.slPct ?? ""}
            onChange={(e) => set({ slPct: num(e.target.value) })}
            className="num w-20 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
          />
        </label>
        <label className="flex flex-col text-[10px] text-term-dim">
          target %
          <input
            type="number"
            step="any"
            value={r.targetPct ?? ""}
            onChange={(e) => set({ targetPct: num(e.target.value) })}
            className="num w-20 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
          />
        </label>
        <label className="flex flex-col text-[10px] text-term-dim" title="0 = off. Trails the stop this % behind the best favourable premium.">
          trail %
          <input
            type="number"
            step="any"
            value={r.trailPct ?? ""}
            onChange={(e) => set({ trailPct: num(e.target.value) })}
            className="num w-20 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
          />
        </label>
        <label className="flex flex-col text-[10px] text-term-dim" title="Arm the trailing stop only after the trade is this % in profit.">
          trail arm %
          <input
            type="number"
            step="any"
            value={r.trailArmPct ?? ""}
            onChange={(e) => set({ trailArmPct: num(e.target.value) })}
            className="num w-20 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
          />
        </label>
        <label className="flex flex-col text-[10px] text-term-dim" title="Move the stop to breakeven once the trade is this % in profit. 0 = off.">
          breakeven arm %
          <input
            type="number"
            step="any"
            value={r.beArmPct ?? ""}
            onChange={(e) => set({ beArmPct: num(e.target.value) })}
            className="num w-24 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
          />
        </label>
        <label className="flex flex-col text-[10px] text-term-dim">
          max trades/day
          <input
            type="number"
            min={1}
            value={r.maxTradesPerDay ?? 3}
            onChange={(e) => set({ maxTradesPerDay: Math.max(1, parseInt(e.target.value) || 1) })}
            className="num w-16 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
          />
        </label>
        <label className="flex flex-col text-[10px] text-term-dim">
          cooldown min
          <input
            type="number"
            min={0}
            value={r.cooldownMin ?? 5}
            onChange={(e) => set({ cooldownMin: Math.max(0, parseInt(e.target.value) || 0) })}
            className="num w-16 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
          />
        </label>
        <label className="flex flex-col text-[10px] text-term-dim">
          square-off
          <input
            value={r.squareOff ?? "15:20"}
            onChange={(e) => set({ squareOff: e.target.value })}
            placeholder="15:20"
            className="num w-20 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
          />
        </label>
        <label className="flex flex-col text-[10px] text-term-dim">
          no entry after
          <input
            value={r.noEntryAfter ?? ""}
            onChange={(e) => set({ noEntryAfter: e.target.value })}
            placeholder="15:00"
            className="num w-20 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <button className="btn btn-buy" onClick={() => onSave(r)}>
          Save rule
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        {r.mode === "live" && (
          <span className="text-2xs text-down">
            live orders fire only when the global order mode is LIVE and Flattrade is connected
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* main view                                                           */
/* ------------------------------------------------------------------ */
export function AutoBotView() {
  const bot = useStore((s) => s.autobot);
  const load = useStore((s) => s.loadAutobot);
  const setMaster = useStore((s) => s.autobotMaster);
  const setMaxLoss = useStore((s) => s.autobotMaxLoss);
  const saveRule = useStore((s) => s.autobotSaveRule);
  const enableRule = useStore((s) => s.autobotEnableRule);
  const deleteRule = useStore((s) => s.autobotDeleteRule);
  const kill = useStore((s) => s.autobotKill);
  const storeSymbol = useStore((s) => s.symbol);
  const symClass = useStore((s) => s.symClass);
  const symClassOk = useStore((s) => s.symClassOk);

  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const symbols = useMemo(
    () => (symClass === "all" ? allSymbols : allSymbols.filter((s) => symClassOk(s))),
    [allSymbols, symClass, symClassOk]
  );
  const [editing, setEditing] = useState<Partial<AutoRule> | null>(null);
  const [btId, setBtId] = useState<string | null>(null);
  const [lossDraft, setLossDraft] = useState("");
  const [tab, setTab] = useState<"rules" | "backtest">("rules");

  useEffect(() => {
    load();
    api
      .symbols()
      .then((d) => {
        const merged = Array.from(
          new Set([...(d.indices || []), ...(d.defaults || []), ...(d.fo || [])])
        ).sort();
        setAllSymbols(merged.length ? merged : [storeSymbol]);
      })
      .catch(() => setAllSymbols([storeSymbol]));
  }, [load, storeSymbol]);

  useEffect(() => {
    if (bot) setLossDraft(String(bot.maxLossPerDay || ""));
  }, [bot?.maxLossPerDay]);

  const rules = bot?.rules ?? [];
  const anyLive = useMemo(() => rules.some((r) => r.mode === "live" && r.enabled), [rules]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* control bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-term-border bg-term-panel2 px-3 py-2">
        <button
          onClick={() => setMaster(!bot?.master)}
          className={`rounded px-3 py-1 text-xs font-semibold ${
            bot?.master ? "bg-up text-white" : "border border-term-border bg-term-panel text-term-dim"
          }`}
        >
          {bot?.master ? "● ENGINE ON" : "○ engine off"}
        </button>
        <span
          className={`text-2xs ${bot?.marketOpen ? "text-up" : "text-term-dim"}`}
          title="rules only trade during market hours"
        >
          {bot?.marketOpen ? "market open" : "market closed"}
        </span>
        <div className="flex flex-col leading-tight">
          <span className="text-[10px] uppercase tracking-wide text-term-dim">Bot P&L today</span>
          <span
            className={`num text-sm ${
              (bot?.dailyPnl ?? 0) >= 0 ? "text-up" : "text-down"
            }`}
          >
            ₹{Math.round(bot?.dailyPnl ?? 0).toLocaleString("en-IN")}
          </span>
        </div>
        <label className="flex items-center gap-1 text-[10px] text-term-dim">
          daily loss cap ₹
          <input
            value={lossDraft}
            onChange={(e) => setLossDraft(e.target.value)}
            onBlur={() => setMaxLoss(parseFloat(lossDraft) || 0)}
            placeholder="0 = off"
            className="num w-24 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs text-term-text"
          />
        </label>

        <div className="ml-auto flex items-center gap-2">
          <button
            className="btn"
            onClick={() => setEditing(blankRule(storeSymbol))}
            disabled={!!editing}
          >
            + New rule
          </button>
          <button
            className="btn btn-sell font-semibold"
            onClick={() => {
              if (window.confirm("KILL: turn the engine off and square off every open auto position?"))
                kill();
            }}
          >
            KILL
          </button>
        </div>
      </div>

      {anyLive && bot?.master && (
        <div className="border-b border-down/40 bg-down/10 px-3 py-1 text-2xs text-down">
          ⚠ one or more enabled rules are in LIVE mode — real orders will be placed when conditions
          trigger during market hours.
        </div>
      )}

      {/* tabs */}
      <div className="flex items-center gap-1 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs">
        {(
          [
            ["rules", "Rules"],
            ["backtest", "⏱ Backtest"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded px-2.5 py-1 font-semibold ${
              tab === k ? "bg-term-accent text-white" : "text-term-dim hover:bg-term-border"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-2 text-term-dim">
          {tab === "backtest"
            ? "Replay a rule's indicator / OI conditions against Upstox daily history"
            : `${rules.length} rule${rules.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {tab === "backtest" && <AutoBacktestTab rules={rules} />}

      {tab === "rules" && (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 md:flex-row md:overflow-hidden">
        {/* rules + editor */}
        <div className="min-h-0 flex-1 space-y-3 md:overflow-auto md:pr-1">
          {editing && (
            <RuleEditor
              seed={editing}
              symbols={symbols}
              onSave={async (r) => {
                await saveRule(r);
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          )}

          {rules.length === 0 && !editing && (
            <div className="rounded-lg border border-dashed border-term-border p-6 text-center text-xs text-term-dim">
              No rules yet. Click <span className="text-term-text">+ New rule</span> to build an
              indicator- or OI-based auto trade.
            </div>
          )}

          {rules.map((r) => {
            const open = r._state?.open;
            return (
              <div
                key={r.id}
                className="rounded-lg border border-term-border bg-term-panel p-2.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => enableRule(r.id, !r.enabled)}
                    className={`h-4 w-8 shrink-0 rounded-full transition-colors ${
                      r.enabled ? "bg-up" : "bg-term-border"
                    } relative`}
                    title={r.enabled ? "enabled" : "disabled"}
                  >
                    <span
                      className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                        r.enabled ? "left-4" : "left-0.5"
                      }`}
                    />
                  </button>
                  <span className="text-sm font-semibold text-term-text">{r.name}</span>
                  <span className="rounded bg-term-bg px-1.5 py-0.5 text-2xs text-term-dim">
                    {r.symbol} · {r.instrument} · {r.side} ×{r.lots}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-2xs ${
                      r.mode === "live"
                        ? "bg-down/20 text-down"
                        : "bg-term-bg text-term-dim"
                    }`}
                  >
                    {r.mode}
                  </span>
                  {open && (
                    <span className="rounded bg-up/15 px-1.5 py-0.5 text-2xs text-up">
                      IN TRADE {open.side} {open.strike}
                      {open.ot} @{open.entryPx.toFixed(1)}
                      {open.peak != null && ` · peak ${open.peak.toFixed(1)}`}
                      {open.stopPx != null && (
                        <span className="text-amber-400"> · stop {open.stopPx.toFixed(1)}</span>
                      )}
                    </span>
                  )}
                  <span className="text-2xs text-term-dim">
                    {r._state?.tradesToday ?? 0}/{r.maxTradesPerDay} today
                  </span>

                  <div className="ml-auto flex items-center gap-1">
                    <button
                      className={`btn px-1.5 py-0.5 text-2xs ${btId === r.id ? "btn-buy" : ""}`}
                      onClick={() => setBtId(btId === r.id ? null : r.id)}
                      title="Backtest this rule on Upstox daily history"
                    >
                      ⏱ backtest
                    </button>
                    <button
                      className="btn px-1.5 py-0.5 text-2xs"
                      onClick={() => setEditing(r)}
                      disabled={!!editing}
                    >
                      edit
                    </button>
                    <button
                      className="btn px-1.5 py-0.5 text-2xs hover:text-down"
                      onClick={() => window.confirm(`Delete rule "${r.name}"?`) && deleteRule(r.id)}
                    >
                      delete
                    </button>
                  </div>
                </div>

                {btId === r.id && <RuleBacktest rule={r} onClose={() => setBtId(null)} />}

                <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                  <div>
                    <span className="uppercase tracking-wide text-term-dim">entry (all)</span>
                    <ul className="mt-0.5 space-y-0.5">
                      {(r.entry ?? []).map((c, i) => (
                        <li key={i} className="text-term-text">
                          • {describe(c)}
                        </li>
                      ))}
                      {(r.entry ?? []).length === 0 && <li className="text-term-dim">—</li>}
                    </ul>
                  </div>
                  <div>
                    <span className="uppercase tracking-wide text-term-dim">
                      exit (any) · SL {r.slPct ?? "–"}% · tgt {r.targetPct ?? "–"}%
                      {r.trailPct ? ` · trail ${r.trailPct}%${r.trailArmPct ? `@+${r.trailArmPct}%` : ""}` : ""}
                      {r.beArmPct ? ` · BE@+${r.beArmPct}%` : ""} · sq {r.squareOff}
                    </span>
                    <ul className="mt-0.5 space-y-0.5">
                      {(r.exit ?? []).map((c, i) => (
                        <li key={i} className="text-term-text">
                          • {describe(c)}
                        </li>
                      ))}
                      {(r.exit ?? []).length === 0 && (
                        <li className="text-term-dim">SL / target / square-off only</li>
                      )}
                    </ul>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* activity log */}
        <div className="flex max-h-56 w-full shrink-0 flex-col overflow-hidden rounded-lg border border-term-border bg-term-panel md:max-h-none md:w-72">
          <div className="border-b border-term-border px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-term-dim">
            Activity
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
            {(bot?.log ?? []).length === 0 && (
              <div className="text-[10px] text-term-dim">no signals yet</div>
            )}
            {(bot?.log ?? []).map((e, i) => (
              <div key={i} className="text-[10px] leading-tight">
                <span className="num text-term-dim">{fmtTime(e.ts)} </span>
                <span
                  className={
                    e.level === "entry"
                      ? "text-up"
                      : e.level === "exit"
                      ? "text-amber-400"
                      : e.level === "error"
                      ? "text-down"
                      : "text-term-dim"
                  }
                >
                  [{e.level}]
                </span>{" "}
                <span className="text-term-text">{e.ruleName}</span>: {e.msg}
              </div>
            ))}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* backtest tab                                                        */
/* ------------------------------------------------------------------ */
function AutoBacktestTab({ rules }: { rules: AutoRule[] }) {
  const [id, setId] = useState<string>(rules[0]?.id ?? "");
  const rule = rules.find((r) => r.id === id) ?? rules[0];

  if (rules.length === 0)
    return (
      <div className="p-6 text-center text-xs text-term-dim">
        Create a rule in the Rules tab first, then come back to backtest it.
      </div>
    );

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-2xs">
        <span className="uppercase tracking-wide text-term-dim">Rule</span>
        <select
          value={id || rule?.id}
          onChange={(e) => setId(e.target.value)}
          className="rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-text"
        >
          {rules.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} · {r.symbol} · {r.instrument} {r.side}
            </option>
          ))}
        </select>
        <span className="text-term-dim">
          entry {(rule?.entry ?? []).length} · exit {(rule?.exit ?? []).length} · SL{" "}
          {rule?.slPct ?? "–"}% · tgt {rule?.targetPct ?? "–"}%
        </span>
      </div>
      {rule && <RuleBacktest key={rule.id} rule={rule} onClose={() => {}} />}
    </div>
  );
}

function describe(c: AutoCondition): string {
  const g = (k: string) => c[k];
  switch (c.kind) {
    case "rsi":
      return `RSI(${g("period")}) ${g("op")} ${g("value")}`;
    case "ema_cross":
      return `EMA ${g("fast")}/${g("slow")} cross ${g("dir")}`;
    case "price_vs_ema":
      return `price ${g("op")} EMA(${g("period")})`;
    case "macd":
      return `MACD(${g("fast")},${g("slow")},${g("signal")}) ${g("op")}`;
    case "spot_move_pct":
      return `spot move ${g("op")} ${g("value")}%`;
    case "pcr":
      return `PCR ${g("op")} ${g("value")}`;
    case "oi_change":
      return `${g("leg")} OI ${g("action")}${Number(g("minOi")) ? ` ≥${g("minOi")}` : ""}`;
    case "spot_vs_maxpain":
      return `spot ${g("op")} maxpain${Number(g("bufferPct")) ? ` ±${g("bufferPct")}%` : ""}`;
    case "net_gex":
      return `net GEX ${g("op")}`;
    case "bos":
      return `break of structure ${g("dir")} (${g("lookback")} bars)`;
    case "opening_range":
      return `opening range ${g("rangeMin")}m break ${g("dir")}`;
    case "oi_velocity":
      return `${g("leg")} OI ${g("action")} surge ≥${g("mult")}× (${g("bars")} bars)`;
    case "vol_surge":
      return `${g("leg")} volume surge ≥${g("mult")}× (${g("bars")} bars)`;
    case "oi_divergence":
      return `${g("dir")} price/OI divergence (${g("lookback")} bars)`;
    case "maxpain_shift":
      return `max-pain migrating ${g("dir")}${Number(g("minPts")) ? ` ≥${g("minPts")}pts` : ""} (${g("bars")} bars)`;
    case "pcr_roc":
      return `PCR Δ ${g("op")} ${g("value")} over ${g("bars")} bars`;
    case "iv_skew":
      return `IV skew ${g("op")}${Number(g("value")) ? ` ${g("value")}` : ""}`;
    case "gamma_flip":
      return `spot ${g("op")} gamma-flip`;
    default:
      return c.kind;
  }
}
