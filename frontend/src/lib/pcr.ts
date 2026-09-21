/**
 * PCR (put/call ratio) maths for the OI tab's PCR chart. Pure functions; the server (pcr_series.py) sends raw totals per
 * time bucket and everything else -- the three PCR variants, smoothing, the zone, the plain-words read -- is derived here.
 */
import type { PcrSeries } from "../types";

export interface PcrPoint {
  t: number;
  spot: number | null;
  /** total-OI PCR (puts / calls open interest) */
  pcr: number | null;
  ceOI: number | null;
  peOI: number | null;
  ceOIChg: number | null;
  peOIChg: number | null;
  ceVol: number | null;
  peVol: number | null;
  /** index into the day's expiry table (breaks the line when the front expiry rolls) */
  ei: number | null;
}

/** the server sends points as arrays in `fields` order */
export function toPoints(s: Pick<PcrSeries, "fields" | "points">): PcrPoint[] {
  const ix = (k: string) => s.fields.indexOf(k);
  const cols = ["t", "spot", "pcr", "ceOI", "peOI", "ceOIChg", "peOIChg", "ceVol", "peVol", "ei"].map(ix);
  return s.points.map((r) => ({
    t: r[cols[0]] as number,
    spot: r[cols[1]] as number | null,
    pcr: r[cols[2]] as number | null,
    ceOI: r[cols[3]] as number | null,
    peOI: r[cols[4]] as number | null,
    ceOIChg: r[cols[5]] as number | null,
    peOIChg: r[cols[6]] as number | null,
    ceVol: r[cols[7]] as number | null,
    peVol: r[cols[8]] as number | null,
    ei: r[cols[9]] as number | null,
  }));
}

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** The three ratios. Each is null when it cannot be read honestly (a zero or negative denominator, a tiny early-morning base). */
export function variants(p: PcrPoint): { oi: number | null; coi: number | null; vol: number | null } {
  const oi = fin(p.pcr) ? p.pcr : fin(p.ceOI) && p.ceOI > 0 && fin(p.peOI) ? p.peOI / p.ceOI : null;
  // change in OI since yesterday's close: only meaningful once calls AND puts have both been added, and the base is not tiny
  const coi =
    fin(p.ceOIChg) && fin(p.peOIChg) && fin(p.ceOI) && p.ceOIChg > 0 && p.peOIChg > 0 && p.ceOIChg >= 0.002 * p.ceOI
      ? p.peOIChg / p.ceOIChg
      : null;
  const vol = fin(p.ceVol) && fin(p.peVol) && p.ceVol > 0 ? p.peVol / p.ceVol : null;
  return { oi, coi, vol };
}

/** Trailing moving average over `n` samples, ignoring gaps; null until there is at least one value in the window. */
export function sma(values: (number | null)[], n: number): (number | null)[] {
  return values.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) {
      const v = values[j];
      if (v != null) {
        s += v;
        c++;
      }
    }
    return c ? s / c : null;
  });
}

export type ZoneKey = "vbull" | "bull" | "bear" | "vbear";
export interface Zone {
  key: ZoneKey;
  label: string;
  /** one plain sentence on what that level usually means */
  note: string;
}

/** Above 1 there are more puts open than calls (supportive); below 1 more calls (resistance). 1.3 / 0.7 mark the extremes. */
export function zoneOf(pcr: number): Zone {
  if (pcr >= 1.3) return { key: "vbull", label: "Very put-heavy", note: "strong put support, but also a crowded bullish bet" };
  if (pcr >= 1.0) return { key: "bull", label: "Put-heavy", note: "more puts than calls: supportive" };
  if (pcr >= 0.7) return { key: "bear", label: "Call-heavy", note: "more calls than puts: resistance overhead" };
  return { key: "vbear", label: "Very call-heavy", note: "heavy call writing overhead, or an oversold market" };
}

/** the point closest to `t` among those at or before it (null when the series starts later) */
export function at(pts: PcrPoint[], t: number): PcrPoint | null {
  let best: PcrPoint | null = null;
  for (const p of pts) {
    if (p.t <= t) best = p;
    else break;
  }
  return best;
}

export interface Stats {
  open: number;
  lo: number;
  hi: number;
  avg: number;
  last: number;
}

export function stats(pts: PcrPoint[]): Stats | null {
  const v = pts.map((p) => variants(p).oi).filter(fin);
  if (!v.length) return null;
  return { open: v[0], lo: Math.min(...v), hi: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length, last: v[v.length - 1] };
}

export interface Read {
  zone: Zone | null;
  /** e.g. "Put-heavy (1.32), up +0.06 in the last 30 min" */
  headline: string;
  /** what price and PCR doing together usually means, in one sentence; null when there is not enough to say */
  detail: string | null;
  dv: number | null;
  ds: number | null;
}

const SPAN_MIN = 30;
const PCR_MOVE = 0.03; // a PCR change under this in 30 minutes is "steady"
const SPOT_MOVE = 0.0015; // a spot move under 0.15% in 30 minutes is "flat"

/** The chart in words: where PCR is, which way it is moving, and what that says next to the price. A rule of thumb, not a signal. */
export function readPcr(pts: PcrPoint[]): Read {
  const last = pts[pts.length - 1];
  const now = last ? variants(last).oi : null;
  if (!last || now == null) return { zone: null, headline: "No PCR reading yet.", detail: null, dv: null, ds: null };
  const zone = zoneOf(now);
  const then = at(pts, last.t - SPAN_MIN * 60);
  const before = then ? variants(then).oi : null;
  if (!then || before == null || last.t - then.t < 10 * 60) {
    return { zone, headline: `${zone.label} (${now.toFixed(2)}): ${zone.note}.`, detail: "Not enough history yet to read a trend.", dv: null, ds: null };
  }
  const mins = Math.round((last.t - then.t) / 60);
  const dv = now - before;
  const ds = fin(last.spot) && fin(then.spot) && then.spot > 0 ? last.spot / then.spot - 1 : null;
  const dir = dv >= PCR_MOVE ? "up" : dv <= -PCR_MOVE ? "down" : "steady";
  const headline =
    `${zone.label} (${now.toFixed(2)}), ` +
    (dir === "steady" ? `steady over the last ${mins} min.` : `${dir} ${dv > 0 ? "+" : "−"}${Math.abs(dv).toFixed(2)} in the last ${mins} min.`);
  if (ds == null) return { zone, headline, detail: null, dv, ds };
  const move = ds >= SPOT_MOVE ? "up" : ds <= -SPOT_MOVE ? "down" : "flat";
  const detail = {
    "up|up": "Price is rising and PCR is rising: puts are being added as the price climbs, so the move has support underneath.",
    "up|down": "Price is rising but PCR is falling: calls are being added faster than puts, so the rally has less put support.",
    "down|up": "Price is falling but PCR is rising: puts are being added into the fall. That can be support building, or just hedging.",
    "down|down": "Price and PCR are both falling: calls are getting heavier as the price drops, so the move has resistance overhead.",
    "flat|up": "Price is flat while PCR rises: puts are quietly building underneath.",
    "flat|down": "Price is flat while PCR falls: calls are quietly building overhead.",
    "up|steady": "Price is rising with PCR steady: puts and calls are being added at about the same pace.",
    "down|steady": "Price is falling with PCR steady: puts and calls are being added at about the same pace.",
    "flat|steady": "Price and PCR are both steady.",
  }[`${move}|${dir}`] as string;
  return { zone, headline, detail, dv, ds };
}

/** Runs of consecutive points on the same expiry: the line is broken where the front expiry rolls (a different contract set). */
export function runs(pts: PcrPoint[]): [number, number][] {
  const out: [number, number][] = [];
  let a = 0;
  for (let i = 1; i <= pts.length; i++) {
    if (i === pts.length || pts[i].ei !== pts[i - 1].ei) {
      out.push([a, i - 1]);
      a = i;
    }
  }
  return out.filter(([x, y]) => y >= x);
}

/** "nice" axis ticks (1 / 2 / 5 x 10^n) covering [lo, hi] with about `n` steps */
export function niceTicks(lo: number, hi: number, n = 4): number[] {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let i = Math.ceil(lo / step - 1e-9); i * step <= hi + 1e-9; i++) out.push(Number((i * step).toFixed(6)));
  return out;
}
