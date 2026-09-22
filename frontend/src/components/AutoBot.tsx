import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import {
  MAX_GROUPS,
  addCond,
  addGroup,
  grpOf,
  members,
  moveCond,
  readout,
  removeCond,
  removeGroup,
  setCond,
  setGroupLogic,
  type CondListState,
  type Logic,
} from "../lib/condGroups";
import { nf, signColor } from "../lib/format";
import { playOrderSound } from "../lib/soundNotif";
import type { AutoCondition, AutoRule, AutoStats, AutoStructureDef, StructurePreview } from "../types";
import { FigureBoard, TONE_TEXT, money, tone, tradeTicks } from "./Figures";
import { LineChart } from "./LineChart";
import { RuleBacktest } from "./RuleBacktest";
import { SelectMenu } from "./SelectMenu";

/* ------------------------------------------------------------------ */
/* condition catalogue                                                 */
/* ------------------------------------------------------------------ */
type FieldBase = {
  key: string;
  label: string;
  hint?: string;
  /** hide the field unless the condition's other values call for it (e.g. no "to" time when op = after) */
  show?: (c: AutoCondition) => boolean;
  /** a label that follows the condition's values */
  labelFor?: (c: AutoCondition) => string;
};
type Field =
  | (FieldBase & { type: "num"; def: number })
  | (FieldBase & { type: "sel"; def: string; opts: string[] })
  | (FieldBase & { type: "time"; def: string })
  | (FieldBase & { type: "days"; def: number[] });

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const DAY_ALL = [...DAY_NAMES, "Sat", "Sun"];

/** [0,1,2,3,4] -> "Mon–Fri", [0,2,4] -> "Mon, Wed, Fri", [0,1,2,4] -> "Mon–Wed, Fri" */
function dayLabel(days: number[]): string {
  const d = [...new Set(days)].filter((x) => x >= 0 && x < DAY_ALL.length).sort((a, b) => a - b);
  if (!d.length) return "none picked";
  const parts: string[] = [];
  for (let i = 0; i < d.length; ) {
    let j = i;
    while (j + 1 < d.length && d[j + 1] === d[j] + 1) j++;
    parts.push(j - i >= 2 ? `${DAY_ALL[d[i]]}–${DAY_ALL[d[j]]}` : d.slice(i, j + 1).map((x) => DAY_ALL[x]).join(", "));
    i = j + 1;
  }
  return parts.join(", ");
}

type CondGroup = "indicator" | "oi" | "smart" | "trend" | "greeks" | "time" | "trade";

/** `help` is a visible one-liner shown under the condition -- tooltips don't exist on a phone. */
/** what a trade_stoploss / trade_target amount reads as: "30%", "15 points", "₹1000" */
const tradeAmt = (c: AutoCondition) => {
  const u = String(c.unit || "%");
  return u === "%" ? `${c.value}%` : u === "pts" ? `${c.value} points` : `₹${c.value}`;
};
const TRADE_HELP =
  " It looks at the trade's own result, not the market. On OR it is simply another way out; on AND it must hold together with the other conditions.";
const TRADE_UNIT_HINT = "% = of the price you entered at · pts = points of the option's own price (₹ per share) · ₹ = rupees on the whole position";

const COND_DEFS: Record<
  string,
  { label: string; group: CondGroup; fields: Field[]; help?: (c: AutoCondition) => string; exitOnly?: boolean }
> = {
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
  blast_score: {
    label: "Gamma Blast score",
    group: "smart",
    fields: [
      { key: "op", label: "op", type: "sel", def: ">", opts: ["<", ">", "cross_up", "cross_down"] },
      { key: "value", label: "score", type: "num", def: 60 },
    ],
  },
  iv_rank: {
    label: "IV rank",
    group: "smart",
    fields: [
      { key: "op", label: "op", type: "sel", def: ">", opts: ["<", ">", "cross_up", "cross_down"] },
      { key: "value", label: "rank", type: "num", def: 70 },
    ],
    help: () =>
      "Session-only rank (0-100) of current ATM IV against today's own range -- same figure as the Screener's IV Rank column / \"High IV\" preset. Needs the symbol to be in the background scanner's universe (watchlist + defaults + FO majors); an obscure symbol may never get a value.",
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
      { key: "bars", label: "readings", type: "num", def: 5, hint: "How many refreshes back to compare with (one reading per refresh, not a candle)" },
      { key: "op", label: "op", type: "sel", def: ">", opts: [">", "<", "abs"] },
      { key: "value", label: "value", type: "num", def: 0.05 },
    ],
    help: () =>
      "Delta now minus delta N readings ago (a reading is one refresh, not a candle). “>” = it rose by more than the value, “<” = it fell by more than the value, “abs” = it moved that much either way.",
  },
  gamma_change: {
    label: "Δ gamma (ATM leg)",
    group: "greeks",
    fields: [
      { key: "leg", label: "leg", type: "sel", def: "call", opts: ["call", "put"] },
      { key: "bars", label: "readings", type: "num", def: 5, hint: "How many refreshes back to compare with (one reading per refresh, not a candle)" },
      { key: "op", label: "op", type: "sel", def: ">", opts: [">", "<", "abs"] },
      { key: "value", label: "value", type: "num", def: 0.0005 },
    ],
    help: () =>
      "Gamma now minus gamma N readings ago (a reading is one refresh, not a candle). Gamma numbers are small, about 0.001, so the value is small too.",
  },
  gamma_vs_delta: {
    label: "Gamma vs delta (ATM leg)",
    group: "greeks",
    fields: [
      { key: "leg", label: "leg", type: "sel", def: "call", opts: ["call", "put"] },
      { key: "bars", label: "readings", type: "num", def: 5, hint: "How many refreshes back to compare with (one reading per refresh, not a candle)" },
      { key: "op", label: "op", type: "sel", def: "gamma_faster", opts: ["gamma_faster", "delta_faster"] },
      { key: "value", label: "by at least (% pts)", type: "num", def: 5, hint: "How many percentage points ahead the faster one must be" },
    ],
    help: (c) =>
      c.op === "delta_faster"
        ? "Delta's % growth beats gamma's by at least this many points over the last N readings. Percentages, because gamma is about 100× smaller than delta. A put's delta counts by size."
        : "Gamma's % growth beats delta's by at least this many points over the last N readings. Percentages, because gamma is about 100× smaller than delta. A put's delta counts by size.",
  },
  theta_level: {
    label: "Theta level (ATM leg)",
    group: "greeks",
    fields: [
      { key: "leg", label: "leg", type: "sel", def: "call", opts: ["call", "put"] },
      { key: "op", label: "op", type: "sel", def: "<", opts: ["<", ">", "cross_up", "cross_down"] },
      { key: "value", label: "θ/day", type: "num", def: -10 },
    ],
  },
  vega_level: {
    label: "Vega level (ATM leg)",
    group: "greeks",
    fields: [
      { key: "leg", label: "leg", type: "sel", def: "call", opts: ["call", "put"] },
      { key: "op", label: "op", type: "sel", def: ">", opts: ["<", ">", "cross_up", "cross_down"] },
      { key: "value", label: "vega", type: "num", def: 5 },
    ],
  },
  time_of_day: {
    label: "Time of day",
    group: "time",
    fields: [
      {
        key: "op",
        label: "op",
        type: "sel",
        def: "between",
        opts: ["between", "outside", "after", "before"],
        hint: "between = inside the window · outside = anywhere except the window · after = from that time on · before = up to that time",
      },
      { key: "from", label: "from", type: "time", def: "09:15", hint: "IST, inclusive", show: (c) => c.op !== "before", labelFor: (c) => (c.op === "after" ? "time" : "from") },
      { key: "to", label: "to", type: "time", def: "15:30", hint: "IST, inclusive", show: (c) => c.op !== "after", labelFor: (c) => (c.op === "before" ? "time" : "to") },
    ],
    help: (c) => {
      const f = String(c.from || "09:15");
      const t = String(c.to || "15:30");
      const op = String(c.op || "between");
      return op === "after"
        ? `True from ${f} (IST) onwards, that minute included.`
        : op === "before"
        ? `True until ${t} (IST), that minute included.`
        : op === "outside"
        ? `True at any time except from ${f} to ${t} (IST). Use it to skip a stretch of the day.`
        : `True from ${f} to ${t} (IST), both ends included.`;
    },
  },
  day_of_week: {
    label: "Day of week",
    group: "time",
    fields: [
      { key: "op", label: "op", type: "sel", def: "is", opts: ["is", "is_not"] },
      { key: "days", label: "days", type: "days", def: [0, 1, 2, 3, 4] },
    ],
    help: (c) => {
      const days = Array.isArray(c.days) ? (c.days as number[]) : [];
      if (!days.length) return "No day is ticked, so this is never true. Tick at least one day.";
      return c.op === "is_not"
        ? "True on every day except the ones ticked (IST)."
        : "True only on the days ticked (IST). All five ticked means every weekday.";
    },
  },

  /* ---- the open trade itself: judged on its own profit / loss, so only meaningful in the Exit list ---- */
  trade_stoploss: {
    label: "Trade stop-loss hit",
    group: "trade",
    exitOnly: true,
    fields: [
      { key: "value", label: "loss of", type: "num", def: 30 },
      { key: "unit", label: "in", type: "sel", def: "%", opts: ["%", "pts", "₹"], hint: TRADE_UNIT_HINT },
    ],
    help: (c) => `True once this trade is down ${tradeAmt(c)} from where it entered.${TRADE_HELP}`,
  },
  trade_target: {
    label: "Trade target (profit) hit",
    group: "trade",
    exitOnly: true,
    fields: [
      { key: "value", label: "profit of", type: "num", def: 40 },
      { key: "unit", label: "in", type: "sel", def: "%", opts: ["%", "pts", "₹"], hint: TRADE_UNIT_HINT },
    ],
    help: (c) => `True once this trade is up ${tradeAmt(c)} from where it entered.${TRADE_HELP}`,
  },
};

const GROUP_LABEL: Record<CondGroup, string> = {
  indicator: "Indicator",
  oi: "OI / chain",
  smart: "Smart money / structure",
  trend: "Trend / price action (Supertrend, Pivots, Candles, ATR)",
  greeks: "Greeks (Δ delta / gamma)",
  time: "Time / day of week",
  trade: "This trade (Exit list only)",
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
  for (const f of COND_DEFS[kind].fields) d[f.key] = Array.isArray(f.def) ? [...f.def] : f.def;
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
  isExit = false,
  groupCount = 1,
  group = 0,
  onGroup,
}: {
  cond: AutoCondition;
  onChange: (c: AutoCondition) => void;
  onRemove: () => void;
  /** true in the Exit list: only there can a condition look at the open trade */
  isExit?: boolean;
  /** with mixed AND / OR: how many groups the list has, which one this condition is in, and how to move it */
  groupCount?: number;
  group?: number;
  onGroup?: (k: number) => void;
}) {
  const def = COND_DEFS[cond.kind];
  const help = def?.help?.(cond);
  return (
    <div className="rounded border border-term-border bg-term-bg px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={cond.kind}
          onChange={(e) => onChange(mkCond(e.target.value))}
          className="rounded border border-term-border bg-term-panel px-1 py-0.5 text-2xs"
        >
          {(["indicator", "oi", "smart", "trend", "greeks", "time", "trade"] as CondGroup[]).map((g) => {
            // exit-only kinds are offered only in the Exit list (a kind already chosen always stays listed)
            const items = Object.entries(COND_DEFS).filter(
              ([k, v]) => v.group === g && (!v.exitOnly || isExit || k === cond.kind)
            );
            if (!items.length) return null;
            return (
              <optgroup key={g} label={GROUP_LABEL[g]}>
                {items.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>

        {def?.fields
          .filter((f) => f.show?.(cond) !== false)
          .map((f) => {
            const label = f.labelFor ? f.labelFor(cond) : f.label;
            if (f.type === "days") {
              const cur = Array.isArray(cond[f.key]) ? (cond[f.key] as number[]) : f.def;
              return (
                <div key={f.key} className="flex flex-wrap items-center gap-1 text-[10px] text-term-dim" title={f.hint}>
                  {label}
                  {DAY_NAMES.map((d, i) => {
                    const on = cur.includes(i);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        className={`chipbtn ${on ? "on" : ""}`}
                        onClick={() =>
                          onChange({ ...cond, [f.key]: (on ? cur.filter((x) => x !== i) : [...cur, i]).sort((x, y) => x - y) })
                        }
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
              );
            }
            return (
              <label key={f.key} title={f.hint} className="flex items-center gap-1 text-[10px] text-term-dim">
                {label}
                {f.type === "num" ? (
                  <input
                    type="number"
                    step="any"
                    value={Number(cond[f.key] ?? f.def)}
                    onChange={(e) => onChange({ ...cond, [f.key]: parseFloat(e.target.value) })}
                    className="num w-16 rounded border border-term-border bg-term-panel px-1 py-0.5 text-2xs text-term-text"
                  />
                ) : f.type === "time" ? (
                  <input
                    value={String(cond[f.key] ?? f.def)}
                    onChange={(e) => onChange({ ...cond, [f.key]: e.target.value })}
                    placeholder={f.def}
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
            );
          })}

        {groupCount > 1 && onGroup && (
          <select
            value={group}
            onChange={(e) => onGroup(Number(e.target.value))}
            title="Move this condition to another group"
            aria-label="group"
            className="ml-auto rounded border border-term-border bg-term-panel px-1 py-0.5 text-[10px] text-term-dim"
          >
            {Array.from({ length: groupCount }, (_, k) => (
              <option key={k} value={k}>
                Group {k + 1}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={onRemove}
          className={`${groupCount > 1 && onGroup ? "" : "ml-auto"} text-term-dim hover:text-down`}
          title="remove"
        >
          ✕
        </button>
      </div>
      {help && <p className="mt-1 text-[11px] leading-snug text-term-dim">{help}</p>}
    </div>
  );
}

/** AND / OR switch */
function AndOr({ value, onChange }: { value: Logic; onChange: (l: Logic) => void }) {
  return (
    <span className="seg text-[10px]">
      <button onClick={() => onChange("all")} className={value === "all" ? "on" : ""}>
        AND
      </button>
      <button onClick={() => onChange("any")} className={value === "any" ? "on" : ""}>
        OR
      </button>
    </span>
  );
}

function CondList({
  title,
  hint,
  state,
  onChange,
  joinDefault,
  isExit = false,
}: {
  title: string;
  hint: string;
  state: CondListState;
  onChange: (s: CondListState) => void;
  /** how a second group is joined to the first the moment it is added: Entry = AND, Exit = OR */
  joinDefault: Logic;
  isExit?: boolean;
}) {
  const { list, groups, logic } = state;
  const newGroup = () => onChange(addGroup(state, mkCond("rsi"), joinDefault));
  const canAddGroup = (groups?.length ?? 1) < MAX_GROUPS;
  const row = (i: number) => (
    <CondRow
      key={i}
      cond={list[i]}
      isExit={isExit}
      groupCount={groups?.length ?? 1}
      group={groups ? grpOf(list[i], groups.length) : 0}
      onGroup={(k) => onChange(moveCond(state, i, k))}
      onChange={(nc) => onChange(setCond(state, i, nc))}
      onRemove={() => onChange(removeCond(state, i))}
    />
  );

  /* ---- one flat list: exactly what it always was, plus a way into groups ---- */
  if (!groups) {
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <span className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-term-dim">
            {title}
            {list.length > 1 && <AndOr value={logic} onChange={(l) => onChange({ ...state, logic: l })} />}
            <span className="normal-case text-[10px] text-term-dim/70">
              · {logic === "any" ? "any one true" : "all true"} {hint}
            </span>
          </span>
          <span className="flex gap-1">
            <button
              className="btn px-1.5 py-0.5 text-2xs"
              onClick={newGroup}
              title="Split the conditions into groups, each with its own AND / OR"
            >
              + group
            </button>
            <button className="btn px-1.5 py-0.5 text-2xs" onClick={() => onChange(addCond(state, 0, mkCond("rsi")))}>
              + condition
            </button>
          </span>
        </div>
        {list.length === 0 && (
          <div className="rounded border border-dashed border-term-border px-2 py-1.5 text-[10px] text-term-dim">none</div>
        )}
        {list.map((_, i) => row(i))}
        {list.length > 1 && (
          <p className="text-[10px] leading-snug text-term-dim/80">
            Want some of these joined by AND and the others by OR? Press <b>+ group</b>.
          </p>
        )}
      </div>
    );
  }

  /* ---- groups: each has its own AND / OR, and one more switch joins the groups ---- */
  const ix = members(state);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="flex flex-wrap items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-term-dim">
          {title}
          <AndOr value={logic} onChange={(l) => onChange({ ...state, logic: l })} />
          <span className="normal-case text-[10px] text-term-dim/70">
            · {logic === "any" ? "any one group is enough" : "every group must hold"} {hint}
          </span>
        </span>
        {canAddGroup && (
          <button className="btn px-1.5 py-0.5 text-2xs" onClick={newGroup} title="Add another group of conditions">
            + group
          </button>
        )}
      </div>
      {groups.map((g, k) => (
        <div key={k} className="space-y-1.5">
          <div className="space-y-1.5 rounded-md border border-term-border bg-term-panel/60 p-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-2xs font-semibold uppercase tracking-wide text-term-text">Group {k + 1}</span>
              {ix[k].length > 1 && <AndOr value={g.logic} onChange={(l) => onChange(setGroupLogic(state, k, l))} />}
              <span className="text-[10px] text-term-dim/80">
                {ix[k].length > 1 ? (g.logic === "any" ? "any one of these" : "all of these") : ix[k].length === 1 ? "this condition" : "empty - ignored"}
              </span>
              <span className="ml-auto flex gap-1">
                <button className="btn px-1.5 py-0.5 text-2xs" onClick={() => onChange(addCond(state, k, mkCond("rsi")))}>
                  + condition
                </button>
                <button
                  className="btn px-1.5 py-0.5 text-2xs hover:text-down"
                  title="Remove this group and its conditions"
                  onClick={() =>
                    (ix[k].length < 2 || window.confirm(`Remove Group ${k + 1} and its ${ix[k].length} conditions?`)) &&
                    onChange(removeGroup(state, k))
                  }
                >
                  ✕ group
                </button>
              </span>
            </div>
            {ix[k].length === 0 && (
              <div className="rounded border border-dashed border-term-border px-2 py-1.5 text-[10px] text-term-dim">
                no conditions - add one, or move one here from another group
              </div>
            )}
            {ix[k].map((i) => row(i))}
          </div>
          {k < groups.length - 1 && (
            <div className="flex items-center gap-2 text-[10px] text-term-dim" aria-label={logic === "any" ? "or" : "and"}>
              <span className="h-px flex-1 bg-term-border" />
              <span className="rounded-full border border-term-border bg-term-bg px-2.5 py-px font-semibold tracking-wide text-term-text">
                {logic === "any" ? "OR" : "AND"}
              </span>
              <span className="h-px flex-1 bg-term-border" />
            </div>
          )}
        </div>
      ))}
      <p className="rounded border border-term-border/60 bg-term-bg px-2 py-1 text-[11px] leading-snug text-term-dim">
        <span className="font-semibold uppercase tracking-wide">{isExit ? "Exit when" : "Enter when"}</span>{" "}
        <span className="text-term-text">{readout(state, describe) || "-"}</span>
      </p>
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
/** columns of labelled fields with a hint under each; ~140px is the narrowest that keeps a hint readable */
const FIELD_GRID = "grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] items-start gap-x-4 gap-y-3";

/** Visible help text under a field. Tooltips don't exist on a phone or in the app, so anything a
 *  person needs to understand a field has to be on the screen. */
function Hint({ children }: { children: ReactNode }) {
  return <span className="mt-1 block text-[11px] font-normal leading-snug text-term-dim">{children}</span>;
}

/** a field: label above, the control, then its hint */
function HintLabel({ label, hint, title, children }: { label: string; hint?: ReactNode; title?: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col text-[11px]" title={title}>
      <span className="mb-0.5 font-medium text-term-text/90">{label}</span>
      {children}
      {hint != null && <Hint>{hint}</Hint>}
    </label>
  );
}

/** blank-able number box for the safety fields (blank = off, so it is omitted from the saved rule) */
function SafetyNum({
  label,
  title,
  hint,
  value,
  onChange,
  placeholder = "off",
  w = "md:w-20",
}: {
  label: string;
  title?: string;
  hint?: ReactNode;
  value: number | null | undefined;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
  w?: string;
}) {
  const input = (
    <input
      type="number"
      min={0}
      step="any"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)))}
      className={`num w-full rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text ${w}`}
    />
  );
  // no label = a bare box (the from / to pair under "days to expiry")
  if (!label) return <label title={title}>{input}</label>;
  return (
    <HintLabel label={label} hint={hint} title={title}>
      {input}
    </HintLabel>
  );
}

/** what a rule is trading, in words: a structure's name, or the single option + side */
const ruleWhat = (r: Partial<AutoRule>, defs?: AutoStructureDef[]) =>
  r.structure && r.structure !== "single"
    ? defs?.find((d) => d.key === r.structure)?.title ?? r.structure.replace(/_/g, " ")
    : `${r.instrument} ${r.side}`;

const rsP = (v: number) => `₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;

/** Multi-leg structure picker with a live preview of the legs it would open right now. */
function StructureBlock({
  r,
  set,
  defs,
}: {
  r: Partial<AutoRule>;
  set: (p: Partial<AutoRule>) => void;
  defs: AutoStructureDef[];
}) {
  const key = r.structure && r.structure !== "single" ? r.structure : "";
  const def = defs.find((d) => d.key === key);
  const [pv, setPv] = useState<StructurePreview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!key || !r.symbol) {
      setPv(null);
      return;
    }
    let alive = true;
    setErr(null);
    const id = setTimeout(() => {
      api
        .autobotStructurePreview({ symbol: r.symbol!, structure: key, offset: r.offset, width: r.width, expiry: r.expiry })
        .then(
          (d) => alive && setPv(d),
          (e) => alive && (setPv(null), setErr(String(e?.message ?? e)))
        );
    }, 350);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [key, r.symbol, r.expiry, r.offset, r.width]);

  if (!key || !def) return null;
  const lots = r.lots ?? 1;
  return (
    <div className="rounded border border-term-accent/40 bg-term-bg/40 p-2 text-[10px]">
      <div className="flex flex-wrap items-end gap-3">
        {def.hasOffset && (
          <label className="flex flex-col text-term-dim" title="How many strikes out from ATM the first leg(s) sit">
            strikes from ATM
            <input
              type="number"
              min={0}
              max={30}
              value={r.offset ?? def.offset}
              onChange={(e) => set({ offset: Math.max(0, Math.min(30, parseInt(e.target.value) || 0)) })}
              className="num w-full rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text md:w-16"
            />
          </label>
        )}
        {def.hasWidth && (
          <label className="flex flex-col text-term-dim" title="How many strikes beyond that the protective / far leg sits">
            width (strikes)
            <input
              type="number"
              min={1}
              max={30}
              value={r.width ?? def.width}
              onChange={(e) => set({ width: Math.max(1, Math.min(30, parseInt(e.target.value) || 1)) })}
              className="num w-full rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text md:w-16"
            />
          </label>
        )}
        <span className="max-w-[460px] text-term-dim">
          {def.blurb} One stop-loss, target, breakeven and trail for the whole position, measured on its <b>net premium</b>. Scale-out isn't
          available for structures.
        </span>
      </div>

      {err && <div className="mt-1.5 text-amber-400">Couldn't preview: {err}</div>}
      {pv && (
        <div className="mt-1.5">
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            {[...pv.legs]
              .sort((a, b) => (a.side === b.side ? a.ot.localeCompare(b.ot) || a.strike - b.strike : a.side === "BUY" ? -1 : 1))
              .map((lg, i) => (
                <span key={i} className="num">
                  <span className={lg.side === "BUY" ? "text-green-500" : "text-red-400"}>{lg.side}</span> {lg.strike} {lg.ot}{" "}
                  <span className="text-term-dim">@ {lg.price ? lg.price.toFixed(1) : "–"}</span>
                  {!lg.inChain && <span className="text-amber-400" title="This strike is outside the loaded option chain"> ⚠</span>}
                </span>
              ))}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-term-dim">
            <span>
              Net {pv.kind === "CREDIT" ? "credit" : "debit"}{" "}
              <b className="num text-term-text">{Math.abs(pv.net).toFixed(1)}</b> pts = {rsP(pv.perLot)}/lot
              {lots > 1 ? ` · ${rsP(pv.perLot * lots)} for ${lots} lots` : ""}
            </span>
            <span>
              Max profit at expiry{" "}
              <b className="num text-green-500">{pv.maxProfit == null ? "unlimited" : rsP(pv.maxProfit * lots)}</b>
            </span>
            <span>
              Max loss at expiry{" "}
              <b className="num text-red-400">{pv.maxLoss == null ? "unlimited" : rsP(pv.maxLoss * lots)}</b>
            </span>
            <span>
              {pv.symbol} {pv.expiry} · ATM {pv.atmStrike}
            </span>
          </div>
          {pv.missing.length > 0 && (
            <div className="mt-1 text-amber-400">
              {pv.missing.join(", ")} isn't in the loaded chain window — the legs there have no live price, so this rule would skip its entry.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
  const [defs, setDefs] = useState<AutoStructureDef[]>([]);
  useEffect(() => {
    api.autobotStructures().then((d) => setDefs(d.structures), () => {});
  }, []);
  const isStruct = !!r.structure && r.structure !== "single";
  const num = (v: string) => (v === "" ? undefined : parseFloat(v));

  // the rule's own expiry list — independent of whatever symbol/expiry the
  // user happens to have open elsewhere (chain/OI Profile), since a rule can
  // target any F&O symbol and keeps running long after that screen changes
  const [expiries, setExpiries] = useState<string[]>([]);
  useEffect(() => {
    if (!r.symbol) {
      setExpiries([]);
      return;
    }
    let alive = true;
    api.chain(r.symbol).then(
      (c) => alive && setExpiries(c.expiries ?? []),
      () => alive && setExpiries([])
    );
    return () => {
      alive = false;
    };
  }, [r.symbol]);

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
          <label
            className="flex items-center gap-1"
            title="How many candles of history your entry/exit conditions see. Must exceed your slowest indicator's warm-up (MACD needs ~35, a 50-length EMA needs 50+) or that condition silently never fires."
          >
            bars
            <input
              type="number"
              min={35}
              value={r.entryBars ?? 60}
              onChange={(e) => set({ entryBars: Math.max(35, parseInt(e.target.value) || 60) })}
              className="num w-14 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text"
            />
          </label>
          <span className="text-[9px] normal-case text-term-dim/70">
            RSI / EMA / MACD / Supertrend / Candles / Prev-candle / ATR evaluate on this timeframe — keep "bars" above your
            slowest indicator's lookback
          </span>
        </div>
        <CondList
          title="Entry"
          hint="to open"
          state={{ list: r.entry ?? [], groups: r.entryGroups, logic: r.entryLogic ?? "all" }}
          onChange={(s) => set({ entry: s.list, entryGroups: s.groups, entryLogic: s.logic })}
          joinDefault="all"
        />
        <CondList
          title="Exit"
          hint="(SL / target / square-off always apply)"
          isExit
          state={{ list: r.exit ?? [], groups: r.exitGroups, logic: r.exitLogic ?? "any" }}
          onChange={(s) => set({ exit: s.list, exitGroups: s.groups, exitLogic: s.logic })}
          joinDefault="any"
        />

        {/* premium / delta entry filter — gates the resolved option */}
        <EntryFilterEditor
          ef={r.entryFilter ?? {}}
          onChange={(ef) => set({ entryFilter: ef })}
        />
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
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
        <label className="flex flex-col text-[10px] text-term-dim" title="Which expiry this rule trades. Front week = nearest expiry, whatever that is on the day the rule fires — the safe default for a rule left running unattended.">
          expiry
          <SelectMenu
            value={r.expiry ?? ""}
            options={[["Front week", ""], ...expiries.map((e) => [e, e] as [string, string])]}
            onChange={(v) => set({ expiry: v || null })}
            title="Expiry"
            width={130}
          />
        </label>
        <label
          className="flex flex-col text-[10px] text-term-dim"
          title="Trade one option, or open a whole multi-leg structure (straddle, strangle, iron condor, spreads) as a single trade with one combined stop and target."
        >
          trade
          <SelectMenu
            value={isStruct ? (r.structure as string) : "single"}
            options={[
              ["One option", "single"],
              ...defs.map((d) => [d.title, d.key] as [string, string]),
            ]}
            onChange={(v) =>
              set(
                v === "single"
                  ? { structure: null, offset: undefined, width: undefined }
                  : {
                      structure: v,
                      offset: defs.find((d) => d.key === v)?.offset,
                      width: defs.find((d) => d.key === v)?.width || undefined,
                      target1Pct: undefined,
                    }
              )
            }
            title="What to trade"
            width={150}
          />
        </label>
        {!isStruct && (
          <>
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
          </>
        )}
        <label className="flex flex-col text-[10px] text-term-dim">
          lots
          <input
            type="number"
            min={1}
            value={r.lots ?? 1}
            onChange={(e) => set({ lots: Math.max(1, parseInt(e.target.value) || 1) })}
            className="num w-full rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text md:w-16"
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

      <StructureBlock r={r} set={set} defs={defs} />

      {/* ---- exit levels: what protects the trade once it is open ---- */}
      {(() => {
        const basis = r.slBasis ?? "pct";
        const u = basis === "pts" ? "pts" : basis === "rs" ? "₹" : "%";
        const unitNote =
          basis === "pts"
            ? "Points are ₹ per share of the option's own price, not index points. Example: SL 30 on a ₹100 option exits at ₹70."
            : basis === "rs"
            ? "₹ of profit or loss on the whole position, all lots together."
            : "% of the price you entered at. Example: SL 30 on a ₹100 option exits at ₹70.";
        const sideNote = isStruct
          ? " For a multi-leg trade these are measured on the combined price of all its legs."
          : r.side === "SELL"
          ? " You are selling, so “in profit” means the price is falling."
          : "";
        const fields: [keyof AutoRule, string, string][] = [
          ["slPct", `SL ${u}`, "Get out if the trade goes this far against you."],
          ["targetPct", `target ${u}`, "Get out and keep the profit once it is this far in profit."],
          ["trailPct", `trail ${u}`, "Your exit follows the best price, this far behind it. It only moves up, never down. Blank = off."],
          ["trailArmPct", `trail arm ${u}`, "Trailing only starts once the trade is this far in profit. Blank = it starts at once."],
          ["beArmPct", `breakeven arm ${u}`, "Once it is this far in profit, your exit moves to your entry price: no loss from there. Blank = off."],
          ["target1Pct", `scale-out ${u}`, "Sell part of the position at this profit; the rest keeps running. Blank = off."],
        ];
        return (
          <div className="rounded border border-term-border/70 p-2">
            <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-term-dim">Exit levels</span>
              <span className="text-[11px] text-term-dim">numbers are in</span>
              <div className="seg">
                {(
                  [
                    ["pct", "%"],
                    ["pts", "Pts"],
                    ["rs", "₹"],
                  ] as const
                ).map(([v, lbl]) => (
                  <button key={v} type="button" onClick={() => set({ slBasis: v })} className={basis === v ? "on" : ""}>
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
            <p className="mb-2.5 text-[11px] leading-snug text-term-dim">
              {unitNote}
              {sideNote}
            </p>
            <div className={FIELD_GRID}>
              {fields
                .filter(([k]) => !(isStruct && k === "target1Pct"))
                .map(([k, label, hint]) => (
                  <HintLabel key={k} label={label} hint={hint}>
                    <input
                      type="number"
                      step="any"
                      value={(r[k] as number | undefined) ?? ""}
                      onChange={(e) => set({ [k]: num(e.target.value) } as Partial<AutoRule>)}
                      className="num w-full rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text md:w-24"
                    />
                  </HintLabel>
                ))}
              {!isStruct && (
                <HintLabel
                  label="scale-out lots %"
                  hint="How much to sell at that point. At least 1 lot always stays."
                  title="What share of the position to close at the scale-out level (rounded to whole lots, always leaves at least 1 lot open)."
                >
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={r.target1LotsPct ?? 50}
                    onChange={(e) => set({ target1LotsPct: Math.min(99, Math.max(1, parseInt(e.target.value) || 50)) })}
                    className="num w-full rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text md:w-20"
                  />
                </HintLabel>
              )}
            </div>
          </div>
        );
      })()}

      {/* ---- timing: how often, and when in the day ---- */}
      <div className="rounded border border-term-border/70 p-2">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-term-dim">Timing</div>
        <div className={FIELD_GRID}>
          <HintLabel label="max trades/day" hint="Most new trades this rule can open in a day.">
            <input
              type="number"
              min={1}
              value={r.maxTradesPerDay ?? 3}
              onChange={(e) => set({ maxTradesPerDay: Math.max(1, parseInt(e.target.value) || 1) })}
              className="num w-full rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text md:w-16"
            />
          </HintLabel>
          <HintLabel label="cooldown min" hint="Minutes to wait after a trade closes before it can enter again.">
            <input
              type="number"
              min={0}
              value={r.cooldownMin ?? 5}
              onChange={(e) => set({ cooldownMin: Math.max(0, parseInt(e.target.value) || 0) })}
              className="num w-full rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text md:w-16"
            />
          </HintLabel>
          <HintLabel
            label="square-off"
            hint={r.holdType === "positional" ? "Not used: this rule is Positional, so it keeps trades open." : "Time (IST) when everything is closed for the day."}
          >
            <input
              value={r.squareOff ?? "15:20"}
              onChange={(e) => set({ squareOff: e.target.value })}
              placeholder="15:20"
              disabled={r.holdType === "positional"}
              className="num w-full rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text disabled:opacity-40 md:w-20"
            />
          </HintLabel>
          <HintLabel label="entry after" hint="Won't enter before this time (IST). Blank = from market open.">
            <input
              value={r.noEntryBefore ?? ""}
              onChange={(e) => set({ noEntryBefore: e.target.value })}
              placeholder="09:20"
              className="num w-full rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text md:w-20"
            />
          </HintLabel>
          <HintLabel label="no entry after" hint="Won't enter after this time (IST). Blank = no limit.">
            <input
              value={r.noEntryAfter ?? ""}
              onChange={(e) => set({ noEntryAfter: e.target.value })}
              placeholder="15:00"
              className="num w-full rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-xs text-term-text md:w-20"
            />
          </HintLabel>
        </div>
      </div>

      {/* ---- safety: brakes that hold a rule back when the day is going wrong ---- */}
      <div className="rounded border border-term-border/70 p-2">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-term-dim">Safety</span>
          <span className="text-[10px] text-term-dim">
            blank = off. These only ever stop a rule from trading; they never open a position.
          </span>
        </div>
        <div className={FIELD_GRID}>
          <SafetyNum
            label="max trades/week"
            hint="Stop trading for the week after this many trades."
            title="Stop opening new trades for the rest of the week once this many have been taken (Mon-Fri, resets each week)."
            value={r.maxTradesPerWeek}
            onChange={(v) => set({ maxTradesPerWeek: v })}
          />
          <SafetyNum
            label="stop after N losses"
            hint="Pause the rule for the day after this many losing trades in a row."
            title="A win resets the count."
            value={r.maxConsecLosses}
            onChange={(v) => set({ maxConsecLosses: v })}
          />
          <SafetyNum
            label="rule loss cap ₹"
            hint="Pause the rule for the day once it has lost this much today."
            title="Separate from the engine-wide daily loss cap."
            value={r.ruleMaxLoss}
            onChange={(v) => set({ ruleMaxLoss: v })}
            w="md:w-24"
          />
          <SafetyNum
            label="max spread %"
            hint="Skip the entry if the gap between buy and sell price is wider than this % of the price."
            title="A wide spread is paid on the way in and again on the way out."
            value={r.maxSpreadPct}
            onChange={(v) => set({ maxSpreadPct: v })}
          />
          <SafetyNum
            label="max lots/order"
            hint="Bigger live orders are split into pieces this size. Blank = 20."
            title="Keeps every order under the exchange's freeze quantity so none is rejected."
            value={r.maxLotsPerOrder}
            onChange={(v) => set({ maxLotsPerOrder: v })}
            placeholder="20"
          />
        </div>
        <div className="mt-3 flex flex-col gap-1 text-[11px]">
          <span className="font-medium text-term-text/90">days to expiry</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <SafetyNum
              label=""
              title="Trade only when the expiry is at least this many days away"
              value={r.minDte}
              placeholder="from"
              onChange={(v) => set({ minDte: v })}
              w="md:w-14"
            />
            <SafetyNum
              label=""
              title="Trade only when the expiry is at most this many days away"
              value={r.maxDte}
              placeholder="to"
              onChange={(v) => set({ maxDte: v })}
              w="md:w-14"
            />
            <button className="chipbtn" title="Trade only on expiry day" onClick={() => set({ minDte: 0, maxDte: 0 })}>
              expiry day only
            </button>
            <button className="chipbtn" title="Never trade on expiry day" onClick={() => set({ minDte: 1, maxDte: undefined })}>
              skip expiry day
            </button>
            <button className="chipbtn" onClick={() => set({ minDte: undefined, maxDte: undefined })}>
              any
            </button>
          </div>
          <Hint>Trade only when the expiry is between “from” and “to” days away. 0 = expiry day. Blank = any.</Hint>
        </div>
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
/* why did / didn't it fire                                            */
/* ------------------------------------------------------------------ */
function WhyLine({ r, masterOn }: { r: AutoRule; masterOn: boolean }) {
  const w = r._why;
  const dim = "mt-1.5 text-[10px] text-term-dim";
  if (!r.enabled) return <div className={dim}>Rule is off - it isn't being checked.</div>;
  if (!masterOn) return <div className={dim}>Engine is off - nothing will fire until it's switched on.</div>;
  if (r._state?.paused) return <div className="mt-1.5 text-[10px] text-amber-400">⏸ {r._state.paused}</div>;
  if (!w) return <div className={dim}>Waiting for the next check…</div>;

  const list = (w.list === "exit" ? r.exit : r.entry) ?? [];
  const age = Math.max(0, Math.round(Date.now() / 1000 - w.ts));
  const chip = (ok: boolean, i: number) => (
    <span key={i} className={`rounded border px-1 py-px ${ok ? "border-up/50 text-up" : "border-down/50 text-down"}`}>
      {ok ? "✓" : "✗"} {list[i] ? describe(list[i]) : `#${i + 1}`}
    </span>
  );
  const conds = w.conds ?? [];
  const joinWord = w.logic === "any" ? "OR" : "AND";
  // mixed AND / OR: draw the chips inside their groups, with the join word between the groups
  const clusters =
    w.groups && w.grp
      ? w.groups
          .map((gl, k) => ({ gl, k, idx: conds.map((_, i) => i).filter((i) => (w.grp?.[i] ?? 0) === k) }))
          .filter((c) => c.idx.length)
      : null;
  const chips = clusters
    ? clusters.map((c, n) => (
        <span key={c.k} className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          {n > 0 && <span className="font-semibold text-term-dim">{joinWord}</span>}
          <span className="inline-flex flex-wrap items-center gap-1 rounded-md border border-term-border px-1 py-px">
            {c.idx.length > 1 && <span className="text-term-dim">{c.gl === "any" ? "any of" : "all of"}</span>}
            {c.idx.map((i) => chip(conds[i], i))}
          </span>
        </span>
      ))
    : conds.map((ok, i) => chip(ok, i));
  const logic = clusters
    ? w.logic === "any"
      ? "any one group is enough"
      : "every group must hold"
    : w.logic === "any"
      ? "any one is enough"
      : "all must be true";
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
      {w.phase === "blocked" ? (
        <span className="text-amber-400">⛔ {w.reason}</span>
      ) : w.phase === "open" ? (
        <span className="text-term-text">
          In trade{w.stop != null ? ` · stop ${w.stop.toFixed(1)}` : ""}
          {conds.length ? " · exit signals" : ""}
        </span>
      ) : (
        <span className="text-term-text">Watching for an entry ({logic})</span>
      )}
      {chips}
      <span className="text-term-dim" title="How long ago the engine last evaluated this rule">
        checked {age}s ago
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* performance tab                                                     */
/* ------------------------------------------------------------------ */
/** text colour for a P&L figure: brighter than --down so a loss reads as clearly as a win */
const toneCls = (v: number | null | undefined) => TONE_TEXT[tone(v)];
const rs = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;

function AutoPerformance() {
  const [data, setData] = useState<AutoStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.autobotStats(80).then(
        (d) => alive && (setData(d), setErr(null)),
        (e) => alive && setErr(String(e?.message ?? e))
      );
    load();
    const id = setInterval(() => !document.hidden && load(), 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (err && !data) return <div className="p-4 text-xs text-down">Couldn't load performance: {err}</div>;
  if (!data) return <div className="p-4 text-xs text-term-dim">Loading…</div>;
  const o = data.overall;
  if (!o.count)
    return (
      <div className="p-6 text-center text-xs text-term-dim">
        No closed trades yet. Once a rule completes a trade (paper or live) its result shows up here, net of estimated
        charges.
      </div>
    );
  const rows = Object.entries(data.rules).sort((a, b) => b[1].total - a[1].total);
  const th = (h: string) => (
    <th key={h} className="border-b border-term-border px-2.5 py-1.5 font-medium">
      {h}
    </th>
  );
  return (
    <div className="flex flex-col gap-3 p-3 md:min-h-0 md:flex-1 md:overflow-y-auto">
      <FigureBoard s={o} gross={o.gross} costs={o.charges} costsLabel="charges" />

      {o.equity.length >= 2 && (
        <section className="min-w-0 rounded border border-term-border bg-term-bg/20 p-3">
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-term-text">
            Equity curve <span className="font-normal normal-case text-term-dim">· running net P&amp;L, one point per closed trade</span>
          </h3>
          <LineChart
            height={170}
            series={[
              {
                key: "eq",
                label: "Net P&L",
                color: o.total >= 0 ? "#22c55e" : "#f87171",
                width: 1.6,
                points: [{ x: 0, y: 0 }, ...o.equity.map((v, i) => ({ x: i + 1, y: v }))],
              },
            ]}
            xFormat={(x) => (x === 0 ? "start" : `trade ${x}`)}
            xTicks={tradeTicks(o.equity.length)}
            yFormat={(y) => money(y, { sign: true })}
            hlines={[{ value: 0, color: "#94a3b8", dashed: true }]}
          />
        </section>
      )}

      <section className="min-w-0 rounded border border-term-border bg-term-bg/20 p-3">
        <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-term-text">By rule</h3>
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-term-dim">
                {["Rule", "Trades", "Win %", "Net P&L", "Expectancy", "Profit factor", "Max DD", "Losing streak"].map(th)}
              </tr>
            </thead>
            <tbody className="num">
              {rows.map(([id, x]) => (
                <tr key={id} className="border-b border-term-border/50">
                  <td className="px-2.5 py-1.5 text-term-text">{x.name}</td>
                  <td className="px-2.5 py-1.5">{x.count}</td>
                  <td className="px-2.5 py-1.5">{nf(x.winRate, 0)}%</td>
                  <td className={`px-2.5 py-1.5 font-semibold ${toneCls(x.total)}`}>{rs(x.total)}</td>
                  <td className={`px-2.5 py-1.5 ${toneCls(x.expectancy)}`}>{rs(x.expectancy)}</td>
                  <td className="px-2.5 py-1.5">{x.profitFactor != null ? nf(x.profitFactor, 2) : "–"}</td>
                  <td className="px-2.5 py-1.5 text-red-400">{rs(x.maxDrawdown)}</td>
                  <td className="px-2.5 py-1.5">{x.maxLossStreak}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="min-w-0 rounded border border-term-border bg-term-bg/20 p-3">
        <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-term-text">Recent fills</h3>
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-term-dim">
                {["When", "Rule", "Position", "Lots", "Entry", "Exit", "P&L", "Why"].map(th)}
              </tr>
            </thead>
            <tbody className="num">
              {data.recent.map((t, i) => (
                <tr key={i} className="border-b border-term-border/50">
                  <td className="px-2.5 py-1.5 text-term-dim">
                    {new Date(t.exitTs * 1000).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td className="px-2.5 py-1.5 text-term-text">{t.ruleName}</td>
                  <td className="px-2.5 py-1.5">
                    {t.side === "BUY" ? "B" : "S"} {t.label}
                    {t.mode === "live" ? " · live" : ""}
                  </td>
                  <td className="px-2.5 py-1.5">{t.lots}</td>
                  <td className="px-2.5 py-1.5">{nf(t.entryPx, 2)}</td>
                  <td className="px-2.5 py-1.5">{nf(t.exitPx, 2)}</td>
                  <td className={`px-2.5 py-1.5 font-semibold ${toneCls(t.pnl - t.charges)}`}>{rs(t.pnl - t.charges)}</td>
                  <td className="px-2.5 py-1.5 text-term-dim">
                    {t.reason}
                    {t.partial ? " (part)" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-[10px] text-term-dim">
          P&amp;L is estimated from the market price at the moment the engine acted (a live order's true fill isn't known to it)
          less estimated charges. The broker's contract note is the source of truth.
        </p>
      </section>
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
  const resumeRule = useStore((s) => s.autobotResume);
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
  // collapsed by default -- a card's full entry/exit condition grid only
  // shows once expanded, so scanning several active rules doesn't mean
  // scrolling past every field of every one
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const [lossDraft, setLossDraft] = useState("");
  const [tab, setTab] = useState<"rules" | "performance" | "backtest">("rules");
  const prevTradesRef = useRef<Record<string, boolean>>({});

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

  // Sound notifications for trade entry/exit
  useEffect(() => {
    const rules = bot?.rules ?? [];
    rules.forEach((r) => {
      const hasOpen = !!r._state?.open;
      const hadOpen = prevTradesRef.current[r.id];

      if (hasOpen && !hadOpen) {
        // Trade just opened
        const side = r._state?.open?.side;
        if (side === "BUY" || side === "SELL") {
          playOrderSound(side);
        }
      } else if (!hasOpen && hadOpen) {
        // Trade just closed (exit sound)
        playOrderSound("SELL");
      }

      prevTradesRef.current[r.id] = hasOpen;
    });
  }, [bot?.rules]);

  const rules = bot?.rules ?? [];
  const anyLive = useMemo(() => rules.some((r) => r.mode === "live" && r.enabled), [rules]);

  return (
    <div className="flex flex-col md:min-h-0 md:flex-1 md:overflow-hidden">
      {/* control bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-term-border bg-term-panel2 px-3 py-2">
        <button
          onClick={() => setMaster(!bot?.master)}
          className={`rounded px-3 py-1 text-xs font-semibold ${
            bot?.master ? "bg-up text-white" : "border border-term-dim/70 bg-term-panel text-term-dim"
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
          <span className="text-[11px] uppercase tracking-wide text-term-dim">Bot P&L today</span>
          <span className={`num text-base font-semibold ${toneCls(bot?.dailyPnl ?? 0)}`}>
            {money(bot?.dailyPnl ?? 0, { sign: true })}
          </span>
        </div>
        <label className="ml-auto flex items-center gap-1 text-2xs text-term-dim">
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
      <div className="flex flex-wrap items-center gap-1 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs">
        {(
          [
            ["rules", "Rules"],
            ["performance", "Performance"],
            ["backtest", "⏱ Backtest"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded border px-2.5 py-1 font-semibold ${
              tab === k
                ? "border-term-accent bg-term-accent text-white"
                : "border-term-dim/70 text-term-dim hover:bg-term-border"
            }`}
          >
            {label}
          </button>
        ))}
        <span className={`ml-2 text-term-dim ${tab === "rules" ? "" : "hidden md:inline"}`}>
          {tab === "backtest"
            ? "Replay a rule's indicator / OI conditions against Upstox daily history"
            : tab === "performance"
            ? "How the rules have actually done, net of charges"
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

      {tab === "performance" && <AutoPerformance />}

      {tab === "backtest" && (
        <AutoBacktestTab rules={rules} onDone={() => setTab("rules")} />
      )}

      {tab === "rules" && (
      <div className="flex flex-col gap-3 p-3 md:min-h-0 md:flex-1 md:flex-row md:overflow-hidden">
        {/* rules + editor */}
        <div className="space-y-3 md:min-h-0 md:flex-1 md:overflow-auto md:pr-1">
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
                      r.enabled ? "bg-up" : "bg-term-border ring-1 ring-inset ring-term-dim/60"
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
                    {r.symbol}
                    {r.expiry ? ` ${r.expiry}` : ""} · {ruleWhat(r)} ×{r.lots}
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
                    <span className="rounded bg-up/15 px-1.5 py-0.5 text-xs text-green-500">
                      IN TRADE {open.side} {open.label ?? `${open.strike}${open.ot}`} @{open.entryPx.toFixed(1)}
                      {open.peak != null && ` · peak ${open.peak.toFixed(1)}`}
                      {open.stopPx != null && (
                        <span className="text-amber-400"> · stop {open.stopPx.toFixed(1)}</span>
                      )}
                    </span>
                  )}
                  <span className="text-xs text-term-dim">
                    {r._state?.tradesToday ?? 0}/{r.maxTradesPerDay} today
                    {r.maxTradesPerWeek ? ` · ${r._state?.weekTrades ?? 0}/${r.maxTradesPerWeek} this week` : ""} ·{" "}
                    {(r.entry ?? []).length} entry · {(r.exit ?? []).length} exit
                  </span>
                  {r._state?.paused && (
                    <span className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-2xs text-amber-400">
                      ⏸ paused
                      <button
                        className="chipbtn"
                        onClick={() => resumeRule(r.id)}
                        title={`${r._state.paused} - click to let it trade again today`}
                      >
                        Resume
                      </button>
                    </span>
                  )}
                  {r._stats && r._stats.trades > 0 && (
                    <span className="text-xs text-term-dim" title="From this rule's closed trades, net of estimated charges">
                      {r._stats.trades} trades · {nf(r._stats.winRate, 0)}% win ·{" "}
                      <span className={`font-semibold ${toneCls(r._stats.net)}`}>{rs(r._stats.net)}</span>
                      {r._stats.today ? (
                        <>
                          {" "}
                          (today <span className={`font-semibold ${toneCls(r._stats.today)}`}>{rs(r._stats.today)}</span>)
                        </>
                      ) : null}
                    </span>
                  )}

                  <div className="ml-auto flex items-center gap-1">
                    <button
                      className="btn px-1.5 py-0.5 text-2xs"
                      onClick={() => toggleExpanded(r.id)}
                      title={expanded.has(r.id) ? "Collapse" : "Show entry / exit conditions"}
                    >
                      {expanded.has(r.id) ? "▾" : "▸"}
                    </button>
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

                <WhyLine r={r} masterOn={!!bot?.master} />
                {open?.legs && (
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-term-dim">
                    {open.unwind && <span className="text-down">unwinding — a leg failed to close</span>}
                    {open.legs.map((lg, i) => (
                      <span key={i} className="num">
                        <span className={lg.side === "BUY" ? "text-up" : "text-down"}>{lg.side}</span> {lg.strike} {lg.ot} @{lg.entryPx.toFixed(1)}
                      </span>
                    ))}
                  </div>
                )}

                {btId === r.id && <RuleBacktest rule={r} onClose={() => setBtId(null)} />}

                {expanded.has(r.id) && (
                <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                  <div>
                    <span className="uppercase tracking-wide text-term-dim">
                      entry ({r.entryGroups?.length ? `groups: ${r.entryLogic === "any" ? "any" : "all"}` : r.entryLogic === "any" ? "any" : "all"}) ·{" "}
                      {r.entryTf
                        ? r.entryTf < 3600
                          ? `${r.entryTf / 60}m`
                          : `${r.entryTf / 3600}h`
                        : "tick"}{" "}
                      candles
                    </span>
                    <CondBullets
                      state={{ list: r.entry ?? [], groups: r.entryGroups, logic: r.entryLogic ?? "all" }}
                      liveIdx={entryLiveIdx}
                      live={r._live}
                      empty="—"
                    />
                  </div>
                  <div>
                    {(() => {
                      const u = r.slBasis === "pts" ? "pts" : r.slBasis === "rs" ? "₹" : "%";
                      return (
                        <span className="uppercase tracking-wide text-term-dim">
                          exit ({r.exitGroups?.length ? `groups: ${r.exitLogic === "all" ? "all" : "any"}` : r.exitLogic === "all" ? "all" : "any"}) · SL {r.slPct ?? "–"}
                          {u} · tgt {r.targetPct ?? "–"}
                          {u}
                          {r.trailPct
                            ? ` · trail ${r.trailPct}${u}${
                                r.trailArmPct ? `@+${r.trailArmPct}${u}` : ""
                              }`
                            : ""}
                          {r.beArmPct ? ` · BE@+${r.beArmPct}${u}` : ""}
                          {r.target1Pct
                            ? ` · scale-out ${r.target1LotsPct ?? 50}%@+${r.target1Pct}${u}`
                            : ""}{" "}
                          · {r.holdType === "positional" ? "positional" : `sq ${r.squareOff}`}
                          {r.noEntryBefore ? ` · from ${r.noEntryBefore}` : ""}
                        </span>
                      );
                    })()}
                    <CondBullets
                      state={{ list: r.exit ?? [], groups: r.exitGroups, logic: r.exitLogic ?? "any" }}
                      liveIdx={exitLiveIdx}
                      live={r._live}
                      empty="SL / target / square-off only"
                    />
                  </div>
                </div>
                )}
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
                      : e.level === "stop"
                      ? "text-amber-400"
                      : "text-term-dim"
                  }
                >
                  [{e.level}]
                </span>{" "}
                <span className="text-term-text">{e.ruleName}</span>: {e.msg}
                {(e.count ?? 1) > 1 && <span className="num text-term-dim"> ×{e.count}</span>}
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
            (r) => [`${r.name} · ${r.symbol} · ${ruleWhat(r)}`, r.id] as [string, string]
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
          className="ml-auto rounded border border-term-dim/70 px-2 py-1 text-2xs text-term-dim hover:border-term-accent hover:text-term-text"
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
    case "gamma_vs_delta": {
      const dFirst = g("op") === "delta_faster";
      return `${dFirst ? "delta" : "gamma"} outpaces ${dFirst ? "gamma" : "delta"} by ≥${g("value")} pts over ${g("bars")} readings (${g("leg")})`;
    }
    case "theta_level":
      return `theta ${g("leg")} ${g("op")} ${g("value")}`;
    case "vega_level":
      return `vega ${g("leg")} ${g("op")} ${g("value")}`;
    case "blast_score":
      return `Gamma Blast score ${g("op")} ${g("value")}`;
    case "iv_rank":
      return `IV rank ${g("op")} ${g("value")}`;
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
    case "time_of_day": {
      const f = g("from") || "09:15";
      const t = g("to") || "15:30";
      const op = g("op") || "between";
      return op === "after" ? `time after ${f}` : op === "before" ? `time before ${t}` : op === "outside" ? `time outside ${f}–${t}` : `time ${f}–${t}`;
    }
    case "trade_stoploss":
      return `trade stop-loss: down ≥ ${tradeAmt(c)}`;
    case "trade_target":
      return `trade target: up ≥ ${tradeAmt(c)}`;
    case "day_of_week": {
      const days = Array.isArray(c.days) ? (c.days as number[]) : [];
      return `day ${g("op") === "is_not" ? "is not" : "is"} ${dayLabel(days)}`;
    }
    default:
      return c.kind;
  }
}

/** "Prev high 24,530 (5m) · spot 24,545 (+15.0)" -- the live prev_candle
 *  readout shown next to its condition on the rule card. */
/** The conditions of a rule card as bullets; with mixed AND / OR each group gets its own block and the join word sits between them. */
function CondBullets({
  state,
  liveIdx,
  live,
  empty,
}: {
  state: CondListState;
  liveIdx: number;
  live: AutoRule["_live"];
  empty: string;
}) {
  const { list, groups, logic } = state;
  const bullet = (i: number) => (
    <li key={i} className="text-term-text">
      • {describe(list[i])}
      {i === liveIdx && live && <span className="ml-1 text-term-accent">{fmtLive(live)}</span>}
    </li>
  );
  if (!groups) {
    return (
      <ul className="mt-0.5 space-y-0.5">
        {list.map((_, i) => bullet(i))}
        {list.length === 0 && <li className="text-term-dim">{empty}</li>}
      </ul>
    );
  }
  const blocks = members(state)
    .map((ix, k) => ({ ix, k }))
    .filter((b) => b.ix.length);
  if (!blocks.length) return <ul className="mt-0.5"><li className="text-term-dim">{empty}</li></ul>;
  return (
    <div className="mt-0.5 space-y-0.5">
      {blocks.map((b, n) => (
        <div key={b.k} className="space-y-0.5">
          {n > 0 && <div className="text-[9px] font-semibold tracking-wide text-term-dim">{logic === "any" ? "OR" : "AND"}</div>}
          <div className="rounded border border-term-border/70 px-1.5 py-0.5">
            {b.ix.length > 1 && (
              <div className="text-[9px] uppercase tracking-wide text-term-dim">
                {groups[b.k].logic === "any" ? "any of" : "all of"}
              </div>
            )}
            <ul className="space-y-0.5">{b.ix.map(bullet)}</ul>
          </div>
        </div>
      ))}
    </div>
  );
}

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
