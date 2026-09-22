/**
 * Pure helpers behind the Vol tab's headline panel (VolHeadline.tsx): bar scales, the verdict tint, the skew gauge,
 * the expected-range bar, and an honest name for the "30-day IV" when the expiry curve does not reach a month.
 */
import type { VolCurve } from "../types";

/** Same cut-offs as backend volatility.py (EXPENSIVE_RATIO / CHEAP_RATIO): 30-day IV over 20-day realized. Keep in step. */
export const EXPENSIVE_RATIO = 1.5;
export const CHEAP_RATIO = 0.95;
/** 25-delta risk reversal as a fraction of ATM IV; backend FEAR_STRONG / FEAR_MILD / CHASE. Keep in step. */
export const FEAR_STRONG = -0.35;
export const FEAR_MILD = -0.1;
export const CHASE = 0.1;
/** the skew gauge runs from -SKEW_SPAN to +SKEW_SPAN of ATM IV */
export const SKEW_SPAN = 0.5;

export type Verdict = "expensive" | "cheap" | "fair";
export const verdictOf = (ratio: number): Verdict => (ratio >= EXPENSIVE_RATIO ? "expensive" : ratio < CHEAP_RATIO ? "cheap" : "fair");

const fin = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Bar length as a percentage of `max`; 0 when there is nothing to draw. */
export function barPct(v: number | null | undefined, max: number): number {
  return fin(v) && fin(max) && max > 0 ? clamp((v / max) * 100, 0, 100) : 0;
}

/** One scale for bars that are compared with each other: a little above the largest value, so none of them touches the end. */
export function barMax(...vals: (number | null | undefined)[]): number {
  const m = Math.max(0, ...vals.filter(fin));
  return m > 0 ? m * 1.1 : 1;
}

/** Position on the skew gauge (0 = far left, 100 = far right) for a risk reversal expressed as a fraction of ATM IV. */
export const skewPos = (rel: number): number => clamp(50 + (rel / SKEW_SPAN) * 50, 3, 97);

/** where the "about even" zone starts and ends on the gauge */
export const EVEN_ZONE: [number, number] = [skewPos(FEAR_MILD), skewPos(CHASE)];

export interface Skew {
  /** risk reversal / ATM IV */
  rel: number;
  /** marker position along the gauge, 3 (puts) .. 97 (calls) */
  pos: number;
  side: "puts" | "calls" | "even";
  /** one plain sentence, worded like the summary card's "What it fears" line */
  word: string;
}

/** 25-delta call IV minus put IV, read against the level of IV. Negative = puts cost more (downside protection is in demand). */
export function skewRead(rr: number | null | undefined, atmIV: number | null | undefined): Skew | null {
  if (!fin(rr) || !fin(atmIV) || atmIV <= 0) return null;
  const rel = rr / atmIV;
  const pos = skewPos(rel);
  if (rel <= FEAR_STRONG) return { rel, pos, side: "puts", word: "Puts are much pricier than calls: the market is paying up for downside protection." };
  if (rel <= FEAR_MILD) return { rel, pos, side: "puts", word: "Puts are a little pricier than calls: the usual tilt, no unusual fear." };
  if (rel >= CHASE) return { rel, pos, side: "calls", word: "Calls are pricier than puts: the market is paying up for the upside." };
  return { rel, pos, side: "even", word: "Puts and calls are priced about evenly: no strong lean either way." };
}

export interface RangeBar {
  lo: number;
  hi: number;
  /** the one-sigma move, % of spot */
  pct: number;
}

/** The price range one standard deviation of the front expiry's ATM IV allows (about two times out of three). */
export function rangeBar(spot: number | null | undefined, sigmaPct: number | null | undefined): RangeBar | null {
  if (!fin(spot) || spot <= 0 || !fin(sigmaPct) || sigmaPct <= 0) return null;
  return { lo: spot * (1 - sigmaPct / 100), hi: spot * (1 + sigmaPct / 100), pct: sigmaPct };
}

export interface IvBasis {
  /** what to call the implied-vol bar */
  label: string;
  /** the small line under it (the 7-day figure, or why the number is not a real 30-day one) */
  note: string | null;
  /** true when `note` is a warning */
  warn: boolean;
}

interface IvBasisInput {
  iv7: number | null;
  term: { expiry: string; dte: number; atmIV: number | null }[];
  curve?: VolCurve | null;
  skipped?: string[];
}

/**
 * "30-day IV" is only a month-out reading when the expiry curve reaches a month. constant_maturity_iv() stays flat beyond
 * the last expiry, so a symbol with one near expiry (SENSEX) shows the same number as front, 7-day and 30-day IV. Say so.
 * Without a `curve` (an older backend) it is taken as measured.
 */
export function ivBasis(d: IvBasisInput): IvBasis {
  const c = d.curve;
  if (!c || c.covers30) {
    const seven = c ? c.covers7 : d.iv7 != null;
    return { label: "30-day IV", note: seven && d.iv7 != null ? `7-day ${d.iv7.toFixed(1)}%` : null, warn: false };
  }
  const far = d.term.filter((t) => t.atmIV != null && t.dte > 0).sort((a, b) => b.dte - a.dte)[0];
  if (!far) return { label: "30-day IV", note: null, warn: false };
  const days = Math.round(c.maxDte ?? far.dte);
  const have = c.n === 1 ? "Only one expiry has data" : `Only ${c.n} expiries have data`;
  const lost = d.skipped?.length ?? 0;
  return {
    label: `IV to ${far.expiry} (${Math.round(far.dte)}d)`,
    note: `${have} (out to ${days} day${days === 1 ? "" : "s"}): not a true 30-day reading${lost ? `; ${lost} more could not be loaded` : ""}.`,
    warn: true,
  };
}
