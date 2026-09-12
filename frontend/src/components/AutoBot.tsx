import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf } from "../lib/format";
import type { AutoCondition, AutoRule } from "../types";
import { RuleBacktest } from "./RuleBacktest";
import { SelectMenu } from "./SelectMenu";

/* ------------------------------------------------------------------ */
/* condition catalogue                                                 */
/* ------------------------------------------------------------------ */
type Field =
  | { key: string; label: string; type: "num"; def: number; hint?: string }
  | { key: string; label: string; type: "sel"; def: string; opts: string[]; hint?: string };

type CondGroup = "indicator" | "oi" | "smart" | "trend" | "greeks";

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

  oi_state: {
    label: "OI state (buildup / unwinding)",
    group: "oi",
    fields: [
      {
        key: "state",
        label: "state",
        type: "sel",
        def: "LONG_BUILDUP",
        opts: ["LONG_BUILDUP", "SHORT_BUILDUP", "LONG_UNWINDING", "SHORT_COVERING"],
      },
      { key: "bars", label: "bars", type: "num", def: 5 },
    ],
  },
  supertrend: {
    label: "Supertrend (ATR)",
    group: "trend",
    fields: [
      { key: "period", label: "period", type: "num", def: 10 },
      { key: "mult", label: "mult", type: "num", def: 3 },
      { key: "dir", label: "dir", type: "sel", def: "up", opts: ["up", "down"] },
      { key: "op", label: "when", type: "sel", def: "is", opts: ["is", "flip"] },
    ],
  },
  candle: {
    label: "Candlestick pattern",
    group: "trend",
    fields: [
      {
        key: "pattern",
        label: "pattern",
        type: "sel",
        def: "bull_engulf",
        opts: [
          "bull_engulf",
          "bear_engulf",
          "hammer",
          "shooting_star",
          "doji",
          "inside",
          "outside",
          "marubozu_bull",
          "marubozu_bear",
        ],
      },
    ],
  },
  atr: {
    label: "ATR (volatility)",
    group: "trend",
    fields: [
      { key: "period", label: "period", type: "num", def: 14 },
      {
        key: "op",
        label: "op",
        type: "sel",
        def: ">",
        opts: [">", "<", "rising", "falling"],
      },
      { key: "value", label: "value", type: "num", def: 20 },
      { key: "unit", label: "unit", type: "sel", def: "pts", opts: ["pts", "pct"] },
    ],
  },
  prev_candle: {
    label: "Candle breakout (current/previous)",
    group: "trend",
    fields: [
      {
        key: "lookback",
        label: "candles back",
        type: "num",
        def: 1,
        hint:
          "0 = the current, still-forming candle. 1 = the previous (closed) candle. " +
          ">1 = a rolling window of that many closed candles.",
      },
      {
        key: "field",
        label: "field",
        type: "sel",
        def: "high",
        opts: ["open", "high", "low", "close"],
        hint:
          "0 candles back: open/high/low are that candle's own (running) values -- " +
          "close is just the current price, so it's not a useful choice at 0. " +
          "For >1 candles back: high/low = the window's highest-high / lowest-low; " +
          "open/close = the oldest candle's open / the most recent closed candle's close.",
      },
      {
        key: "op",
        label: "op",
        type: "sel",
        def: "cross_up",
        opts: [">", "<", "cross_up", "cross_down"],
        hint: "Compares the current spot price against that reference.",
      },
    ],
  },
  gap: {
    label: "Candle compare (O/H/L/C)",
    group: "trend",
    fields: [
      {
        key: "aCandle",
        label: "candle",
        type: "sel",
        def: "current",
        opts: ["current", "previous"],
        hint:
          "current = this rule's still-forming candle so far. previous = the last " +
          "CLOSED candle. Relative to this rule's own candle timeframe above, not " +
          "necessarily the calendar day -- pick a long timeframe for a daily-style check.",
      },
      { key: "aField", label: "field", type: "sel", def: "open", opts: ["open", "high", "low", "close"] },
      {
        key: "op",
        label: "op",
        type: "sel",
        def: ">",
        opts: [">", "<"],
        hint:
          "Both sides are fixed once the current candle opens -- no live-spot " +
          "crossing here, just a static compare (so no cross_up/cross_down).",
      },
      { key: "bCandle", label: "vs candle", type: "sel", def: "previous", opts: ["current", "previous"] },
      { key: "bField", label: "vs field", type: "sel", def: "close", opts: ["open", "high", "low", "close"] },
    ],
  },
  pivot: {
    label: "Pivot point (prev-day)",
    group: "trend",
    fields: [
      {
        key: "level",
        label: "level",
        type: "sel",
        def: "P",
        opts: ["P", "R1", "S1", "R2", "S2", "R3", "S3"],
      },
      {
        key: "op",
        label: "op",
        type: "sel",
        def: "above",
        opts: ["above", "below", "cross_up", "cross_down"],
      },
    ],
  },
  delta_change: {
    label: "Δ delta (ATM leg)",
    group: "greeks",
    fields: [
      { key: "leg", label: "leg", type: "sel", def: "call", opts: ["call", "put"] },
      { key: "bars", label: "bars", type: "num", def: 5 },
      { key: "op", label: "op", type: "sel", def: ">", opts: [">", "<", "abs"] },
      { key: "value", label: "value", type: "num", def: 0.05 },
    ],
  },
  gamma_change: {
    label: "Δ gamma (ATM leg)",
    group: "greeks",
    fields: [
      { key: "leg", label: "leg", type: "sel", def: "call", opts: ["call", "put"] },
      { key: "bars", label: "bars", type: "num", def: 5 },
      { key: "op", label: "op", type: "sel", def: ">", opts: [">", "<", "abs"] },
      { key: "value", label: "value", type: "num", def: 0.0005 },
    ],
  },
};

const GROUP_LABEL: Record<CondGroup, string> = {
  indicator: "Indicator",
  oi: "OI / chain",
  smart: "Smart money / structure",
  trend: "Trend / price action (Supertrend, Pivots, Candles, ATR)",
  greeks: "Greeks (Δ delta / gamma)",
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
    holdType: "intraday",
    entry: [mkCond("rsi")],
    exit: [],
    entryTf: 300,
    entryBars: 60,
    entryLogic: "all",
    exitLogic: "any",
    slBasis: "pct",
    slPct: 30,
    targetPct: 60,
    trailPct: 0,
    trailArmPct: 0,
    beArmPct: 0,
    maxTradesPerDay: 3,
    cooldownMin: 5,
    squareOff: "15:20",
    noEntryAfter: "",
    noEntryBefore: "",
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
        {(["indicator", "oi", "smart", "trend", "greeks"] as CondGroup[]).map((g) => (
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
        <label
          key={f.key}
          title={f.hint}
          className="flex items-center gap-1 text-[10px] text-term-dim"
        >
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
            <SelectMenu
              value={String(cond[f.key] ?? f.def)}
              options={f.opts.map((o: string) => [o, o] as [string, string])}
              onChange={(o) => onChange({ ...cond, [f.key]: o })}
              title={f.label}
              width={120}
            />
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

type EF = NonNullable<AutoRule["entryFilter"]>;

function EntryFilterEditor({
  ef,
  onChange,
}: {
  ef: EF;
  onChange: (ef: EF) => void;
}) {
  const set = (patch: Partial<EF>) => onChange({ ...ef, ...patch });
  const numOr = (v: string) => (v === "" ? undefined : parseFloat(v));
  const Num = ({ k, label }: { k: keyof EF; label: string }) => (
    <label className="flex flex-col text-[9px] text-term-dim">
      {label}
      <input
        type="number"
        step="any"
        value={(ef[k] as number | undefined) ?? ""}
        onChange={(e) => set({ [k]: numOr(e.target.value) } as Partial<EF>)}
        className="num w-16 rounded border border-term-border bg-term-panel px-1 py-0.5 text-2xs text-term-text"
      />
    </label>
  );
  return (
    <div className="space-y-1.5 rounded border border-term-border/60 bg-term-panel/40 p-2">
      <div className="text-2xs font-semibold uppercase tracking-wide text-term-dim">
        Entry premium / delta filter{" "}
        <span className="normal-case text-[10px] text-term-dim/70">
          · gates the resolved option before entry (optional)
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <label className="flex flex-col text-[9px] text-term-dim">
          premium
          <SelectMenu
            value={ef.premOp ?? ""}
            options={
              [
                ["off", ""],
                ["greater than", "gt"],
                ["less than", "lt"],
                ["near", "near"],
              ] as const
            }
            onChange={(v) => set({ premOp: (v || undefined) as EF["premOp"] })}
            title="Premium filter"
            width={130}
          />
        </label>
        {ef.premOp && <Num k="premVal" label="₹ value" />}
        {ef.premOp === "near" && <Num k="premTol" label="± tol" />}
        <span className="mx-1 h-6 w-px bg-term-border" />
        <Num k="premPctMin" label="prem% ≥" />
        <Num k="premPctMax" label="prem% ≤" />
        <Num k="premPtsMin" label="premΔ ≥" />
        <Num k="premPtsMax" label="premΔ ≤" />
        <span className="mx-1 h-6 w-px bg-term-border" />
        <Num k="deltaMin" label="|Δ| ≥" />
        <Num k="deltaMax" label="|Δ| ≤" />
      </div>
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
        {/* candle timeframe the indicator / pattern / ATR conditions run on */}
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-term-dim">
          <span className="font-semibold uppercase tracking-wide">Entry candles</span>
          <div className="seg">
            {(
              [
                ["tick", 0],
                ["1m", 60],
                ["3m", 180],
                ["5m", 300],
                ["15m", 900],
                ["30m", 1800],
                ["1h", 3600],
              ] as const
            ).map(([lbl, v]) => (
              <button
                key={v}
                type="button"
                onClick={() => set({ entryTf: v })}
                className={(r.entryTf ?? 0) === v ? "on" : ""}
              >
                {lbl}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1" title="How many candles of history to keep for indicator warm-up">
            bars
            <input
              type="number"
              min={10}
              value={r.entryBars ?? 60}
              onChange={(e) => set({ entryBars: Math.max(10, parseInt(e.target.value) || 60) })}
              className="num w-14 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
            />
          </label>
          <span className="text-[9px] normal-case text-term-dim/70">
            RSI / EMA / MACD / Supertrend / Candles / Prev-candle / ATR evaluate on this timeframe
          </span>
        </div>
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

        {/* premium / delta entry filter — gates the resolved option */}
        <EntryFilterEditor
          ef={r.entryFilter ?? {}}
          onChange={(ef) => set({ entryFilter: ef })}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-[10px] text-term-dim">
          symbol
          <SelectMenu
            value={r.symbol}
            options={symbols.map((s) => [s, s] as [string, string])}
            onChange={(v) => set({ symbol: v })}
            title="Symbol"
            width={130}
          />
        </label>
        <label className="flex flex-col text-[10px] text-term-dim">
          instrument
          <SelectMenu
            value={r.instrument}
            options={INSTRUMENTS.map((s) => [s, s] as [string, string])}
            onChange={(v) => set({ instrument: v })}
            title="Instrument"
            width={120}
          />
        </label>
        <label className="flex flex-col text-[10px] text-term-dim">
          side
          <SelectMenu
            value={r.side}
            options={[["BUY", "BUY"], ["SELL", "SELL"]] as const}
            onChange={(v) => set({ side: v as "BUY" | "SELL" })}
            title="Side"
            width={90}
          />
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
          <SelectMenu
            value={r.product}
            options={[["NRML", "NRML"], ["MIS", "MIS"]] as const}
            onChange={(v) => set({ product: v as "NRML" | "MIS" })}
            title="Product"
            width={90}
          />
        </label>
        <label
          className="flex flex-col text-[10px] text-term-dim"
          title="Intraday = force-exit at square-off time / market close, same as always. Positional = ignore square-off and market close, hold across day boundaries until SL/target/an exit condition fires (or KILL)."
        >
          hold
          <SelectMenu
            value={r.holdType ?? "intraday"}
            options={[["Intraday", "intraday"], ["Positional", "positional"]] as const}
            onChange={(v) => set({ holdType: v as "intraday" | "positional" })}
            title="Hold type"
            width={100}
          />
        </label>
        <label className="flex flex-col text-[10px] text-term-dim">
          mode
          <SelectMenu
            value={r.mode}
            options={[["paper", "paper"], ["live", "live"]] as const}
            onChange={(v) => set({ mode: v as "paper" | "live" })}
            title="Order mode"
            width={90}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col text-[10px] text-term-dim">
          SL / target / trail unit
          <div className="seg mt-0.5">
            {(
              [
                ["pct", "%"],
                ["pts", "Pts"],
                ["rs", "₹"],
              ] as const
            ).map(([v, lbl]) => (
              <button
                key={v}
                type="button"
                onClick={() => set({ slBasis: v })}
                className={(r.slBasis ?? "pct") === v ? "on" : ""}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>
        {(() => {
          const u = r.slBasis === "pts" ? "pts" : r.slBasis === "rs" ? "₹" : "%";
          const fields: [keyof AutoRule, string, string][] = [
            ["slPct", `SL ${u}`, "stop-loss on the option premium (against you)"],
            ["targetPct", `target ${u}`, "take-profit on the option premium (in your favour)"],
            ["trailPct", `trail ${u}`, "0 = off. Trails the stop this far behind the best favourable premium."],
            ["trailArmPct", `trail arm ${u}`, "arm the trailing stop only after the trade is this far in profit"],
            ["beArmPct", `breakeven arm ${u}`, "move the stop to breakeven once the trade is this far in profit. 0 = off."],
          ];
          return fields.map(([k, label, title]) => (
            <label key={k} className="flex flex-col text-[10px] text-term-dim" title={title}>
              {label}
              <input
                type="number"
                step="any"
                value={(r[k] as number | undefined) ?? ""}
                onChange={(e) => set({ [k]: num(e.target.value) } as Partial<AutoRule>)}
                className="num w-24 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
              />
            </label>
          ));
        })()}
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
        <label
          className="flex flex-col text-[10px] text-term-dim"
          title={r.holdType === "positional" ? "Ignored while hold=Positional." : undefined}
        >
          square-off
          <input
            value={r.squareOff ?? "15:20"}
            onChange={(e) => set({ squareOff: e.target.value })}
            placeholder="15:20"
            disabled={r.holdType === "positional"}
            className="num w-20 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text disabled:opacity-40"
          />
        </label>
        <label className="flex flex-col text-[10px] text-term-dim" title="Earliest clock time an entry may fire (IST). Blank = from market open.">
          entry after
          <input
            value={r.noEntryBefore ?? ""}
            onChange={(e) => set({ noEntryBefore: e.target.value })}
            placeholder="09:20"
            className="num w-20 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
          />
        </label>
        <label className="flex flex-col text-[10px] text-term-dim" title="Latest clock time an entry may fire (IST).">
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
        <label className="ml-auto flex items-center gap-1 text-[10px] text-term-dim">
          daily loss cap ₹
          <input
            value={lossDraft}
            onChange={(e) => setLossDraft(e.target.value)}
            onBlur={() => setMaxLoss(parseFloat(lossDraft) || 0)}
            placeholder="0 = off"
            className="num w-24 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs text-term-text"
          />
        </label>
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

        <div className="ml-auto flex items-center gap-2">
          <button
            className="rounded bg-up px-3 py-1 text-xs font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_1px_3px_rgba(0,0,0,0.45)] hover:brightness-110 disabled:opacity-40"
            onClick={() => {
              setTab("rules");
              setEditing(blankRule(storeSymbol));
            }}
            disabled={!!editing}
          >
            + New rule
          </button>
          <button
            className="rounded bg-down px-3 py-1 text-xs font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_1px_3px_rgba(0,0,0,0.45)] hover:brightness-110"
            onClick={() => {
              if (window.confirm("KILL: turn the engine off and square off every open auto position?"))
                kill();
            }}
          >
            KILL
          </button>
        </div>
      </div>

      {tab === "backtest" && (
        <AutoBacktestTab rules={rules} onDone={() => setTab("rules")} />
      )}

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
            // the live prev_candle readout reflects whichever condition list
            // the engine just evaluated: exit while in a trade, entry while flat
            const entryLiveIdx = !open
              ? (r.entry ?? []).findIndex((c) => c.kind === "prev_candle")
              : -1;
            const exitLiveIdx = open
              ? (r.exit ?? []).findIndex((c) => c.kind === "prev_candle")
              : -1;
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
                      ⏱ Backtest
                    </button>
                    <button
                      className="btn px-1.5 py-0.5 text-2xs"
                      onClick={() => setEditing(r)}
                      disabled={!!editing}
                    >
                      Edit
                    </button>
                    <button
                      className="btn px-1.5 py-0.5 text-2xs hover:text-down"
                      onClick={() => window.confirm(`Delete rule "${r.name}"?`) && deleteRule(r.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {btId === r.id && <RuleBacktest rule={r} onClose={() => setBtId(null)} />}

                <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                  <div>
                    <span className="uppercase tracking-wide text-term-dim">
                      entry ({r.entryLogic === "any" ? "any" : "all"}) ·{" "}
                      {r.entryTf
                        ? r.entryTf < 3600
                          ? `${r.entryTf / 60}m`
                          : `${r.entryTf / 3600}h`
                        : "tick"}{" "}
                      candles
                    </span>
                    <ul className="mt-0.5 space-y-0.5">
                      {(r.entry ?? []).map((c, i) => (
                        <li key={i} className="text-term-text">
                          • {describe(c)}
                          {i === entryLiveIdx && r._live && (
                            <span className="ml-1 text-term-accent">{fmtLive(r._live)}</span>
                          )}
                        </li>
                      ))}
                      {(r.entry ?? []).length === 0 && <li className="text-term-dim">—</li>}
                    </ul>
                  </div>
                  <div>
                    {(() => {
                      const u = r.slBasis === "pts" ? "pts" : r.slBasis === "rs" ? "₹" : "%";
                      return (
                        <span className="uppercase tracking-wide text-term-dim">
                          exit (any) · SL {r.slPct ?? "–"}
                          {u} · tgt {r.targetPct ?? "–"}
                          {u}
                          {r.trailPct
                            ? ` · trail ${r.trailPct}${u}${
                                r.trailArmPct ? `@+${r.trailArmPct}${u}` : ""
                              }`
                            : ""}
                          {r.beArmPct ? ` · BE@+${r.beArmPct}${u}` : ""}{" "}
                          · {r.holdType === "positional" ? "positional" : `sq ${r.squareOff}`}
                          {r.noEntryBefore ? ` · from ${r.noEntryBefore}` : ""}
                        </span>
                      );
                    })()}
                    <ul className="mt-0.5 space-y-0.5">
                      {(r.exit ?? []).map((c, i) => (
                        <li key={i} className="text-term-text">
                          • {describe(c)}
                          {i === exitLiveIdx && r._live && (
                            <span className="ml-1 text-term-accent">{fmtLive(r._live)}</span>
                          )}
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
function AutoBacktestTab({
  rules,
  onDone,
}: {
  rules: AutoRule[];
  onDone: () => void;
}) {
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
        <SelectMenu
          value={id || rule?.id || ""}
          options={rules.map(
            (r) => [`${r.name} · ${r.symbol} · ${r.instrument} ${r.side}`, r.id] as [string, string]
          )}
          onChange={setId}
          title="Rule"
          width={220}
        />
        <span className="text-term-dim">
          entry {(rule?.entry ?? []).length} · exit {(rule?.exit ?? []).length} · SL{" "}
          {rule?.slPct ?? "–"}% · tgt {rule?.targetPct ?? "–"}%
        </span>
        <button
          onClick={onDone}
          className="ml-auto rounded border border-term-border px-2 py-1 text-2xs text-term-dim hover:border-term-accent hover:text-term-text"
        >
          ✕ Close · back to Rules
        </button>
      </div>
      {rule && <RuleBacktest key={rule.id} rule={rule} onClose={onDone} />}
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
    case "oi_state":
      return `${String(g("state")).replace(/_/g, " ").toLowerCase()} (${g("bars")} bars)`;
    case "supertrend":
      return `Supertrend(${g("period")},${g("mult")}) ${g("op") === "flip" ? "flips" : "is"} ${g("dir")}`;
    case "pivot":
      return `spot ${g("op")} pivot ${g("level")}`;
    case "delta_change":
      return `Δdelta ${g("leg")} ${g("op")} ${g("value")} over ${g("bars")} bars`;
    case "gamma_change":
      return `Δgamma ${g("leg")} ${g("op")} ${g("value")} over ${g("bars")} bars`;
    case "prev_candle": {
      const raw = g("lookback");
      const n = Number.isFinite(Number(raw)) ? Number(raw) : 1;
      const which = n === 0 ? "current" : n > 1 ? `prev ${n}-candle` : "prev";
      return `spot ${g("op")} ${which} ${g("field")}`;
    }
    case "gap": {
      const aC = String(g("aCandle") || "current");
      const aF = String(g("aField") || "open");
      const bC = String(g("bCandle") || "previous");
      const bF = String(g("bField") || "close");
      return `${aC} ${aF} ${g("op")} ${bC} ${bF}`;
    }
    default:
      return c.kind;
  }
}

/** "Prev high 24,530 (5m) · spot 24,545 (+15.0)" -- the live prev_candle
 *  readout shown next to its condition on the rule card. */
function fmtLive(live: NonNullable<AutoRule["_live"]>): string {
  const tf = live.tf
    ? live.tf < 3600
      ? `${live.tf / 60}m`
      : `${live.tf / 3600}h`
    : "tick";
  const which =
    live.lookback === 0 ? "current" : live.lookback > 1 ? `prev ${live.lookback}-candle` : "prev";
  const diff = live.spot - live.ref;
  return `— ${which} ${live.field} ${nf(live.ref, 2)} (${tf}) · spot ${nf(live.spot, 2)} (${
    diff >= 0 ? "+" : ""
  }${nf(diff, 1)})`;
}
