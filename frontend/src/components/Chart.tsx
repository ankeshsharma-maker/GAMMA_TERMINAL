import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts";
import { useStore } from "../store";
import { api } from "../lib/api";
import { MiniChart } from "./MiniChart";
import {
  bollinger,
  ema,
  heikinAshi,
  macd,
  pivots,
  rsi,
  sma,
  supertrend,
  vwap,
  type Candle,
  type Pt,
} from "../lib/indicators";

interface ChartData {
  symbol: string;
  candles: Candle[];
  series: Record<string, Pt[]>;
  lastSpot: number | null;
  points: number;
  candleSource?: "broker" | "sampled" | "upstox";
  hasVolume?: boolean;
}

const TIMEFRAMES: [string, number][] = [
  ["15s", 15],
  ["30s", 30],
  ["1m", 60],
  ["3m", 180],
  ["5m", 300],
  ["15m", 900],
  ["30m", 1800],
  ["45m", 2700],
  ["1h", 3600],
  ["2h", 7200],
  ["4h", 14400],
  ["1D", 86400],
];

const TOGGLES = [
  ["ema9", "EMA 9"],
  ["ema21", "EMA 21"],
  ["ema50", "EMA 50"],
  ["sma20", "SMA 20"],
  ["vwap", "VWAP"],
  ["boll", "Bollinger"],
  ["pivot", "Pivot Points"],
  ["supertrend", "Supertrend"],
  ["vol", "Volume"],
  ["rsi", "RSI"],
  ["macd", "MACD"],
  ["oi", "OI"],
  ["oichg", "ΔOI"],
  ["straddle", "ATM Straddle"],
  ["score", "Blast Score"],
] as const;
type ToggleKey = (typeof TOGGLES)[number][0];

const dedupe = (pts: Pt[] = []) => {
  const m = new Map<number, number>();
  for (const p of pts) m.set(p.time, p.value);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
};

/* ---- IST time rendering (lightweight-charts draws UTC by default, so the
 *      NSE session 09:15-15:30 was showing ~5.5h off) ---- */
const IST = "Asia/Kolkata";
let _tfSecs = false; // show seconds on the axis / crosshair for sub-minute intervals
const istTime = (t: number) =>
  new Date(t * 1000).toLocaleTimeString("en-GB", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    ...(_tfSecs ? { second: "2-digit" as const } : {}),
    hour12: false,
  });
const istDate = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-GB", { timeZone: IST, day: "2-digit", month: "short" });
const IST_LOCALIZATION = {
  timeFormatter: (t: number) => `${istDate(t)} ${istTime(t)}`,
};
const istTickFormatter = (t: number, tickType: number) =>
  tickType <= 2 ? istDate(t) : istTime(t);

/** OHLC resample to a coarser bucket, for multi-timeframe indicator overlays. */
function resampleCandles(cs: Candle[], sec: number): Candle[] {
  if (!cs.length || sec <= 0) return cs;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let key = -1;
  for (const c of cs) {
    const k = Math.floor((c.time as number) / sec);
    if (k !== key) {
      if (cur) out.push(cur);
      cur = { ...c };
      key = k;
    } else if (cur) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      (cur as any).volume = ((cur as any).volume ?? 0) + ((c as any).volume ?? 0);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** forward-fill a coarse indicator series onto the base candle timeline (step). */
function stepOnto(base: Candle[], pts: Pt[]): Pt[] {
  if (!pts.length || !base.length) return [];
  const out: Pt[] = [];
  let j = 0;
  for (const b of base) {
    const bt = b.time as number;
    while (j + 1 < pts.length && pts[j + 1].time <= bt) j++;
    if (pts[j].time <= bt) out.push({ time: bt, value: pts[j].value });
  }
  return out;
}

const MTF_INDS: [string, string][] = [
  ["ema", "EMA"],
  ["sma", "SMA"],
  ["vwap", "VWAP"],
  ["boll", "Bollinger mid"],
  ["supertrend", "Supertrend"],
];

export function Chart() {
  const symbol = useStore((s) => s.symbol);
  const chain = useStore((s) => s.chain);
  // subscribe to just the charted symbol's tick — not the whole liveSpots map,
  // which churns on every tick of every watchlist / subscribed symbol
  const liveTick = useStore((s) => s.liveSpots[s.symbol]);
  // broker session up but its live socket down => charts are on the REST
  // fallback; surface it loudly instead of letting the chart look frozen
  const feedStale = useStore((s) => !!s.broker?.authed && !s.broker?.wsConnected);
  const watch = useStore((s) => s.watch);
  const instrument = useStore((s) => s.chartInstrument);
  const setInstrument = useStore((s) => s.setChartInstrument);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const setView = useStore((s) => s.setView);
  const view = useStore((s) => s.view);
  const symClass = useStore((s) => s.symClass);
  const symClassOk = useStore((s) => s.symClassOk);
  const [symChoices, setSymChoices] = useState<string[]>([]);
  useEffect(() => {
    api.symbols().then(
      (d) => setSymChoices([...new Set([...(d.indices ?? []), ...(d.fo ?? []), ...(d.defaults ?? [])])].sort()),
      () => {}
    );
  }, []);
  const symOptions = useMemo(
    () =>
      [...new Set([symbol, ...symChoices])]
        .filter(Boolean)
        .filter((s) => s === symbol || symClassOk(s))
        .sort(),
    [symbol, symChoices, symClass]
  );
  const [data, setData] = useState<ChartData | null>(null);
  const [intervalS, setIntervalS] = useState(300); // 5-minute candles
  const [rangeD, setRangeD] = useState(1); // visible-history window in days (1 = intraday / 1D); 0 = all
  const [split, setSplit] = useState(false);
  const [cmpInstrument, setCmpInstrument] = useState<string>("STRADDLE");
  const [ctype, setCtype] = useState<"candle" | "heikin" | "line" | "area" | "bar">("candle");
  const [logScale, setLogScale] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [priceLines, setPriceLines] = useState<number[]>([]);
  const plRefs = useRef<any[]>([]);
  const pvtRefs = useRef<any[]>([]);
  const drawRef = useRef(false);
  const [legend, setLegend] = useState<string>("");
  const [rsiVal, setRsiVal] = useState<number | null>(null);
  const lastRsiRef = useRef<number | null>(null);
  useEffect(() => {
    drawRef.current = drawMode;
  }, [drawMode]);

  const instrOptions = watch.filter((w) => w.kind === "option" && w.symbol === symbol);
  const isOption = instrument.includes("|");
  const strikes = chain?.rows.map((r) => r.strike) ?? [];
  const [pickStrike, setPickStrike] = useState<number>(0);
  const [strikeCount, setStrikeCount] = useState(10); // 0 = all
  useEffect(() => {
    if (chain?.atmStrike) setPickStrike(chain.atmStrike);
  }, [chain?.atmStrike, chain?.symbol]);
  const shownStrikes = useMemo(() => {
    const atmS = chain?.atmStrike;
    let list = strikes;
    if (strikeCount > 0 && strikeCount < strikes.length && atmS) {
      list = [...strikes]
        .sort((a, b) => Math.abs(a - atmS) - Math.abs(b - atmS))
        .slice(0, strikeCount)
        .sort((a, b) => a - b);
    }
    return list.includes(pickStrike) || !pickStrike
      ? list
      : [...list, pickStrike].sort((a, b) => a - b);
  }, [strikes, strikeCount, chain?.atmStrike, pickStrike]);
  const chartLeg = (ot: "CE" | "PE") => {
    if (chain && pickStrike) setInstrument(`${symbol}|${chain.expiry}|${pickStrike}|${ot}`);
  };
  const [on, setOn] = useState<Record<ToggleKey, boolean>>({
    ema9: true,
    ema21: true,
    ema50: false,
    sma20: false,
    vwap: true,
    boll: false,
    supertrend: false,
    vol: true,
    rsi: false,
    macd: false,
    oi: false,
    oichg: false,
    pivot: false,
    straddle: false, // ATM CE+PE price (a volatility proxy) — opt-in, it was crowding every chart
    score: false,
  });
  // hide the time (x) axis labels for a cleaner chart
  const [showTime, setShowTime] = useState(() => {
    try {
      return localStorage.getItem("chart.showTime") !== "0";
    } catch {
      return true;
    }
  });
  const toggleTime = () =>
    setShowTime((v) => {
      try {
        localStorage.setItem("chart.showTime", v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });
  // multi-timeframe indicator overlay: pick an indicator + length + timeframe
  const [mtf, setMtf] = useState<{ ind: string; len: number; tf: number } | null>(null);
  // "hide indicators" — blank every overlay/sub-pane at once while keeping the
  // user's real selection so it comes straight back on toggle.
  const [indHidden, setIndHidden] = useState(() => {
    try {
      return localStorage.getItem("chart.indHidden") === "1";
    } catch {
      return false;
    }
  });
  const setInd = (v: boolean) => {
    setIndHidden(v);
    try {
      localStorage.setItem("chart.indHidden", v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  const eff = useMemo(() => {
    if (!indHidden) return on;
    const z = { ...on };
    (Object.keys(z) as ToggleKey[]).forEach((k) => (z[k] = false));
    return z;
  }, [on, indHidden]);

  const onRef = useRef(eff);
  useEffect(() => {
    onRef.current = eff;
  }, [eff]);

  // collapse the whole settings toolbar for a full-height chart
  const [barOpen, setBarOpen] = useState(() => {
    try {
      return localStorage.getItem("chart.barOpen") !== "0";
    } catch {
      return true;
    }
  });
  const setBar = (v: boolean) => {
    setBarOpen(v);
    try {
      localStorage.setItem("chart.barOpen", v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const s = useRef<Record<string, ISeriesApi<any>>>({});
  const rsiGuidesRef = useRef<any[]>([]);
  const macdZeroRef = useRef<any>(null);
  // top edge (0..1 from the top) of the oscillator band — drives the divider
  const [oscTop, setOscTop] = useState<number | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const chart = createChart(wrapRef.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#7a8699" },
      grid: { vertLines: { color: "#141c27" }, horzLines: { color: "#141c27" } },
      crosshair: { mode: CrosshairMode.Normal },
      localization: IST_LOCALIZATION,
      rightPriceScale: { borderColor: "#1e2733", scaleMargins: { top: 0.06, bottom: 0.28 } },
      timeScale: {
        borderColor: "#1e2733",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: istTickFormatter,
      },
      autoSize: true,
    });
    chartRef.current = chart;
    const c = s.current;

    c.vol = chart.addHistogramSeries({ priceScaleId: "vol", priceLineVisible: false, base: 0 });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });

    c.candle = chart.addCandlestickSeries({
      upColor: "#16a34a",
      downColor: "#dc2626",
      borderVisible: false,
      wickUpColor: "#16a34a",
      wickDownColor: "#dc2626",
    });
    c.barS = chart.addBarSeries({ upColor: "#16a34a", downColor: "#dc2626", visible: false });
    c.lineS = chart.addLineSeries({ color: "#38bdf8", lineWidth: 2, visible: false, lastValueVisible: true });
    c.areaS = chart.addAreaSeries({
      lineColor: "#38bdf8",
      topColor: "rgba(56,189,248,0.25)",
      bottomColor: "rgba(56,189,248,0.02)",
      lineWidth: 2,
      visible: false,
    });

    // crosshair OHLC legend
    chart.subscribeCrosshairMove((p) => {
      const cs = s.current.candle as ISeriesApi<"Candlestick">;
      const bar: any = p.seriesData?.get(cs) || p.seriesData?.get(s.current.barS);
      if (!bar || bar.open == null) {
        setLegend("");
        setRsiVal(lastRsiRef.current); // not hovering -> show the latest RSI, not nothing
        return;
      }
      const ch = bar.close - bar.open;
      const chp = bar.open ? (ch / bar.open) * 100 : 0;
      setLegend(
        `O ${bar.open.toFixed(1)}  H ${bar.high.toFixed(1)}  L ${bar.low.toFixed(1)}  C ${bar.close.toFixed(1)}  ${
          ch >= 0 ? "+" : ""
        }${ch.toFixed(1)} (${chp.toFixed(2)}%)`
      );
      if (onRef.current.rsi) {
        const rp: any = p.seriesData?.get(s.current.rsi as any);
        setRsiVal(rp?.value != null ? rp.value : lastRsiRef.current);
      }
    });

    // click to drop a horizontal line (draw mode)
    chart.subscribeClick((p) => {
      if (!drawRef.current || !p.point) return;
      const price = (s.current.candle as ISeriesApi<"Candlestick">).coordinateToPrice(p.point.y);
      if (price != null) setPriceLines((ls) => [...ls, Number(price.toFixed(2))]);
    });
    const line = (color: string, w = 1) =>
      chart.addLineSeries({ color, lineWidth: w as any, priceLineVisible: false, lastValueVisible: false });
    c.ema9 = line("#3b82f6");
    c.ema21 = line("#f59e0b");
    c.ema50 = line("#a855f7");
    c.sma20 = line("#14b8a6");
    c.vwap = line("#eab308", 2);
    c.bu = line("#475569");
    c.bl = line("#475569");
    c.st = line("#22c55e", 2);
    c.mtf = chart.addLineSeries({
      color: "#22d3ee",
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    c.straddle = chart.addLineSeries({
      color: "#a855f7",
      lineWidth: 2,
      priceScaleId: "straddle",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    c.score = chart.addLineSeries({
      color: "#eab308",
      lineWidth: 2,
      priceScaleId: "score",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("straddle").applyOptions({ scaleMargins: { top: 0.74, bottom: 0.14 } });
    chart.priceScale("score").applyOptions({ scaleMargins: { top: 0.74, bottom: 0.14 } });

    c.rsi = chart.addLineSeries({
      color: "#e879f9",
      lineWidth: 1,
      priceScaleId: "rsi",
      priceLineVisible: true,
      lastValueVisible: true,
    });
    chart.priceScale("rsi").applyOptions({ scaleMargins: { top: 0.74, bottom: 0.14 }, visible: false });

    c.macdHist = chart.addHistogramSeries({ priceScaleId: "macd", priceLineVisible: false, base: 0 });
    c.macdLine = chart.addLineSeries({
      color: "#3b82f6",
      lineWidth: 1,
      priceScaleId: "macd",
      priceLineVisible: false,
      lastValueVisible: true, // show the live MACD value on the axis
    });
    c.macdSig = chart.addLineSeries({
      color: "#f97316",
      lineWidth: 1,
      priceScaleId: "macd",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("macd").applyOptions({ scaleMargins: { top: 0.86, bottom: 0.02 }, visible: false });

    // OI overlay panes
    c.callOI = chart.addLineSeries({
      color: "#f87171",
      lineWidth: 2,
      priceScaleId: "oi",
      priceLineVisible: false,
      lastValueVisible: true,
    });
    c.putOI = chart.addLineSeries({
      color: "#4ade80",
      lineWidth: 2,
      priceScaleId: "oi",
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chart.priceScale("oi").applyOptions({ scaleMargins: { top: 0.72, bottom: 0.16 }, visible: false });

    c.ceChg = chart.addHistogramSeries({ priceScaleId: "oichg", priceLineVisible: false, base: 0, color: "#f8717199" });
    c.peChg = chart.addHistogramSeries({ priceScaleId: "oichg", priceLineVisible: false, base: 0, color: "#4ade8099" });
    chart.priceScale("oichg").applyOptions({ scaleMargins: { top: 0.86, bottom: 0.02 }, visible: false });

    return () => {
      chart.remove();
      chartRef.current = null;
      s.current = {};
    };
  }, []);

  // seconds on the time axis / crosshair only for sub-minute intervals
  useEffect(() => {
    _tfSecs = intervalS < 60;
    chartRef.current?.applyOptions({ timeScale: { secondsVisible: intervalS < 60 } });
  }, [intervalS]);

  const [dataSrc, setDataSrc] = useState<"auto" | "broker" | "upstox">("auto");

  // Refresh cadence: normally 15s (chart motion between refreshes comes from the
  // live nudge below). Only when the broker feed is *expected but down* — so the
  // backend is serving ~3s REST quotes and there are no WS ticks — drop to 4s so
  // the chart still moves. Both flags live in refs, updated by small effects, so
  // the fetch loop isn't torn down (blanking the chart) on every flip.
  const tickFreshRef = useRef(false);
  const feedDownRef = useRef(false);
  const lastSymRef = useRef("");
  useEffect(() => {
    let alive = true;
    let lastAt = 0;
    const load = (force = false) => {
      const now = Date.now();
      const minGap =
        intervalS < 60 ? 3000 : feedDownRef.current && !tickFreshRef.current ? 4000 : 15000;
      if (!force && now - lastAt < minGap) return;
      lastAt = now;
      api
        .chart(symbol, intervalS, instrument || undefined, dataSrc)
        .then((d) => alive && setData(d as ChartData))
        .catch(() => {});
    };
    // only blank when the underlying instrument actually changed — a plain
    // timeframe / source switch keeps the current candles on screen and just
    // swaps them in when the new set lands (~1s), so it doesn't flash "loading".
    const symKey = `${symbol}|${instrument}`;
    if (lastSymRef.current !== symKey) {
      setData(null);
      lastSymRef.current = symKey;
    }
    load(true);
    const t = setInterval(() => load(false), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [symbol, intervalS, instrument, dataSrc]);

  const candles = useMemo(() => data?.candles ?? [], [data]);

  const priceCandles = useMemo(
    () => (ctype === "heikin" ? heikinAshi(candles) : candles),
    [candles, ctype]
  );

  // heavy indicator maths, memoised on the candle set so a re-render that
  // doesn't change the candles (toggles, ticks) doesn't recompute them
  const ind = useMemo(() => {
    const cd = priceCandles;
    const bb = bollinger(cd, 20, 2);
    return {
      ema9: ema(cd, 9),
      ema21: ema(cd, 21),
      ema50: ema(cd, 50),
      sma20: sma(cd, 20),
      vwap: vwap(cd),
      bu: bb.upper,
      bl: bb.lower,
      st: supertrend(cd, 10, 3),
      rsi: rsi(cd, 14),
      macd: macd(cd),
    };
  }, [priceCandles]);
  const prevPriceRef = useRef<{ key: string; candles: Candle[] }>({ key: "", candles: [] });

  useEffect(() => {
    if (!chartRef.current || !data) return;
    const c = s.current;

    // route price data to the selected chart-type series. When only the tail
    // changed (same series, new/updated last bar) patch it in with update()
    // rather than re-seeding the whole array on every 4-15s refresh.
    const asLine = priceCandles.map((k) => ({ time: k.time as any, value: k.close }));
    const pkey = `${symbol}|${instrument}|${intervalS}|${ctype}`;
    const prevP = prevPriceRef.current;
    const canPatch =
      prevP.key === pkey &&
      prevP.candles.length > 0 &&
      priceCandles.length >= prevP.candles.length &&
      priceCandles.length - prevP.candles.length <= 3 &&
      prevP.candles[0]?.time === priceCandles[0]?.time;
    if (canPatch) {
      for (let i = prevP.candles.length - 1; i < priceCandles.length; i++) {
        const k = priceCandles[i];
        (c.candle as ISeriesApi<"Candlestick">).update(k as any);
        (c.barS as ISeriesApi<"Bar">).update(k as any);
        (c.lineS as ISeriesApi<"Line">).update({ time: k.time as any, value: k.close } as any);
        (c.areaS as ISeriesApi<"Area">).update({ time: k.time as any, value: k.close } as any);
      }
    } else {
      (c.candle as ISeriesApi<"Candlestick">).setData(priceCandles as any);
      (c.barS as ISeriesApi<"Bar">).setData(priceCandles as any);
      (c.lineS as ISeriesApi<"Line">).setData(asLine as any);
      (c.areaS as ISeriesApi<"Area">).setData(asLine as any);
    }
    prevPriceRef.current = { key: pkey, candles: priceCandles };
    (c.candle as any).applyOptions({ visible: ctype === "candle" || ctype === "heikin" });
    (c.barS as any).applyOptions({ visible: ctype === "bar" });
    (c.lineS as any).applyOptions({ visible: ctype === "line" });
    (c.areaS as any).applyOptions({ visible: ctype === "area" });

    const setLine = (key: string, pts: Pt[], visible: boolean) => {
      const ser = c[key] as ISeriesApi<"Line">;
      ser.applyOptions({ visible });
      ser.setData((visible ? pts : []) as any);
    };
    const cd = priceCandles;
    setLine("ema9", ind.ema9, eff.ema9);
    setLine("ema21", ind.ema21, eff.ema21);
    setLine("ema50", ind.ema50, eff.ema50);
    setLine("sma20", ind.sma20, eff.sma20);
    setLine("vwap", ind.vwap, eff.vwap && !!data.hasVolume);
    setLine("bu", ind.bu, eff.boll);
    setLine("bl", ind.bl, eff.boll);
    setLine("st", ind.st, eff.supertrend);

    // multi-timeframe indicator overlay (dashed cyan) — indicator computed on
    // candles resampled to `mtf.tf`, then stepped back onto the chart timeline
    {
      const mser = c.mtf as ISeriesApi<"Line">;
      if (mtf && cd.length && !indHidden) {
        const rc = mtf.tf > (intervalS || 0) ? resampleCandles(cd, mtf.tf) : cd;
        let raw: Pt[] = [];
        if (mtf.ind === "ema") raw = ema(rc, mtf.len || 21);
        else if (mtf.ind === "sma") raw = sma(rc, mtf.len || 20);
        else if (mtf.ind === "vwap") raw = vwap(rc);
        else if (mtf.ind === "boll") raw = bollinger(rc, mtf.len || 20, 2).mid;
        else if (mtf.ind === "supertrend") raw = supertrend(rc, mtf.len || 10, 3);
        const pts = stepOnto(cd, raw);
        mser.applyOptions({ visible: pts.length > 0 });
        mser.setData(pts as any);
      } else {
        mser.applyOptions({ visible: false });
        mser.setData([]);
      }
    }

    // volume
    const vser = c.vol as ISeriesApi<"Histogram">;
    const showVol = eff.vol && !!data.hasVolume;
    chartRef.current.priceScale("vol").applyOptions({ visible: showVol });
    vser.applyOptions({ visible: showVol });
    vser.setData(
      showVol
        ? cd.map((k) => ({
            time: k.time as any,
            value: k.volume ?? 0,
            color: k.close >= k.open ? "#16a34a66" : "#dc262666",
          }))
        : []
    );

    // rsi
    chartRef.current.priceScale("rsi").applyOptions({ visible: eff.rsi });
    const rsiPts = ind.rsi;
    setLine("rsi", rsiPts, eff.rsi);
    lastRsiRef.current = eff.rsi && rsiPts.length ? rsiPts[rsiPts.length - 1].value : null;
    setRsiVal(lastRsiRef.current);

    // macd
    const m = eff.macd ? ind.macd : { macd: [], signal: [], hist: [] };
    chartRef.current.priceScale("macd").applyOptions({ visible: eff.macd });
    (c.macdLine as ISeriesApi<"Line">).applyOptions({ visible: eff.macd });
    (c.macdSig as ISeriesApi<"Line">).applyOptions({ visible: eff.macd });
    (c.macdHist as ISeriesApi<"Histogram">).applyOptions({ visible: eff.macd });
    (c.macdLine as ISeriesApi<"Line">).setData(m.macd as any);
    (c.macdSig as ISeriesApi<"Line">).setData(m.signal as any);
    (c.macdHist as ISeriesApi<"Histogram">).setData(
      m.hist.map((h) => ({ time: h.time as any, value: h.value, color: h.value >= 0 ? "#16a34a66" : "#dc262666" })) as any
    );

    setLine("straddle", dedupe(data.series.straddle), eff.straddle);
    setLine("score", dedupe(data.series.score), eff.score);

    // OI overlay — total Call / Put OI lines + day ΔOI columns (from the
    // per-poll chain-history snapshots; dense during a session, sparse otherwise)
    setLine("callOI", dedupe(data.series.ceOI ?? []), eff.oi);
    setLine("putOI", dedupe(data.series.peOI ?? []), eff.oi);
    const chgBars = (key: "ceOIChg" | "peOIChg", col: string) =>
      dedupe(data.series[key] ?? []).map((p) => ({
        time: p.time as any,
        value: p.value,
        color: p.value >= 0 ? col : "#71717199",
      }));
    (c.ceChg as ISeriesApi<"Histogram">).applyOptions({ visible: eff.oichg });
    (c.peChg as ISeriesApi<"Histogram">).applyOptions({ visible: eff.oichg });
    (c.ceChg as ISeriesApi<"Histogram">).setData((eff.oichg ? chgBars("ceOIChg", "#f8717199") : []) as any);
    (c.peChg as ISeriesApi<"Histogram">).setData((eff.oichg ? chgBars("peOIChg", "#4ade8099") : []) as any);

    // ---- stack every lower pane so they never overlap each other, volume,
    //      or the straddle / blast-score overlays (which used to be pinned to
    //      the same bottom slot as RSI/MACD) ----
    {
      type SubKey = "vol" | "oi" | "oichg" | "straddle" | "score" | "rsi" | "macd";
      const sub: SubKey[] = [];
      if (showVol) sub.push("vol");
      if (eff.oi) sub.push("oi");
      if (eff.oichg) sub.push("oichg");
      if (eff.straddle) sub.push("straddle");
      if (eff.score) sub.push("score");
      if (eff.rsi) sub.push("rsi");
      if (eff.macd) sub.push("macd");
      const n = sub.length;
      const band = n === 0 ? 0 : n === 1 ? 0.2 : n === 2 ? 0.16 : n === 3 ? 0.13 : n === 4 ? 0.1 : n === 5 ? 0.085 : 0.07;
      const gap = n >= 4 ? 0.02 : 0.03;
      const reserve = n === 0 ? 0.06 : Math.min(0.74, n * band + (n - 1) * gap + 0.05);
      chartRef.current.priceScale("right").applyOptions({
        scaleMargins: { top: 0.06, bottom: reserve },
      });
      let oscTopFrac: number | null = null;
      sub.forEach((p, i) => {
        const bottom = 0.02 + (n - 1 - i) * (band + gap); // i=0 sits highest
        const topFrac = 1 - bottom - band;
        chartRef.current!.priceScale(p).applyOptions({
          scaleMargins: { top: topFrac, bottom },
          // oscillators (RSI / MACD) get their own axis, like a TradingView
          // lower pane; the rest just read off the price grid
          visible: p === "rsi" || p === "macd",
        });
        if ((p === "rsi" || p === "macd") && (oscTopFrac == null || topFrac < oscTopFrac))
          oscTopFrac = topFrac;
      });
      setOscTop(oscTopFrac);
    }

    // ---- RSI 30 / 50 / 70 guides + MACD zero line (TradingView-style) ----
    for (const g of rsiGuidesRef.current) {
      try {
        (c.rsi as ISeriesApi<"Line">).removePriceLine(g);
      } catch {
        /* ignore */
      }
    }
    rsiGuidesRef.current = [];
    if (eff.rsi) {
      // guide lines only — no 70 / 30 axis tags; the axis just carries the
      // live RSI value (series lastValueVisible)
      const mk = (price: number, color: string, style: LineStyle) =>
        (c.rsi as ISeriesApi<"Line">).createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle: style,
          axisLabelVisible: false,
          title: "",
        });
      rsiGuidesRef.current = [
        mk(70, "#ef4444aa", LineStyle.Dashed),
        mk(50, "#64748b66", LineStyle.Dotted),
        mk(30, "#22c55eaa", LineStyle.Dashed),
      ];
    }
    if (macdZeroRef.current) {
      try {
        (c.macdHist as ISeriesApi<"Histogram">).removePriceLine(macdZeroRef.current);
      } catch {
        /* ignore */
      }
      macdZeroRef.current = null;
    }
    if (eff.macd) {
      macdZeroRef.current = (c.macdHist as ISeriesApi<"Histogram">).createPriceLine({
        price: 0,
        color: "#64748b66",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: "",
      });
    }

    applyRange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceCandles, ctype, data, eff, mtf, indHidden, intervalS]);

  // clamp the visible window to the chosen lookback (1D / 3M / 6M / 1Y / All)
  const applyRange = () => {
    const ts = chartRef.current?.timeScale();
    if (!ts || priceCandles.length === 0) return;
    if (rangeD <= 0) {
      ts.fitContent();
      return;
    }
    const last = priceCandles[priceCandles.length - 1].time as number;
    const first = priceCandles[0].time as number;
    const from = Math.max(first, last - rangeD * 86400);
    try {
      ts.setVisibleRange({ from: from as any, to: last as any });
    } catch {
      ts.fitContent();
    }
  };
  useEffect(applyRange, [rangeD]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    chartRef.current?.timeScale().applyOptions({ visible: showTime });
  }, [showTime]);

  // live last-price nudge — move the last candle toward the latest price for
  // whatever instrument is charted: the underlying tick, the charted option
  // leg's LTP, or the ATM straddle — not always the underlying spot.
  const tickAgeOk = !!liveTick && Date.now() / 1000 - liveTick.ts < 15;
  useEffect(() => {
    tickFreshRef.current = tickAgeOk;
  }, [tickAgeOk]);
  useEffect(() => {
    feedDownRef.current = feedStale;
  }, [feedStale]);

  const optLegPx = useMemo(() => {
    if (!isOption || !chain) return null;
    const [sym, , kS, ot] = instrument.split("|");
    if (sym !== chain.symbol) return null;
    const row = chain.rows.find((r) => r.strike === Number(kS));
    const leg = row && (ot === "CE" ? row.call : row.put);
    return leg && leg.ltp != null ? leg.ltp : null;
  }, [isOption, instrument, chain]);

  const livePx = isOption
    ? optLegPx
    : instrument.toUpperCase() === "STRADDLE"
    ? chain?.atmStraddle ?? null
    : tickAgeOk
    ? liveTick!.ltp
    : chain?.spot ?? null;

  useEffect(() => {
    if (!chartRef.current || !data || !priceCandles.length || livePx == null) return;
    const last = priceCandles[priceCandles.length - 1];
    if (ctype === "line") {
      (s.current.lineS as ISeriesApi<"Line">).update({ time: last.time as any, value: livePx });
      return;
    }
    if (ctype === "area") {
      (s.current.areaS as ISeriesApi<"Area">).update({ time: last.time as any, value: livePx });
      return;
    }
    const bar = {
      time: last.time as any,
      open: last.open,
      high: Math.max(last.high, livePx),
      low: Math.min(last.low, livePx),
      close: livePx,
    };
    (s.current.candle as ISeriesApi<"Candlestick">).update(bar);
    (s.current.barS as ISeriesApi<"Bar">).update(bar);
  }, [livePx, symbol, priceCandles, data, ctype]);

  // log / linear price scale
  useEffect(() => {
    chartRef.current
      ?.priceScale("right")
      .applyOptions({ mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
  }, [logScale]);

  // sync drawn horizontal lines
  useEffect(() => {
    const cs = s.current.candle as ISeriesApi<"Candlestick"> | undefined;
    if (!cs) return;
    plRefs.current.forEach((pl) => cs.removePriceLine(pl));
    plRefs.current = priceLines.map((price) =>
      cs.createPriceLine({
        price,
        color: "#eab308",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: String(price),
      })
    );
  }, [priceLines, data]);

  // classic pivot points from the previous session (PP / R1-3 / S1-3)
  useEffect(() => {
    const cs = s.current.candle as ISeriesApi<"Candlestick"> | undefined;
    if (!cs) return;
    pvtRefs.current.forEach((pl) => cs.removePriceLine(pl));
    pvtRefs.current = [];
    if (!eff.pivot) return;
    const p = pivots(priceCandles);
    if (!p) return;
    const rows: [string, number, string, LineStyle][] = [
      ["R3", p.r3, "#f87171", LineStyle.Dotted],
      ["R2", p.r2, "#f87171", LineStyle.Dashed],
      ["R1", p.r1, "#f87171", LineStyle.Dashed],
      ["PP", p.pp, "#eab308", LineStyle.Solid],
      ["S1", p.s1, "#4ade80", LineStyle.Dashed],
      ["S2", p.s2, "#4ade80", LineStyle.Dashed],
      ["S3", p.s3, "#4ade80", LineStyle.Dotted],
    ];
    pvtRefs.current = rows.map(([title, price, color, lineStyle]) =>
      cs.createPriceLine({
        price: Number(price.toFixed(2)),
        color,
        lineWidth: 1,
        lineStyle,
        axisLabelVisible: true,
        title,
      })
    );
  }, [eff.pivot, priceCandles, data]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!barOpen && (
        <div className="flex items-center gap-1 self-start rounded-br border-b border-r border-term-border bg-term-panel2 px-1.5 py-0.5 text-2xs">
          <button
            onClick={() => setBar(true)}
            title="Show the chart settings bar"
            className="rounded border border-term-accent/50 bg-term-accent/15 px-2 py-0.5 font-semibold text-term-text hover:bg-term-accent/25"
          >
            ⚙ settings
          </button>
          <button
            onClick={() => setInd(!indHidden)}
            title={indHidden ? "Show indicators" : "Hide all indicators"}
            className={`rounded border px-2 py-0.5 font-semibold ${
              indHidden
                ? "border-amber-500/60 bg-amber-500/15 text-amber-400"
                : "border-term-border text-term-dim hover:text-term-text"
            }`}
          >
            {indHidden ? "▨ ind off" : "▨ hide ind"}
          </button>
        </div>
      )}
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs"
        style={barOpen ? undefined : { display: "none" }}
      >
        {view !== "scalper" && (
          <div className="flex overflow-hidden rounded border border-term-border">
            {(
              [
                ["chain", "Chain"],
                ["scrip", "OI"],
                ["trendingoi", "Trend OI"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                title={`Open ${label} for ${symbol}`}
                className="border-r border-term-border px-2 py-0.5 text-term-dim last:border-r-0 hover:bg-term-border hover:text-term-text"
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <select
          value={symbol}
          onChange={(e) => selectSymbol(e.target.value, true)}
          className="rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs font-bold text-term-text outline-none focus:border-term-accent"
          title="Index / stock to chart"
        >
          {symOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={instrument}
          onChange={(e) => setInstrument(e.target.value)}
          className="rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs font-semibold text-term-text outline-none focus:border-term-accent"
          title="Instrument to chart"
        >
          <option value="">{symbol} spot</option>
          <option value="STRADDLE">{symbol} ATM straddle</option>
          {instrOptions.length > 0 && <option disabled>── watchlist options ──</option>}
          {instrOptions.map((w) => (
            <option key={w.key} value={w.key}>
              {w.symbol} {w.strike} {w.optionType}
            </option>
          ))}
        </select>

        <button
          onClick={() =>
            setSplit((v) => {
              const next = !v;
              if (next) setCmpInstrument(instrument === "" ? "STRADDLE" : "");
              return next;
            })
          }
          className={`rounded border px-1.5 py-0.5 ${
            split ? "border-term-accent/50 bg-term-accent/15 text-term-text" : "border-transparent text-term-dim hover:bg-term-border hover:text-term-text"
          }`}
          title="Split view — underlying + derivative in one window"
        >
          ⊞ Split
        </button>
        {split && (
          <select
            value={cmpInstrument}
            onChange={(e) => setCmpInstrument(e.target.value)}
            className="rounded border border-term-accent/40 bg-term-bg px-1.5 py-0.5 text-2xs font-semibold text-term-text outline-none"
            title="Second pane instrument"
          >
            <option value="">{symbol} spot</option>
            <option value="STRADDLE">{symbol} ATM straddle</option>
            {instrOptions.map((w) => (
              <option key={w.key} value={w.key}>
                {w.symbol} {w.strike} {w.optionType}
              </option>
            ))}
          </select>
        )}

        {/* pick any strike's CE / PE */}
        {strikes.length > 0 && (
          <div className="flex items-center gap-0.5 rounded border border-term-border px-1">
            {([5, 10, 20, 0] as const).map((c) => (
              <button
                key={c}
                onClick={() => setStrikeCount(c)}
                className={`rounded px-1 text-[9px] font-semibold ${
                  strikeCount === c ? "bg-term-accent/25 text-term-text" : "text-term-dim hover:text-term-text"
                }`}
                title={c === 0 ? "All strikes" : `${c} strikes around ATM`}
              >
                {c === 0 ? "All" : c}
              </button>
            ))}
            <span className="mx-0.5 h-3 w-px bg-term-border" />
            <select
              value={pickStrike}
              onChange={(e) => setPickStrike(Number(e.target.value))}
              className="bg-transparent py-0.5 text-2xs num outline-none"
              title="Strike to chart"
            >
              {shownStrikes.map((k) => (
                <option key={k} value={k} className="bg-term-panel">
                  {k}
                  {k === chain?.atmStrike ? " (ATM)" : ""}
                </option>
              ))}
            </select>
            <button
              onClick={() => chartLeg("CE")}
              className={`rounded px-1 text-[10px] font-bold ${
                instrument === `${symbol}|${chain?.expiry}|${pickStrike}|CE`
                  ? "bg-up text-white"
                  : "text-up hover:bg-up/20"
              }`}
            >
              CE
            </button>
            <button
              onClick={() => chartLeg("PE")}
              className={`rounded px-1 text-[10px] font-bold ${
                instrument === `${symbol}|${chain?.expiry}|${pickStrike}|PE`
                  ? "bg-down text-white"
                  : "text-down hover:bg-down/20"
              }`}
            >
              PE
            </button>
          </div>
        )}

        <div className="flex overflow-hidden rounded border border-term-border">
          {TIMEFRAMES.map(([lbl, v]) => (
            <button
              key={v}
              onClick={() => setIntervalS(v)}
              className={`px-1.5 py-0.5 text-2xs font-semibold ${
                intervalS === v
                  ? "bg-term-accent text-white"
                  : "bg-term-bg text-term-dim hover:bg-term-border hover:text-term-text"
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>

        <div
          className="flex overflow-hidden rounded border border-term-border"
          title="Visible history window"
        >
          {(
            [
              ["1D", 1],
              ["3M", 90],
              ["6M", 180],
              ["1Y", 365],
              ["All", 0],
            ] as const
          ).map(([lbl, d]) => (
            <button
              key={lbl}
              onClick={() => setRangeD(d)}
              className={`px-1.5 py-0.5 text-2xs font-semibold ${
                rangeD === d
                  ? "bg-term-accent text-white"
                  : "bg-term-bg text-term-dim hover:bg-term-border hover:text-term-text"
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>

        <select
          value={dataSrc}
          onChange={(e) => setDataSrc(e.target.value as any)}
          className="rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs outline-none focus:border-term-accent"
          title="Candle data source"
        >
          <option value="auto">Src: Auto</option>
          <option value="broker">Src: Flattrade</option>
          <option value="upstox">Src: Upstox</option>
        </select>

        <select
          value={ctype}
          onChange={(e) => setCtype(e.target.value as any)}
          className="rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs outline-none focus:border-term-accent"
          title="Chart type"
        >
          <option value="candle">Candles</option>
          <option value="heikin">Heikin-Ashi</option>
          <option value="bar">Bars</option>
          <option value="line">Line</option>
          <option value="area">Area</option>
        </select>
        <button
          onClick={() => setLogScale((v) => !v)}
          className={`rounded border px-1.5 py-0.5 ${
            logScale ? "border-term-accent/50 bg-term-accent/15 text-term-text" : "border-transparent text-term-dim hover:bg-term-border hover:text-term-text"
          }`}
          title="Logarithmic price scale"
        >
          Log
        </button>
        <button
          onClick={() => setDrawMode((v) => !v)}
          className={`rounded border px-1.5 py-0.5 ${
            drawMode ? "border-amber-500/60 bg-amber-500/15 text-amber-400" : "border-transparent text-term-dim hover:bg-term-border hover:text-term-text"
          }`}
          title="Draw mode — click the chart to drop a horizontal line"
        >
          ✎ Line
        </button>
        {priceLines.length > 0 && (
          <button
            onClick={() => setPriceLines([])}
            className="rounded border border-term-border px-1.5 py-0.5 text-term-dim hover:text-down"
            title="Clear drawn lines"
          >
            ✕ {priceLines.length}
          </button>
        )}
        <button
          onClick={() => chartRef.current?.timeScale().fitContent()}
          className="rounded border border-term-border px-1.5 py-0.5 text-term-dim hover:text-term-text"
          title="Reset zoom"
        >
          ⤢
        </button>
        <button
          onClick={toggleTime}
          className={`rounded border px-2 py-0.5 font-semibold ${
            showTime
              ? "border-term-border text-term-dim hover:text-term-text"
              : "border-amber-500/60 bg-amber-500/15 text-amber-400"
          }`}
          title="Show / hide the time axis labels"
        >
          {showTime ? "🕒 time" : "🕒 time off"}
        </button>

        {/* multi-timeframe indicator overlay */}
        <span className="flex items-center gap-1 rounded border border-cyan-500/40 bg-cyan-500/10 px-1 py-0.5">
          <span className="text-[10px] font-semibold text-cyan-300">MTF</span>
          <select
            value={mtf?.ind ?? ""}
            onChange={(e) =>
              setMtf(
                e.target.value
                  ? { ind: e.target.value, len: mtf?.len ?? 21, tf: mtf?.tf ?? 900 }
                  : null
              )
            }
            className="rounded border border-term-border bg-term-bg px-1 py-0.5 text-[10px] text-term-text outline-none"
          >
            <option value="">off</option>
            {MTF_INDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          {mtf && mtf.ind !== "vwap" && (
            <input
              type="number"
              min={2}
              max={400}
              value={mtf.len}
              onChange={(e) => setMtf({ ...mtf, len: Math.max(2, Number(e.target.value) || 21) })}
              className="w-11 rounded border border-term-border bg-term-bg px-1 py-0.5 text-[10px] text-term-text outline-none"
              title="Indicator length / period"
            />
          )}
          {mtf && (
            <select
              value={mtf.tf}
              onChange={(e) => setMtf({ ...mtf, tf: Number(e.target.value) })}
              className="rounded border border-term-border bg-term-bg px-1 py-0.5 text-[10px] text-term-text outline-none"
              title="Timeframe the indicator is computed on"
            >
              {TIMEFRAMES.map(([l, v]) => (
                <option key={v} value={v}>
                  @ {l}
                </option>
              ))}
            </select>
          )}
        </span>

        <button
          onClick={() => setInd(!indHidden)}
          className={`rounded border px-2 py-0.5 font-semibold ${
            indHidden
              ? "border-amber-500/60 bg-amber-500/15 text-amber-400"
              : "border-term-border text-term-dim hover:text-term-text"
          }`}
          title={
            indHidden
              ? "Indicators hidden — click to bring your overlays back"
              : "Hide every indicator / overlay (price only)"
          }
        >
          {indHidden ? "▨ indicators off" : "▨ hide indicators"}
        </button>
        <button
          onClick={() => setBar(false)}
          className="rounded border border-term-accent/50 bg-term-accent/15 px-2 py-0.5 font-semibold text-term-text hover:bg-term-accent/25"
          title="Hide the whole settings bar for a bigger chart"
        >
          ⌃ hide bar
        </button>

        {TOGGLES.map(([k, lbl]) => {
          const dim = (isOption && (k === "straddle" || k === "score")) || indHidden;
          return (
            <button
              key={k}
              disabled={dim}
              onClick={() => setOn((o) => ({ ...o, [k]: !o[k] }))}
              className={`rounded border px-1.5 py-0.5 ${
                dim
                  ? "border-term-border/40 text-term-dim/40"
                  : on[k]
                  ? "border-term-accent/50 bg-term-accent/15 text-term-text"
                  : "border-transparent text-term-dim hover:bg-term-border hover:text-term-text"
              }`}
            >
              {lbl}
            </button>
          );
        })}
        {feedStale && (
          <span
            className="ml-auto flex items-center gap-1 rounded border border-down/60 bg-down/15 px-1.5 py-0.5 font-semibold text-down"
            title="Broker live feed is down — chart is on ~3s REST quotes, not tick-by-tick. Hit ↻ refresh in the header."
          >
            ⚠ FEED STALE · REST
          </span>
        )}
        <span className={`${feedStale ? "" : "ml-auto"} text-term-dim`}>
          {data
            ? data.candleSource === "broker"
              ? `${data.candles.length} bars · Flattrade${data.hasVolume ? " + vol" : ""}`
              : data.candleSource === "upstox"
              ? `${data.candles.length} bars · Upstox${data.hasVolume ? " + vol" : ""}`
              : `${data.points} samples · sampled (connect Flattrade / Upstox for real bars)`
            : "loading…"}
        </span>
      </div>

      <div className={`relative min-h-0 ${split ? "flex-[3]" : "flex-1"}`}>
        <div ref={wrapRef} className="absolute inset-0" />
        {oscTop != null && (
          <>
            <div
              className="pointer-events-none absolute inset-x-0 z-10 border-t border-term-border/80"
              style={{ top: `${oscTop * 100}%` }}
            />
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 z-0 bg-term-bg/25"
              style={{ top: `${oscTop * 100}%` }}
            />
          </>
        )}
        {legend && (
          <div className="pointer-events-none absolute left-2 top-1 z-10 rounded bg-term-panel/80 px-2 py-0.5 text-[10px] num text-term-text">
            {symbol} · {legend}
          </div>
        )}
        {eff.rsi && rsiVal != null && (
          <div
            className="pointer-events-none absolute left-2 z-10 rounded bg-term-panel/80 px-2 py-0.5 text-[10px] num"
            style={{ top: eff.macd ? "58%" : "72%" }}
          >
            <span style={{ color: "#e879f9" }}>RSI(14)</span>{" "}
            <span
              className={
                rsiVal >= 70 ? "text-down" : rsiVal <= 30 ? "text-up" : "text-term-text"
              }
            >
              {rsiVal.toFixed(1)}
            </span>
          </div>
        )}
        {drawMode && (
          <div className="pointer-events-none absolute right-2 top-1 z-10 rounded bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-400">
            click chart to add a line
          </div>
        )}
        {data && data.candles.length < 3 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-xs text-term-dim">
            Collecting data — connect Flattrade for full history, volume and higher timeframes.
          </div>
        )}
      </div>

      {split && (
        <div className="min-h-0 flex-[2] border-t-2 border-term-border">
          <MiniChart
            symbol={symbol}
            instrument={cmpInstrument}
            intervalS={intervalS}
            label={
              cmpInstrument === ""
                ? `${symbol} spot`
                : cmpInstrument === "STRADDLE"
                ? `${symbol} ATM straddle`
                : (instrOptions.find((w) => w.key === cmpInstrument) &&
                    `${symbol} ${instrOptions.find((w) => w.key === cmpInstrument)!.strike} ${
                      instrOptions.find((w) => w.key === cmpInstrument)!.optionType
                    }`) || cmpInstrument
            }
          />
        </div>
      )}
    </div>
  );
}
