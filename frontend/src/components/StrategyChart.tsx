import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type PriceFormat,
  type UTCTimestamp,
} from "lightweight-charts";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, signColor } from "../lib/format";
import { IST_LOCALIZATION, istDay, istTickFormatter, istTime } from "../lib/istTime";
import type { Analysis, GreekKey, StrategyChartData, StrategyLeg } from "../types";

/** Intraday charts of the strategy in the builder, straight from its legs:
 *  "premium" -- the combined price of all legs as candles (or the P&L curve);
 *  "greeks"  -- net + per-leg delta / gamma / theta / vega / IV through the day. */

const INTERVALS = [
  [60, "1m"],
  [180, "3m"],
  [300, "5m"],
  [900, "15m"],
] as const;
const DAYS = [
  [1, "1D"],
  [2, "2D"],
  [5, "5D"],
] as const;
const GREEKS: { key: GreekKey; sym: string; name: string; prec: number; unit: string; hint: string }[] = [
  { key: "delta", sym: "Δ", name: "Delta", prec: 1, unit: "", hint: "Directional exposure, in units of the underlying" },
  { key: "gamma", sym: "Γ", name: "Gamma", prec: 4, unit: "", hint: "How fast delta changes per point of spot" },
  { key: "theta", sym: "Θ", name: "Theta", prec: 0, unit: "₹/day", hint: "Time decay per calendar day" },
  { key: "vega", sym: "V", name: "Vega", prec: 0, unit: "₹/vol pt", hint: "P&L per 1 point move in IV" },
  { key: "iv", sym: "σ", name: "IV", prec: 2, unit: "%", hint: "Vega-weighted implied volatility of the legs" },
];
const LEG_COLORS = ["#f59e0b", "#a855f7", "#14b8a6", "#f472b6", "#84cc16", "#fb923c", "#22d3ee", "#e879f9"];
const NET = "#38bdf8";
const SPOT = "#3b82f6";
const MAX_LEG_LINES = 8;

type EntryMode = "position" | "open" | "click";
type View = "premium" | "pnl";

const lsGet = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};
const lsNum = <T extends number>(k: string, allowed: readonly (readonly [T, string])[], d: T): T => {
  const v = Number(lsGet(k, String(d)));
  return (allowed.find(([n]) => n === v)?.[0] ?? d) as T;
};

const legLabel = (l: { side: string; strike: number; optionType: string; lots: number }) =>
  `${l.side === "BUY" ? "B" : "S"} ${l.strike} ${l.optionType}${l.lots > 1 ? ` ×${l.lots}` : ""}`;

const rupee = (v: number) => `${v >= 0 ? "+" : "−"}₹${nf(Math.abs(v), 0)}`;

function Stat({ label, value, cls = "", title }: { label: string; value: string; cls?: string; title?: string }) {
  return (
    <div className="flex min-w-[76px] flex-col rounded border border-term-border px-2 py-1" title={title}>
      <span className="text-[9px] uppercase tracking-wide text-term-dim">{label}</span>
      <span className={`num text-xs font-semibold ${cls}`}>{value}</span>
    </div>
  );
}

export function StrategyChart({
  mode,
  symbol,
  expiry,
  legs,
  analysis,
  held,
}: {
  mode: "premium" | "greeks";
  symbol: string;
  expiry: string | null;
  /** legs as they'll be traded (already scaled by the lot multiplier) */
  legs: StrategyLeg[];
  analysis: Analysis | null;
  /** any leg is an already-open position, so its entry price is real */
  held: boolean;
}) {
  const chain = useStore((s) => s.chain);
  const optLegs = useMemo(
    () => legs.filter((l) => l.optionType !== "FUT" && l.lots > 0),
    [legs]
  );
  const hasFut = legs.some((l) => l.optionType === "FUT");
  const legKey = JSON.stringify(optLegs.map((l) => [l.optionType, l.strike, l.side, l.lots]));

  // ---- controls (persisted per viewer) ----
  const [interval, setIntervalS] = useState<number>(() => lsNum("sc.interval", INTERVALS, 300));
  const [days, setDays] = useState<number>(() => lsNum("sc.days", DAYS, 1));
  const [view, setView] = useState<View>(() => (lsGet("sc.view", "premium") === "pnl" ? "pnl" : "premium"));
  const [greek, setGreek] = useState<GreekKey>(() => {
    const g = lsGet("sc.greek", "delta");
    return (GREEKS.find((x) => x.key === g)?.key ?? "delta") as GreekKey;
  });
  const [showSpot, setShowSpot] = useState(() => lsGet("sc.spot", "1") === "1");
  const [showLegs, setShowLegs] = useState(() => lsGet("sc.legs", "0") === "1");
  const [entryMode, setEntryMode] = useState<EntryMode>(held ? "position" : "open");
  const [entryTime, setEntryTime] = useState<number | null>(null);
  useEffect(() => lsSet("sc.interval", String(interval)), [interval]);
  useEffect(() => lsSet("sc.days", String(days)), [days]);
  useEffect(() => lsSet("sc.view", view), [view]);
  useEffect(() => lsSet("sc.greek", greek), [greek]);
  useEffect(() => lsSet("sc.spot", showSpot ? "1" : "0"), [showSpot]);
  useEffect(() => lsSet("sc.legs", showLegs ? "1" : "0"), [showLegs]);

  // ---- data ----
  const [data, setData] = useState<StrategyChartData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    setData(null);
    setErr(null);
    if (!optLegs.length || !symbol || !expiry) return;
    let alive = true;
    const load = () =>
      api
        .strategyChart({
          symbol,
          expiry,
          legs: optLegs.map(({ optionType, strike, side, lots }) => ({ optionType, strike, side, lots })),
          interval,
          days,
        })
        .then((d) => {
          if (!alive) return;
          setData(d);
          setErr(null);
        })
        .catch((e) => alive && setErr(String(e?.message ?? e)));
    load();
    // the server caches for a few seconds; the live tail is nudged from the chain in between
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, expiry, legKey, interval, days, reloadTick]);

  // the price each leg was (or would be) entered at: the analysis' resolved entry per leg
  const entryPx = useMemo(() => {
    if (!data || !analysis) return null;
    const out = data.legs.map(
      (dl) =>
        analysis.legs.find(
          (al) => al.optionType === dl.optionType && al.strike === dl.strike && al.side === dl.side
        )?.entry
    );
    return out.every((v) => v != null && v > 0) ? (out as number[]) : null;
  }, [data, analysis]);

  // keyed by value: `analysis` is re-fetched every few seconds for a held position and would
  // otherwise redraw the whole chart each time although no entry price changed
  const entryKey = entryPx ? entryPx.join(",") : "";
  useEffect(() => setEntryTime(null), [legKey, symbol]);

  const derived = useMemo(() => {
    if (!data || !data.times.length) return null;
    const n = data.times.length;
    const w = data.legs.map((l) => (l.side === "BUY" ? 1 : -1) * l.lots);
    const V = data.times.map((_, i) => data.legs.reduce((a, l, j) => a + w[j] * l.close[i], 0));
    const lastDay = istDay(data.times[n - 1]);
    let day0 = n - 1;
    while (day0 > 0 && istDay(data.times[day0 - 1]) === lastDay) day0--;

    let entry: number[] | null = null;
    let effective: EntryMode = "open";
    let markerTime: number | null = null;
    if (entryMode === "position" && entryPx) {
      entry = entryPx;
      effective = "position";
    } else if (entryMode === "click" && entryTime != null) {
      let ie = 0;
      for (let i = 0; i < n; i++) if (data.times[i] <= entryTime) ie = i;
      entry = data.legs.map((l) => l.close[ie]);
      effective = "click";
      markerTime = data.times[ie];
    }
    if (!entry) entry = data.legs.map((l) => l.close[day0]);
    const entryV = entry.reduce((a, p, j) => a + w[j] * p, 0);
    return {
      n,
      V,
      pnl: V.map((v) => (v - entryV) * data.lotSize),
      entryV,
      entryPlot: data.sign * entryV,
      effective,
      markerTime,
      day0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, entryMode, entryTime, entryKey]);

  // ---- live tail from the chain (premium / P&L only) ----
  const live = useMemo(() => {
    if (!data || !chain || chain.symbol !== data.symbol || chain.expiry !== data.expiry) return null;
    let v = 0;
    for (const l of data.legs) {
      const row = chain.rows.find((r) => r.strike === l.strike);
      const px = row ? (l.optionType === "CE" ? row.call.ltp : row.put.ltp) : 0;
      if (!px || px <= 0) return null;
      v += (l.side === "BUY" ? 1 : -1) * l.lots * px;
    }
    return v;
  }, [data, chain]);

  // ---- chart ----
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const serRef = useRef<{
    cand: ISeriesApi<"Candlestick">;
    pnl: ISeriesApi<"Baseline">;
    spot: ISeriesApi<"Line">;
    net: ISeriesApi<"Line">;
    legs: ISeriesApi<"Line">[];
  } | null>(null);
  const idxRef = useRef<Map<number, number>>(new Map());
  const entryModeRef = useRef(entryMode);
  entryModeRef.current = entryMode;
  const frameRef = useRef("");
  const lineRef = useRef<{ entry?: IPriceLine; zero?: IPriceLine }>({});
  const nudgeRef = useRef<{ t: number; hi: number; lo: number } | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const chart = createChart(wrapRef.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#7a8699" },
      grid: { vertLines: { color: "#141c27" }, horzLines: { color: "#141c27" } },
      crosshair: { mode: CrosshairMode.Normal },
      localization: IST_LOCALIZATION,
      rightPriceScale: { borderColor: "#1e2733" },
      leftPriceScale: { visible: false, borderColor: "#1e2733" },
      timeScale: {
        borderColor: "#1e2733",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: istTickFormatter,
      },
      autoSize: true,
    });
    chartRef.current = chart;
    serRef.current = {
      cand: chart.addCandlestickSeries({
        upColor: "#16a34a",
        downColor: "#dc2626",
        borderVisible: false,
        wickUpColor: "#16a34a",
        wickDownColor: "#dc2626",
      }),
      pnl: chart.addBaselineSeries({
        baseValue: { type: "price", price: 0 },
        topLineColor: "#16a34a",
        topFillColor1: "rgba(22,163,74,0.28)",
        topFillColor2: "rgba(22,163,74,0.02)",
        bottomLineColor: "#dc2626",
        bottomFillColor1: "rgba(220,38,38,0.02)",
        bottomFillColor2: "rgba(220,38,38,0.28)",
        lineWidth: 2,
      }),
      spot: chart.addLineSeries({
        priceScaleId: "left",
        color: SPOT,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      }),
      net: chart.addLineSeries({ color: NET, lineWidth: 2 }),
      legs: LEG_COLORS.slice(0, MAX_LEG_LINES).map((color) =>
        chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
      ),
    };
    chart.subscribeCrosshairMove((p) => {
      const i = p.time != null ? idxRef.current.get(p.time as number) : undefined;
      setHoverIdx(i ?? null);
    });
    chart.subscribeClick((p) => {
      if (entryModeRef.current === "click" && p.time != null) setEntryTime(p.time as number);
    });
    return () => {
      chart.remove();
      chartRef.current = null;
      serRef.current = null;
      lineRef.current = {};
    };
  }, []);

  // draw
  useEffect(() => {
    const chart = chartRef.current;
    const S = serRef.current;
    if (!chart || !S) return;
    const clearAll = () => {
      S.cand.setData([]);
      S.pnl.setData([]);
      S.spot.setData([]);
      S.net.setData([]);
      S.legs.forEach((s) => s.setData([]));
      S.cand.setMarkers([]);
      S.pnl.setMarkers([]);
    };
    const dropLine = (k: "entry" | "zero", owner: ISeriesApi<any>) => {
      const l = lineRef.current[k];
      if (l) {
        try {
          owner.removePriceLine(l);
        } catch {
          /* series already rebuilt */
        }
        lineRef.current[k] = undefined;
      }
    };
    dropLine("entry", S.cand);
    dropLine("zero", S.net);
    clearAll();
    idxRef.current = new Map();
    nudgeRef.current = null;
    if (!data || !derived) {
      chart.priceScale("left").applyOptions({ visible: false });
      return;
    }

    const T = data.times as UTCTimestamp[];
    T.forEach((t, i) => idxRef.current.set(t, i));
    const pts = (vals: (number | null)[]) => {
      const out: { time: UTCTimestamp; value: number }[] = [];
      for (let i = 0; i < T.length; i++) {
        const v = vals[i];
        if (v != null) out.push({ time: T[i], value: v });
      }
      return out;
    };
    // the right-hand scale labels itself with the format of the FIRST series on it, so the
    // format has to go on all of them, not just the one that has data in this view
    const setFormat = (f: PriceFormat) =>
      [S.cand, S.pnl, S.net, ...S.legs].forEach((s) => s.applyOptions({ priceFormat: f }));
    const decimals = (prec: number): PriceFormat => ({
      type: "price",
      precision: prec,
      minMove: 1 / 10 ** prec,
    });
    const rupees: PriceFormat = {
      type: "custom",
      formatter: (v: number) => (v < 0 ? `-₹${nf(-v, 0)}` : `₹${nf(v, 0)}`),
      minMove: 1,
    };

    const hasSpot = showSpot && data.spot.some((v) => v != null);
    S.spot.setData(hasSpot ? pts(data.spot) : []);
    chart.priceScale("left").applyOptions({ visible: hasSpot });

    if (mode === "premium") {
      setFormat(view === "pnl" ? rupees : decimals(2));
      if (view === "premium") {
        const P = data.premium;
        S.cand.setData(
          T.map((time, i) => ({ time, open: P.open[i], high: P.high[i], low: P.low[i], close: P.close[i] }))
        );
        lineRef.current.entry = S.cand.createPriceLine({
          price: derived.entryPlot,
          color: "#eab308",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "Entry",
        });
        if (showLegs) {
          data.legs.slice(0, MAX_LEG_LINES).forEach((l, j) =>
            S.legs[j].setData(pts(l.close.map((v) => v * l.lots)))
          );
        }
        if (derived.markerTime != null)
          S.cand.setMarkers([
            { time: derived.markerTime as UTCTimestamp, position: "belowBar", color: "#eab308", shape: "arrowUp", text: "Entry" },
          ]);
      } else {
        S.pnl.setData(T.map((time, i) => ({ time, value: derived.pnl[i] })));
        if (derived.markerTime != null)
          S.pnl.setMarkers([
            { time: derived.markerTime as UTCTimestamp, position: "belowBar", color: "#eab308", shape: "arrowUp", text: "Entry" },
          ]);
      }
    } else if (data.greeks) {
      const g = data.greeks;
      const meta = GREEKS.find((x) => x.key === greek)!;
      setFormat(decimals(meta.prec));
      S.net.setData(pts(g.net[greek]));
      if (showLegs) g.legs.slice(0, MAX_LEG_LINES).forEach((l, j) => S.legs[j].setData(pts(l[greek])));
      if (greek !== "iv")
        lineRef.current.zero = S.net.createPriceLine({
          price: 0,
          color: "#64748b",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: false,
        });
    }

    // fit only when this is a different chart -- a refresh keeps wherever the user scrolled/zoomed
    const frame = `${mode}|${data.symbol}|${data.expiry}|${data.interval}|${data.days}|${legKey}`;
    if (frameRef.current !== frame) {
      frameRef.current = frame;
      chart.timeScale().fitContent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, derived, mode, view, greek, showSpot, showLegs]);

  // live tail: move the still-forming bar with the chain's LTPs between server refreshes
  useEffect(() => {
    const S = serRef.current;
    if (!S || !data || !derived || live == null || mode !== "premium") return;
    const n = derived.n;
    const t0 = data.times[n - 1];
    const now = Date.now() / 1000;
    if (now < t0 || now >= t0 + data.interval) return;
    if (view === "premium") {
      const P = data.sign * live;
      const prev = nudgeRef.current?.t === t0 ? nudgeRef.current : null;
      const hi = Math.max(prev?.hi ?? data.premium.high[n - 1], P);
      const lo = Math.min(prev?.lo ?? data.premium.low[n - 1], P);
      nudgeRef.current = { t: t0, hi, lo };
      S.cand.update({ time: t0 as UTCTimestamp, open: data.premium.open[n - 1], high: hi, low: lo, close: P });
    } else {
      S.pnl.update({ time: t0 as UTCTimestamp, value: (live - derived.entryV) * data.lotSize });
    }
  }, [live, data, derived, mode, view]);

  // ---- readouts ----
  const n = derived?.n ?? 0;
  const at = hoverIdx != null && hoverIdx < n ? hoverIdx : n - 1; // hovered bar, else the latest
  // the readouts follow the same rule the chart's live tail does: only while the newest bar is still forming
  const nowSec = Date.now() / 1000;
  const liveOk =
    live != null && !!data && n > 0 && nowSec >= data.times[n - 1] && nowSec < data.times[n - 1] + data.interval;
  const liveAt = liveOk && at === n - 1;
  const nowPlot = data && derived ? (liveAt ? data.sign * live! : data.premium.close[at]) : null;
  const pnlNow =
    data && derived
      ? ((liveAt ? live! : derived.V[at]) - derived.entryV) * data.lotSize
      : null;
  // OHLC of the bar under the readout (the forming bar includes the live price)
  const ohlc =
    data && derived
      ? {
          o: data.premium.open[at],
          h: liveAt ? Math.max(data.premium.high[at], nowPlot!) : data.premium.high[at],
          l: liveAt ? Math.min(data.premium.low[at], nowPlot!) : data.premium.low[at],
          c: nowPlot!,
        }
      : null;
  const dayStats = useMemo(() => {
    if (!data || !derived) return null;
    const from = derived.day0;
    return {
      open: data.premium.open[from],
      hi: Math.max(...data.premium.high.slice(from)),
      lo: Math.min(...data.premium.low.slice(from)),
    };
  }, [data, derived]);
  const spotNow = data && derived ? data.spot[at] : null;
  const dayChg =
    nowPlot != null && dayStats && dayStats.open ? nowPlot - dayStats.open : null;

  const chartLabel = `${symbol} ${mode === "premium" ? "strategy" : "Greeks"}`;
  const idle = !optLegs.length || !expiry || !symbol;
  const showOverlay = idle || !data;

  const gMeta = GREEKS.find((x) => x.key === greek)!;
  const legLines = data ? data.legs.slice(0, MAX_LEG_LINES) : [];

  return (
    <div className="flex flex-col gap-2 p-2 lg:min-h-0 lg:flex-1">
      {/* controls */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs">
        <div className="seg" title="Candle size">
          {INTERVALS.map(([v, l]) => (
            <button key={v} className={interval === v ? "on" : ""} onClick={() => setIntervalS(v)}>
              {l}
            </button>
          ))}
        </div>
        <div className="seg" title="How many trading sessions to show">
          {DAYS.map(([v, l]) => (
            <button key={v} className={days === v ? "on" : ""} onClick={() => setDays(v)}>
              {l}
            </button>
          ))}
        </div>
        {mode === "premium" && (
          <>
            <div className="seg" title="What to plot">
              <button className={view === "premium" ? "on" : ""} onClick={() => setView("premium")}>
                Premium
              </button>
              <button className={view === "pnl" ? "on" : ""} onClick={() => setView("pnl")}>
                P&amp;L ₹
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-term-dim">Entry</span>
              <div className="seg">
                <button
                  className={`disabled:cursor-not-allowed disabled:opacity-40 ${entryMode === "position" ? "on" : ""}`}
                  disabled={!entryPx}
                  title={
                    entryPx
                      ? "The entry price of each leg in the builder (your fill for held legs, the live price otherwise)"
                      : "No entry prices yet"
                  }
                  onClick={() => setEntryMode("position")}
                >
                  Legs
                </button>
                <button
                  className={entryMode === "open" ? "on" : ""}
                  title="As if entered at the first bar of the latest session"
                  onClick={() => setEntryMode("open")}
                >
                  Day start
                </button>
                <button
                  className={entryMode === "click" ? "on" : ""}
                  title="Click any bar on the chart to see the P&L as if you'd entered there"
                  onClick={() => setEntryMode("click")}
                >
                  Click bar
                </button>
              </div>
            </div>
          </>
        )}
        <div className="flex items-center gap-1.5">
          <button className={`chipbtn ${showSpot ? "on" : ""}`} onClick={() => setShowSpot((v) => !v)}>
            Spot
          </button>
          {(mode === "greeks" || view === "premium") && (
            <button
              className={`chipbtn ${showLegs ? "on" : ""}`}
              title={mode === "greeks" ? "Each leg's contribution to the net" : "Each leg's price × lots"}
              onClick={() => setShowLegs((v) => !v)}
            >
              Legs
            </button>
          )}
        </div>
        <span className="ml-auto text-term-dim">
          {data
            ? `${data.sessions.length} session${data.sessions.length > 1 ? "s" : ""} · ${data.source.join(" + ")}`
            : ""}
        </span>
      </div>

      {/* readouts */}
      {data && derived && mode === "premium" && (
        <div className="flex flex-wrap gap-1.5">
          <Stat
            label={data.kind === "CREDIT" ? "Net credit" : "Net debit"}
            value={nf(nowPlot, 2)}
            title={
              data.kind === "CREDIT"
                ? "Premium you'd collect for the whole position, in points. Falling is good for a seller."
                : "Premium you'd pay for the whole position, in points. Rising is good for a buyer."
            }
          />
          <Stat
            label="Since day start"
            value={dayChg != null ? `${dayChg >= 0 ? "+" : ""}${nf(dayChg, 2)}` : "–"}
            cls={signColor(dayChg)}
          />
          <Stat
            label="Session hi / lo"
            value={dayStats ? `${nf(dayStats.hi, 1)} / ${nf(dayStats.lo, 1)}` : "–"}
          />
          <Stat
            label={derived.effective === "position" ? "P&L (from leg prices)" : derived.effective === "click" ? "P&L (from marked bar)" : "P&L (from day start)"}
            value={pnlNow != null ? rupee(pnlNow) : "–"}
            cls={signColor(pnlNow)}
          />
          <Stat label="Spot" value={spotNow != null ? nf(spotNow, 1) : "–"} />
        </div>
      )}
      {data && derived && mode === "greeks" && data.greeks && (
        <div className="flex flex-wrap gap-1.5">
          {GREEKS.map((g) => {
            const arr = data.greeks!.net[g.key];
            const cur = arr[at];
            const start = arr[derived.day0];
            const d = cur != null && start != null ? cur - start : null;
            const on = greek === g.key;
            return (
              <button
                key={g.key}
                onClick={() => setGreek(g.key)}
                title={`${g.name} — ${g.hint}`}
                className={`flex min-w-[92px] flex-col rounded border px-2 py-1 text-left transition-colors ${
                  on
                    ? "border-term-accent bg-term-accent text-white"
                    : "border-term-dim/70 bg-term-bg/40 text-term-dim hover:text-term-text"
                }`}
              >
                <span className="text-[9px] uppercase tracking-wide opacity-80">
                  {g.sym} {g.name}
                  {g.unit ? ` · ${g.unit}` : ""}
                </span>
                <span className="num text-xs font-semibold">
                  {cur != null ? nf(cur, g.prec) : "–"}
                  {d != null && (
                    <span className={`ml-1.5 text-[10px] font-normal ${on ? "text-white/80" : signColor(d)}`}>
                      {d >= 0 ? "+" : ""}
                      {nf(d, g.prec)}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* chart */}
      <div className="relative min-h-[340px] rounded border border-term-border bg-term-bg/20 lg:min-h-[300px] lg:flex-1">
        <div ref={wrapRef} className="absolute inset-0" />

        {data && derived && (
          <div className="pointer-events-none absolute left-2 top-1.5 z-10 flex max-w-[calc(100%-1rem)] flex-wrap gap-x-3 gap-y-0.5 rounded bg-term-panel/80 px-2 py-1 text-[10px] num text-term-text">
            <span className="text-term-dim">
              {hoverIdx != null ? `${istDay(data.times[at]).slice(5)} ${istTime(data.times[at])}` : "latest"}
            </span>
            {mode === "premium" ? (
              view === "premium" ? (
                ohlc && (
                  <span>
                    O {nf(ohlc.o, 2)} H {nf(ohlc.h, 2)} L {nf(ohlc.l, 2)} C {nf(ohlc.c, 2)}
                  </span>
                )
              ) : (
                <span className={signColor(pnlNow)}>P&amp;L {pnlNow != null ? rupee(pnlNow) : "–"}</span>
              )
            ) : (
              data.greeks && (
                <>
                  <span style={{ color: NET }}>
                    Net {nf(data.greeks.net[greek][at], gMeta.prec)}
                  </span>
                  {showLegs &&
                    legLines.map((l, j) => (
                      <span key={j} style={{ color: LEG_COLORS[j] }}>
                        {legLabel(l)} {nf(data.greeks!.legs[j][greek][at], gMeta.prec)}
                      </span>
                    ))}
                </>
              )
            )}
            {hasSpotLegend(showSpot, data) && (
              <span style={{ color: SPOT }}>Spot {nf(data.spot[at], 1)}</span>
            )}
            {mode === "premium" && view === "premium" && showLegs &&
              legLines.map((l, j) => (
                <span key={j} style={{ color: LEG_COLORS[j] }}>
                  {legLabel(l)} {nf(l.close[at] * l.lots, 2)}
                </span>
              ))}
          </div>
        )}

        {mode === "premium" && entryMode === "click" && derived && derived.effective !== "click" && (
          <div className="pointer-events-none absolute bottom-8 left-1/2 z-10 -translate-x-1/2 rounded bg-term-panel/90 px-2.5 py-1 text-[10px] text-term-text">
            Click a bar to mark the entry
          </div>
        )}

        {showOverlay && (
          <div
            className={`absolute inset-0 z-20 flex items-center justify-center p-4 ${
              !idle && err && !data ? "" : "pointer-events-none"
            }`}
          >
            <div className="max-w-[340px] rounded-lg border border-term-dim/70 bg-term-panel/95 px-4 py-3 text-center text-xs shadow-xl">
              {idle && (
                <>
                  <div className="font-semibold text-term-text">Nothing to chart yet</div>
                  <div className="mt-1 text-[10px] text-term-dim">
                    Pick a template or add option legs in the builder — this chart follows them.
                  </div>
                </>
              )}
              {!idle && !data && !err && (
                <div className="flex items-center justify-center gap-2 text-term-text">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-term-dim/50 border-t-term-accent" />
                  Loading {chartLabel}…
                </div>
              )}
              {!idle && !data && err && (
                <>
                  <div className="font-semibold text-down">Couldn't load {chartLabel}</div>
                  <div className="mt-1 break-words text-[10px] text-term-dim">{err}</div>
                  <button
                    onClick={() => {
                      setErr(null);
                      setReloadTick((t) => t + 1);
                    }}
                    className="chipbtn mt-2 text-term-text"
                  >
                    Retry
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* legend / notes */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-term-dim">
        {mode === "greeks" && data?.greeks && showLegs &&
          legLines.map((l, j) => (
            <span key={j} className="inline-flex items-center gap-1">
              <span className="inline-block h-0.5 w-3" style={{ background: LEG_COLORS[j] }} />
              {legLabel(l)}
            </span>
          ))}
        {mode === "greeks" && data && !data.greeks && (
          <span className="text-amber-400">{data.greeksNote}</span>
        )}
        {mode === "premium" && data && (
          <span>
            {view === "premium"
              ? data.kind === "CREDIT"
                ? "Charted as the premium you collect — a rising line is a loss for the seller. "
                : "Charted as the premium you pay — a rising line is a gain for the buyer. "
              : "P&L at each bar, in ₹, relative to the entry above. "}
            Candles are built from 1-min leg prices; a multi-leg high/low is the envelope of the legs' opens and closes.
          </span>
        )}
        {mode === "greeks" && (
          <span>
            Solved bar by bar from each leg's own price and the spot at that bar; thinly traded strikes look stepped.
            Legs are signed contributions and add up to the net.
          </span>
        )}
        {hasFut && <span className="text-amber-400">Futures legs aren't charted.</span>}
      </div>
    </div>
  );
}

const hasSpotLegend = (showSpot: boolean, data: StrategyChartData) =>
  showSpot && data.spot.some((v) => v != null);
