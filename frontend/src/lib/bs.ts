// Dependency-free Black-Scholes-Merton pricing — mirrors backend app/greeks.py
// so the Builder can redraw a "time to expiry" payoff curve client-side without
// a round-trip on every slider tick.
import type { ResolvedLeg } from "../types";

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 7.5e-8). */
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/** European option price. `kind` is "CE"/"call" or "PE"/"put". */
export function bsPrice(
  kind: string,
  S: number,
  K: number,
  t: number,
  r: number,
  q: number,
  sigma: number
): number {
  const k = kind.toUpperCase();
  const call = k === "CE" || k === "CALL" || k === "C";
  if (t <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    return Math.max(call ? S - K : K - S, 0);
  }
  const vsqrt = sigma * Math.sqrt(t);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * t) / vsqrt;
  const d2 = d1 - vsqrt;
  const dfR = Math.exp(-r * t);
  const dfQ = Math.exp(-q * t);
  return call
    ? S * dfQ * normCdf(d1) - K * dfR * normCdf(d2)
    : K * dfR * normCdf(-d2) - S * dfQ * normCdf(-d1);
}

const R = 0.06; // matches backend RISK_FREE_RATE
const Q = 0.0; // matches backend DIVIDEND_YIELD

/** normal pdf */
const nPdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** Per-leg option greeks (per 1 unit of the underlying), trader units:
 *  delta per point, gamma per point, theta per calendar day, vega per 1 vol pt. */
export function bsGreeks(
  kind: string,
  S: number,
  K: number,
  t: number,
  sigma: number
): { delta: number; gamma: number; theta: number; vega: number } {
  const call = kind.toUpperCase().startsWith("C");
  if (t <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    const itm = call ? S > K : S < K;
    return { delta: itm ? (call ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const vsqrt = sigma * Math.sqrt(t);
  const d1 = (Math.log(S / K) + (R - Q + 0.5 * sigma * sigma) * t) / vsqrt;
  const d2 = d1 - vsqrt;
  const dfR = Math.exp(-R * t);
  const dfQ = Math.exp(-Q * t);
  const delta = call ? dfQ * normCdf(d1) : -dfQ * normCdf(-d1);
  const gamma = (dfQ * nPdf(d1)) / (S * vsqrt);
  const vega = (S * dfQ * nPdf(d1) * Math.sqrt(t)) / 100;
  const term1 = -(S * dfQ * nPdf(d1) * sigma) / (2 * Math.sqrt(t));
  const theta = call
    ? (term1 - R * K * dfR * normCdf(d2) + Q * S * dfQ * normCdf(d1)) / 365
    : (term1 + R * K * dfR * normCdf(-d2) - Q * S * dfQ * normCdf(-d1)) / 365;
  return { delta, gamma, theta, vega };
}

const _sgn = (side: string) => (side === "BUY" ? 1 : -1);

/** theoretical price of one leg at (S, tYears), optionally with IV shifted by `ivShiftPct` (%). */
export function legPriceAt(leg: ResolvedLeg, S: number, tYears: number, ivShiftPct = 0): number {
  if (leg.optionType === "FUT") return S;
  const iv = ivShiftPct ? Math.max(0.5, (leg.iv || 0) * (1 + ivShiftPct / 100)) : leg.iv || 0;
  return bsPrice(leg.optionType, S, leg.strike, Math.max(tYears, 0), R, Q, iv / 100);
}

/** rupee P&L of one leg at (S, tYears), optionally with IV shifted by `ivShiftPct` (%). */
export function legPnlAt(leg: ResolvedLeg, S: number, tYears: number, ivShiftPct = 0): number {
  if (leg.optionType === "FUT") return _sgn(leg.side) * (S - leg.entry) * leg.qty;
  return _sgn(leg.side) * (legPriceAt(leg, S, tYears, ivShiftPct) - leg.entry) * leg.qty;
}

/** intrinsic value of one option at S. */
export function intrinsicOf(kind: string, S: number, K: number): number {
  return Math.max(kind.toUpperCase().startsWith("C") ? S - K : K - S, 0);
}

/** position time value / intrinsic value at spot with `tRemYears` left.
 *  value = signed current theoretical value (liability for shorts). */
export function positionValue(legs: ResolvedLeg[], spot: number, tRemYears: number) {
  let value = 0;
  let intrinsic = 0;
  for (const leg of legs) {
    if (leg.optionType === "FUT") {
      value += _sgn(leg.side) * (spot - leg.entry) * leg.qty;
      continue;
    }
    value += _sgn(leg.side) * legPriceAt(leg, spot, tRemYears) * leg.qty;
    intrinsic += _sgn(leg.side) * intrinsicOf(leg.optionType, spot, leg.strike) * leg.qty;
  }
  return { value, intrinsic, timeValue: value - intrinsic };
}

/** Portfolio P&L across a price grid with `tRemYears` left to expiry.
 *  tRemYears = 0 -> expiry (intrinsic); = full DTE/365 -> "now (T+0)".
 *  `ivShiftPct` optionally shifts every leg's IV by that % (e.g. -20 = IV crush). */
export function strategyPnlCurve(
  legs: ResolvedLeg[],
  xs: number[],
  tRemYears: number,
  ivShiftPct = 0
): number[] {
  const t = Math.max(tRemYears, 0);
  return xs.map((S) => {
    let total = 0;
    for (const leg of legs) {
      const sgn = leg.side === "BUY" ? 1 : -1;
      if (leg.optionType === "FUT") {
        total += sgn * (S - leg.entry) * leg.qty;
      } else {
        const iv = ivShiftPct ? Math.max(0.5, (leg.iv || 0) * (1 + ivShiftPct / 100)) : leg.iv || 0;
        const px = bsPrice(leg.optionType, S, leg.strike, t, R, Q, iv / 100);
        total += sgn * (px - leg.entry) * leg.qty;
      }
    }
    return Math.round(total * 100) / 100;
  });
}
