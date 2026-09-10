import { useStore } from "../store";

/**
 * Tick-by-tick broker mark-to-market.
 *
 * The backend keeps every open position leg subscribed on the Flattrade
 * socket, re-marks each row's `urmtom` from the live ticks (anchored to the
 * broker's own PositionBook value) and pushes a `positions` message a couple
 * of times a second. This hook overlays that onto the REST PositionBook rows
 * the panels already render.
 *
 * `mark(row)` → the live urmtom for that row, or `null` when the live feed is
 * stale / missing / doesn't know the row, so callers fall back to the row's
 * own `urmtom`.
 */
export function useLiveMtm() {
  const live = useStore((s) => s.positionsLive);
  const fresh = !!live && Date.now() / 1000 - (live.feedTs || live.ts || 0) < 20;
  const byKey = new Map<string, number>();
  if (fresh && live) {
    for (const r of live.rows) {
      const k = String(r.token ?? r.tsym ?? "");
      const v = Number(r.urmtom ?? r.mtm);
      if (k && Number.isFinite(v)) byKey.set(k, v);
    }
  }
  const mark = (r: any): number | null => {
    if (!fresh) return null;
    const v = byKey.get(String(r.token ?? r.tsym ?? ""));
    return v === undefined ? null : v;
  };
  return { fresh, mark, total: fresh && live ? live.total : null };
}
