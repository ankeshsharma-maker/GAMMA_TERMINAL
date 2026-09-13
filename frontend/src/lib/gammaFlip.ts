import type { ChainRow } from "../types";

/** Gamma flip: the strike where cumulative dealer gamma exposure crosses
 *  zero. Dealer gamma proxy per strike = putGamma·putOI − callGamma·callOI
 *  (dealers long puts / short calls from customer flow). Below the flip
 *  dealers are short gamma (moves amplified), above it long gamma.
 *
 *  `rows` should be sorted by strike ascending, same shape as OIProfile's
 *  own `rows` (the visible ±N-strike window — a `chain.rows` slice works
 *  too, just walks the whole chain instead of only what's on screen). */
export function computeGammaFlip(rows: ChainRow[]): { strike: number; index: number } | null {
  if (rows.length < 2) return null;
  let cum = 0;
  let prev = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    prev = cum;
    cum += (r.put.gamma ?? 0) * (r.put.oi ?? 0) - (r.call.gamma ?? 0) * (r.call.oi ?? 0);
    if (i > 0 && prev !== 0 && Math.sign(cum) !== Math.sign(prev)) {
      const t = Math.abs(prev) / (Math.abs(prev) + Math.abs(cum) || 1);
      const k0 = rows[i - 1].strike;
      return { strike: k0 + (r.strike - k0) * t, index: i - 1 + t };
    }
  }
  return null;
}
