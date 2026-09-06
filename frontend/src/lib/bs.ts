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

/** Portfolio P&L across a price grid with `tRemYears` left to expiry.
 *  tRemYears = 0 -> expiry (intrinsic); = full DTE/365 -> "now (T+0)". */
export function strategyPnlCurve(
  legs: ResolvedLeg[],
  xs: number[],
  tRemYears: number
): number[] {
  const t = Math.max(tRemYears, 0);
  return xs.map((S) => {
    let total = 0;
    for (const leg of legs) {
      const sgn = leg.side === "BUY" ? 1 : -1;
      if (leg.optionType === "FUT") {
        total += sgn * (S - leg.entry) * leg.qty;
      } else {
        const px = bsPrice(leg.optionType, S, leg.strike, t, R, Q, (leg.iv || 0) / 100);
        total += sgn * (px - leg.entry) * leg.qty;
      }
    }
    return Math.round(total * 100) / 100;
  });
}
