import type { ChainRow } from "../types";

/** Gamma flip: the strike where cumulative dealer gamma exposure crosses
 *  zero. Dealer gamma proxy per strike = putGamma·putOI − callGamma·callOI
 *  (dealers long puts / short calls from customer flow). Below the flip
 *  dealers are short gamma (moves amplified), above it long gamma.
 *
 *  `rows` should be sorted by strike ascending -- pass the full chain
 *  (`chain.rows`), not just whatever strike window is currently zoomed into
 *  on screen: a narrower slice makes the crossing point jump around (or
 *  vanish) purely because the window changed, not because dealer
 *  positioning did. Same formula as backend/app/processing.py's
 *  `gamma_flip`, kept in sync with it.
 *
 *  When call/put gamma exposure is roughly balanced near the money the
 *  cumulative curve can cross zero at several strikes; the first one
 *  (ascending) is arbitrary and noise-sensitive -- a small OI tick at any
 *  strike in that band relocates "first" to a different level between
 *  refreshes. `spot` picks the crossing nearest the current price instead,
 *  which is both the economically relevant one and stable against noise
 *  away from spot. */
export function computeGammaFlip(rows: ChainRow[], spot: number): { strike: number; index: number } | null {
  if (rows.length < 2) return null;
  let cum = 0;
  const crossings: { strike: number; index: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = cum;
    cum += (r.put.gamma ?? 0) * (r.put.oi ?? 0) - (r.call.gamma ?? 0) * (r.call.oi ?? 0);
    if (i > 0 && prev !== 0 && Math.sign(cum) !== Math.sign(prev)) {
      const t = Math.abs(prev) / (Math.abs(prev) + Math.abs(cum) || 1);
      const k0 = rows[i - 1].strike;
      crossings.push({ strike: k0 + (r.strike - k0) * t, index: i - 1 + t });
    }
  }
  if (!crossings.length) return null;
  return crossings.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a));
}
