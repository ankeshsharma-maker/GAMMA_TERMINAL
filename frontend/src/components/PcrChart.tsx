import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { nf } from "../lib/format";
import { istTime } from "../lib/istTime";
import { niceTicks, readPcr, runs, sma, stats, toPoints, variants, type ZoneKey } from "../lib/pcr";
import type { PcrSeries } from "../types";
import { SelectMenu } from "./SelectMenu";

/* ------------------------------------------------------------------ */
/* PCR against the spot: the OI tab's PCR view                          */
/* Whole days for the indices (server archive), the last few hours for   */
/* any other symbol; three PCR variants, zones, a crosshair, and the     */
/* chart in plain words.                                                 */
/* ------------------------------------------------------------------ */

const SPOT = "#38bdf8";
const UP = "#4ade80";
const DOWN = "#f87171";
const COI = "#fbbf24";
const VOLC = "#c084fc";

const ZONE_TXT: Record<ZoneKey, string> = { vbull: "text-emerald-300", bull: "text-emerald-400", bear: "text-red-400", vbear: "text-red-300" };
const ZONE_CHIP: Record<ZoneKey, string> = {
  vbull: "border-emerald-500/50 bg-emerald-500/20 text-emerald-300",
  bull: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  bear: "border-red-500/30 bg-red-500/10 text-red-400",
  vbear: "border-red-500/50 bg-red-500/20 text-red-300",
};

const BUCKETS = [1, 5, 15] as const;
type Show = { coi: boolean; vol: boolean; smooth: boolean };
const LS_BUCKET = "pcr.bucket";
const LS_SHOW = "pcr.show";

const lsGet = <T,>(key: string, fallback: T, ok: (v: unknown) => boolean): T => {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return ok(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
};
const lsSet = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode */
  }
};

const dayLabel = (day: string, today: boolean): string =>
  new Date(`${day}T12:00:00+05:30`).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "Asia/Kolkata" }) +
  (today ? " · today" : "");

export function PcrChart({ symbol, isMobile }: { symbol: string; isMobile: boolean }) {
  const [day, setDay] = useState<string | null>(null);
  const [bucket, setBucket] = useState<number>(() => lsGet(LS_BUCKET, 5, (v) => BUCKETS.includes(v as 1 | 5 | 15)));
  const [show, setShow] = useState<Show>(() =>
    lsGet<Show>(LS_SHOW, { coi: false, vol: false, smooth: true }, (v) => !!v && typeof v === "object" && "smooth" in (v as object))
  );
  const [data, setData] = useState<PcrSeries | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const liveRef = useRef(false);

  useEffect(() => setDay(null), [symbol]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.pcr(symbol, day, bucket).then(
        (d) => {
          if (!alive) return;
          liveRef.current = d.live;
          setData(d);
          setErr(null);
        },
        (e) => alive && setErr(String(e?.message ?? e))
      );
    load();
    const id = window.setInterval(() => !document.hidden && liveRef.current && load(), 20000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [symbol, day, bucket]);

  const fresh = data && data.symbol === symbol.toUpperCase() ? data : null;
  const pts = useMemo(() => (fresh ? toPoints(fresh) : []), [fresh]);
  const ser = useMemo(() => {
    const v = pts.map(variants);
    const oi = v.map((x) => x.oi);
    return { oi, coi: v.map((x) => x.coi), vol: v.map((x) => x.vol), smooth: sma(oi, 3) };
  }, [pts]);

  const pickBucket = (b: number) => {
    setBucket(b);
    lsSet(LS_BUCKET, b);
  };
  const toggle = (k: keyof Show) => {
    const n = { ...show, [k]: !show[k] };
    setShow(n);
    lsSet(LS_SHOW, n);
  };

  // ---- chart size follows its box ----
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const set = () => setW(Math.max(280, Math.round(el.clientWidth)));
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pts.length > 1]);

  const mainH = isMobile ? 270 : 340;
  const subH = show.coi ? 84 : 0; // the change-in-OI panel under the main plot
  const H = mainH + (subH ? subH + 22 : 0);
  const m = { l: 44, r: 56, t: 10, b: 22 };
  const plotH = mainH - m.t - m.b;
  const yBot = mainH - m.b;
  const subTop = mainH + 12;

  const geo = useMemo(() => {
    if (pts.length < 2) return null;
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const x = (t: number) => m.l + ((t - t0) / (t1 - t0 || 1)) * (w - m.l - m.r);
    // the left scale covers the middle 96% of everything shown (a spike must not flatten the line) and always includes 1.0
    const all: number[] = [1];
    ser.oi.forEach((v) => v != null && all.push(v));
    if (show.vol) ser.vol.forEach((v) => v != null && all.push(v));
    all.sort((a, b) => a - b);
    let lo = all[Math.floor(0.02 * (all.length - 1))];
    let hi = all[Math.ceil(0.98 * (all.length - 1))];
    lo = Math.min(lo, 1);
    hi = Math.max(hi, 1);
    const pad = (hi - lo) * 0.12 || 0.1;
    lo = Math.max(0, lo - pad);
    hi += pad;
    const y = (v: number) => m.t + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1)) * plotH;
    const sp = pts.map((p) => p.spot).filter((v): v is number => v != null);
    let slo = Math.min(...sp);
    let shi = Math.max(...sp);
    const sPad = (shi - slo) * 0.15 || shi * 0.001 || 1;
    slo -= sPad;
    shi += sPad;
    const ys = (v: number) => m.t + (1 - (v - slo) / (shi - slo || 1)) * plotH;
    // the change-in-OI panel: 0 .. its 95th percentile (rounded up to a half), capped at 5 so one early spike cannot flatten it
    const cv = ser.coi.filter((v): v is number => v != null).sort((a, b) => a - b);
    const p95 = cv.length ? cv[Math.min(cv.length - 1, Math.floor(0.95 * (cv.length - 1)))] : 2;
    const chi = Math.min(5, Math.max(2, Math.ceil(p95 * 1.1 * 2) / 2));
    const yc = (v: number) => subTop + (1 - Math.min(chi, Math.max(0, v)) / chi) * subH;
    const span = (t1 - t0) / 60;
    const step = (span <= 100 ? 15 : span <= 200 ? 30 : 60) * 60;
    const xt: number[] = [];
    for (let t = Math.ceil((t0 + 19800) / step) * step - 19800; t <= t1; t += step) xt.push(t);
    return { t0, t1, x, y, ys, yc, chi, lo, hi, slo, shi, xt, yt: niceTicks(lo, hi, 4), st: niceTicks(slo, shi, 3), ct: niceTicks(0, chi, 2) };
  }, [pts, ser, show, w, plotH, subTop, subH]); // eslint-disable-line react-hooks/exhaustive-deps

  const rs = useMemo(() => runs(pts), [pts]);
  const info = useMemo(() => ({ read: readPcr(pts), st: stats(pts) }), [pts]);

  const header = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      <span className="font-semibold text-term-text">{symbol} · PCR vs Price</span>
      {fresh && fresh.days.length > 0 && (
        <SelectMenu
          value={fresh.day}
          options={fresh.days.map((d, i) => [dayLabel(d, i === 0 && fresh.live), d] as [string, string])}
          onChange={(d) => setDay(d)}
          title="Trading day"
          width={150}
        />
      )}
      <div className="seg text-[10px]" title="Each point is the last reading of this many minutes">
        {BUCKETS.map((b) => (
          <button key={b} className={bucket === b ? "on" : ""} onClick={() => pickBucket(b)}>
            {b}m
          </button>
        ))}
      </div>
      <button className={`chipbtn ${show.smooth ? "on" : ""}`} onClick={() => toggle("smooth")} aria-pressed={show.smooth} title="Add a 3-point moving average">
        Smooth
      </button>
      <button
        className={`chipbtn ${show.coi ? "on" : ""}`}
        onClick={() => toggle("coi")}
        aria-pressed={show.coi}
        title="Put OI added today / call OI added today: where the NEW positions are going"
      >
        <span style={{ color: COI }}>●</span> Change-in-OI PCR
      </button>
      <button
        className={`chipbtn ${show.vol ? "on" : ""}`}
        onClick={() => toggle("vol")}
        aria-pressed={show.vol}
        title="Put volume / call volume traded today"
      >
        <span style={{ color: VOLC }}>●</span> Volume PCR
      </button>
    </div>
  );

  if (err && !fresh) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {header}
        <div className="mt-3 rounded border border-down/40 bg-down/10 px-3 py-2 text-xs text-red-300">Couldn't load the PCR history: {err}</div>
      </div>
    );
  }
  if (!fresh || pts.length < 2) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {header}
        <div className="mt-3 flex items-center justify-center rounded border border-dashed border-term-border px-3 py-10 text-center text-xs text-term-dim">
          {fresh ? `Collecting PCR history for ${symbol}… it fills in as the market is polled (a few minutes).` : `Loading ${symbol}…`}
        </div>
      </div>
    );
  }

  const { read, st } = info;
  const last = pts[pts.length - 1];
  const first = pts.find((p) => p.spot != null);
  const spotChg = first && last.spot != null && first.spot ? (last.spot / first.spot - 1) * 100 : null;
  const hp = hover != null ? pts[hover] : null;
  const hv = hover != null ? { oi: ser.oi[hover], sm: ser.smooth[hover], coi: ser.coi[hover], vol: ser.vol[hover] } : null;

  const line = (vals: (number | null)[], yf: (v: number) => number): string => {
    if (!geo) return "";
    let d = "";
    for (const [a, b] of rs) {
      let pen = false;
      for (let i = a; i <= b; i++) {
        const v = vals[i];
        if (v == null) {
          pen = false;
          continue;
        }
        d += `${pen ? "L" : "M"}${geo.x(pts[i].t).toFixed(1)},${yf(v).toFixed(1)}`;
        pen = true;
      }
    }
    return d;
  };

  const onMove = (ev: React.PointerEvent<SVGSVGElement>) => {
    if (!geo) return;
    const r = ev.currentTarget.getBoundingClientRect();
    const px = ev.clientX - r.left;
    let bi = 0;
    let bd = Infinity;
    pts.forEach((p, i) => {
      const dd = Math.abs(geo.x(p.t) - px);
      if (dd < bd) {
        bd = dd;
        bi = i;
      }
    });
    setHover(bi);
  };

  const oiNow = ser.oi[ser.oi.length - 1];
  const tipLeft = hp && geo ? (geo.x(hp.t) > w * 0.62 ? geo.x(hp.t) - 168 : geo.x(hp.t) + 12) : 0;

  return (
    <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
      {header}

      {/* the number, its zone, and the day's range */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className={`num text-2xl font-bold ${read.zone ? ZONE_TXT[read.zone.key] : ""}`}>{oiNow != null ? nf(oiNow, 2) : "–"}</span>
        {read.zone && <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${ZONE_CHIP[read.zone.key]}`}>{read.zone.label.toUpperCase()}</span>}
        {st && (
          <span className="num text-xs text-term-dim">
            open {nf(st.open, 2)} · low {nf(st.lo, 2)} · high {nf(st.hi, 2)} · avg {nf(st.avg, 2)}
          </span>
        )}
        <span className="num text-xs" style={{ color: SPOT }}>
          {symbol} {last.spot != null ? nf(last.spot, 1) : "–"}
          {spotChg != null && (
            <span className={spotChg >= 0 ? "text-emerald-400" : "text-red-400"}>
              {" "}
              ({spotChg >= 0 ? "+" : "−"}
              {Math.abs(spotChg).toFixed(2)}% on the day)
            </span>
          )}
        </span>
      </div>

      {/* the chart in words */}
      <div className="rounded-lg border border-term-border bg-term-panel px-3 py-2">
        <div className="text-xs font-semibold text-term-text">{read.headline}</div>
        {read.detail && <div className="mt-0.5 text-[11px] leading-snug text-term-dim">{read.detail}</div>}
      </div>

      {/* the chart */}
      <div className="relative rounded-lg border border-term-border bg-term-panel px-1 py-1" ref={box}>
        {geo && (
          <>
            <svg
              width={w - 8}
              height={H}
              viewBox={`0 0 ${w - 8} ${H}`}
              role="img"
              aria-label={`${symbol} put-call ratio against the spot price`}
              className="block select-none"
              style={{ touchAction: "pan-y" }}
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={() => setHover(null)}
            >
              <defs>
                <linearGradient id="pcrSide" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={m.t} y2={m.t + plotH}>
                  <stop offset={Math.min(1, Math.max(0, (geo.y(1) - m.t) / plotH))} stopColor={UP} />
                  <stop offset={Math.min(1, Math.max(0, (geo.y(1) - m.t) / plotH))} stopColor={DOWN} />
                </linearGradient>
              </defs>

              {/* zones: put-heavy above 1, call-heavy below; 1.3 / 0.7 are the extremes */}
              {(
                [
                  [1.3, 99, UP, 0.09],
                  [1.0, 1.3, UP, 0.045],
                  [0.7, 1.0, DOWN, 0.045],
                  [0, 0.7, DOWN, 0.09],
                ] as [number, number, string, number][]
              ).map(([a, b, c, o], i) => {
                const top = geo.y(Math.min(b, geo.hi));
                const bot = geo.y(Math.max(a, geo.lo));
                return bot > top ? <rect key={i} x={m.l} y={top} width={w - 8 - m.l - m.r} height={bot - top} fill={c} opacity={o} /> : null;
              })}
              {[1.3, 1.0, 0.7]
                .filter((v) => v > geo.lo && v < geo.hi)
                .map((v) => (
                  <line key={v} x1={m.l} x2={w - 8 - m.r} y1={geo.y(v)} y2={geo.y(v)} stroke={v === 1 ? "#eab308" : "currentColor"} strokeOpacity={v === 1 ? 0.85 : 0.25} strokeDasharray={v === 1 ? "4 3" : "2 4"} className="text-term-dim" />
                ))}

              {/* left axis: PCR */}
              {geo.yt.map((v) => (
                <text key={v} x={m.l - 5} y={geo.y(v) + 3} textAnchor="end" fontSize={10} fill="currentColor" className="text-term-dim">
                  {v.toFixed(v < 10 && v % 1 ? 2 : 0)}
                </text>
              ))}
              {/* right axis: spot */}
              {geo.st.map((v) => (
                <text key={v} x={w - 8 - m.r + 5} y={geo.ys(v) + 3} fontSize={10} fill={SPOT} opacity={0.85}>
                  {nf(v, 0)}
                </text>
              ))}
              {/* time axis (IST) */}
              {geo.xt.map((t) => (
                <g key={t}>
                  <line x1={geo.x(t)} x2={geo.x(t)} y1={m.t} y2={yBot} stroke="currentColor" strokeOpacity={0.07} className="text-term-dim" />
                  <text x={geo.x(t)} y={mainH - 6} textAnchor="middle" fontSize={10} fill="currentColor" className="text-term-dim">
                    {istTime(t)}
                  </text>
                </g>
              ))}
              {/* the front expiry rolled: a different set of contracts starts here */}
              {rs.slice(1).map(([a], i) => (
                <g key={i}>
                  <line x1={geo.x(pts[a].t)} x2={geo.x(pts[a].t)} y1={m.t} y2={yBot} stroke="#94a3b8" strokeOpacity={0.5} strokeDasharray="3 3" />
                  <text x={geo.x(pts[a].t) + 3} y={m.t + 9} fontSize={9} fill="#94a3b8">
                    → {fresh.expiries[pts[a].ei ?? 0] ?? "next expiry"}
                  </text>
                </g>
              ))}

              <path d={line(pts.map((p) => p.spot), geo.ys)} fill="none" stroke={SPOT} strokeWidth={1.4} strokeOpacity={0.9} strokeLinejoin="round" />
              {show.vol && <path d={line(ser.vol, geo.y)} fill="none" stroke={VOLC} strokeWidth={1.4} strokeOpacity={0.9} />}
              {show.coi && (
                <g>
                  <rect x={m.l} y={subTop} width={w - 8 - m.l - m.r} height={subH} fill="currentColor" opacity={0.04} className="text-term-dim" />
                  {geo.ct.map((v) => (
                    <g key={v}>
                      <line x1={m.l} x2={w - 8 - m.r} y1={geo.yc(v)} y2={geo.yc(v)} stroke={v === 1 ? "#eab308" : "currentColor"} strokeOpacity={v === 1 ? 0.7 : 0.12} strokeDasharray={v === 1 ? "4 3" : undefined} className="text-term-dim" />
                      <text x={m.l - 5} y={geo.yc(v) + 3} textAnchor="end" fontSize={10} fill="currentColor" className="text-term-dim">
                        {v}
                      </text>
                    </g>
                  ))}
                  {geo.chi >= 1 && geo.ct.indexOf(1) < 0 && (
                    <line x1={m.l} x2={w - 8 - m.r} y1={geo.yc(1)} y2={geo.yc(1)} stroke="#eab308" strokeOpacity={0.7} strokeDasharray="4 3" />
                  )}
                  <path d={line(ser.coi, geo.yc)} fill="none" stroke={COI} strokeWidth={1.6} strokeOpacity={0.95} strokeLinejoin="round" />
                  <text x={m.l + 4} y={subTop + 11} fontSize={10} fill={COI}>
                    Change-in-OI PCR · where new positions go
                  </text>
                </g>
              )}
              {show.smooth && <path d={line(ser.oi, geo.y)} fill="none" stroke="url(#pcrSide)" strokeWidth={1} strokeOpacity={0.4} />}
              <path d={line(show.smooth ? ser.smooth : ser.oi, geo.y)} fill="none" stroke="url(#pcrSide)" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
              {oiNow != null && <circle cx={geo.x(last.t)} cy={geo.y(oiNow)} r={3.5} fill={oiNow >= 1 ? UP : DOWN} />}
              {last.spot != null && <circle cx={geo.x(last.t)} cy={geo.ys(last.spot)} r={3} fill={SPOT} />}

              {hp && hv && (
                <g>
                  <line x1={geo.x(hp.t)} x2={geo.x(hp.t)} y1={m.t} y2={subH ? subTop + subH : yBot} stroke="#e2e8f0" strokeOpacity={0.5} strokeDasharray="2 3" />
                  {hp.spot != null && <circle cx={geo.x(hp.t)} cy={geo.ys(hp.spot)} r={3.5} fill={SPOT} stroke="#0f141d" />}
                  {hv.oi != null && <circle cx={geo.x(hp.t)} cy={geo.y(show.smooth && hv.sm != null ? hv.sm : hv.oi)} r={3.5} fill={hv.oi >= 1 ? UP : DOWN} stroke="#0f141d" />}
                  {show.coi && hv.coi != null && <circle cx={geo.x(hp.t)} cy={geo.yc(hv.coi)} r={3} fill={COI} stroke="#0f141d" />}
                  {show.vol && hv.vol != null && <circle cx={geo.x(hp.t)} cy={geo.y(hv.vol)} r={3} fill={VOLC} stroke="#0f141d" />}
                </g>
              )}
            </svg>
            {hp && hv && (
              <div
                className="pointer-events-none absolute top-2 z-10 w-40 rounded border border-term-border bg-term-bg/95 px-2 py-1.5 text-[10px] leading-snug shadow-lg"
                style={{ left: tipLeft + 4 }}
              >
                <div className="num font-semibold text-term-text">{istTime(hp.t)} IST</div>
                <div className="num" style={{ color: SPOT }}>
                  {symbol} {hp.spot != null ? nf(hp.spot, 1) : "–"}
                </div>
                <div className="num text-term-text">PCR {hv.oi != null ? nf(hv.oi, 2) : "–"}</div>
                {show.coi && (
                  <div className="num" style={{ color: COI }}>
                    Change-in-OI {hv.coi != null ? nf(hv.coi, 2) : "–"}
                  </div>
                )}
                {show.vol && (
                  <div className="num" style={{ color: VOLC }}>
                    Volume {hv.vol != null ? nf(hv.vol, 2) : "–"}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="space-y-1 px-1 text-[10px] leading-snug text-term-dim">
        <div>
          <span style={{ color: SPOT }}>━</span> {symbol} price (right axis) · <span className="text-emerald-400">━</span> PCR above 1 (more puts) ·{" "}
          <span className="text-red-400">━</span> PCR below 1 (more calls) · shading: 1.3 and 0.7 mark the extremes. Change-in-OI PCR (lower panel) = put OI
          added today / call OI added today: above 1 means more puts are being added.
        </div>
        <div>
          Above 1 = more puts than calls open (supportive); below 1 = more calls (resistance). A very high or very low reading can also be a crowded bet,
          so what matters most is which way it is moving. A rule of thumb, not a signal.
        </div>
        {fresh.source === "live" && (
          <div>
            Only the last few hours are kept for {symbol}. NIFTY, BANKNIFTY, FINNIFTY and SENSEX keep whole days, and earlier days too.
          </div>
        )}
      </div>
    </div>
  );
}
