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
import {
  bollinger,
  ema,
  heikinAshi,
  macd,
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
  candleSource?: "broker" | "sampled";
  hasVolume?: boolean;
}

const TIMEFRAMES: [string, number][] = [
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
  ["supertrend", "Supertrend"],
  ["vol", "Volume"],
  ["rsi", "RSI"],
  ["macd", "MACD"],
  ["straddle", "ATM Straddle"],
  ["score", "Blast Score"],
] as const;
type ToggleKey = (typeof TOGGLES)[number][0];

const dedupe = (pts: Pt[] = []) => {
  const m = new Map<number, number>();
  for (const p of pts) m.set(p.time, p.value);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
};

export function Chart() {
  const symbol = useStore((s) => s.symbol);
  const chain = useStore((s) => s.chain);
  const liveSpots = useStore((s) => s.liveSpots);
  const watch = useStore((s) => s.watch);
  const instrument = useStore((s) => s.chartInstrument);
  const setInstrument = useStore((s) => s.setChartInstrument);
  const selectSymbol = useStore((s) => s.selectSymbol);
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
  const [intervalS, setIntervalS] = useState(300);
  const [ctype, setCtype] = useState<"candle" | "heikin" | "line" | "area" | "bar">("candle");
  const [logScale, setLogScale] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [priceLines, setPriceLines] = useState<number[]>([]);
  const plRefs = useRef<any[]>([]);
  const drawRef = useRef(false);
  const [legend, setLegend] = useState<string>("");
  useEffect(() => {
    drawRef.current = drawMode;
  }, [drawMode]);

  const instrOptions = watch.filter((w) => w.kind === "option" && w.symbol === symbol);
  const isOption = instrument.includes("|");
  const strikes = chain?.rows.map((r) => r.strike) ?? [];
  const [pickStrike, setPickStrike] = useState<number>(0);
  useEffect(() => {
    if (chain?.atmStrike) setPickStrike(chain.atmStrike);
  }, [chain?.atmStrike, chain?.symbol]);
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
    straddle: true,
    score: false,
  });

  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const s = useRef<Record<string, ISeriesApi<any>>>({});

  useEffect(() => {
    if (!wrapRef.current) return;
    const chart = createChart(wrapRef.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#7a8699" },
      grid: { vertLines: { color: "#141c27" }, horzLines: { color: "#141c27" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#1e2733", scaleMargins: { top: 0.06, bottom: 0.28 } },
      timeScale: { borderColor: "#1e2733", timeVisible: true, secondsVisible: false },
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
        return;
      }
      const ch = bar.close - bar.open;
      const chp = bar.open ? (ch / bar.open) * 100 : 0;
      setLegend(
        `O ${bar.open.toFixed(1)}  H ${bar.high.toFixed(1)}  L ${bar.low.toFixed(1)}  C ${bar.close.toFixed(1)}  ${
          ch >= 0 ? "+" : ""
        }${ch.toFixed(1)} (${chp.toFixed(2)}%)`
      );
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
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("rsi").applyOptions({ scaleMargins: { top: 0.74, bottom: 0.14 }, visible: false });

    c.macdHist = chart.addHistogramSeries({ priceScaleId: "macd", priceLineVisible: false, base: 0 });
    c.macdLine = chart.addLineSeries({
      color: "#3b82f6",
      lineWidth: 1,
      priceScaleId: "macd",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    c.macdSig = chart.addLineSeries({
      color: "#f97316",
      lineWidth: 1,
      priceScaleId: "macd",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("macd").applyOptions({ scaleMargins: { top: 0.86, bottom: 0.02 }, visible: false });

    return () => {
      chart.remove();
      chartRef.current = null;
      s.current = {};
    };
  }, []);

  // fetch on symbol / instrument / timeframe change + poll
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .chart(symbol, intervalS, instrument || undefined)
        .then((d) => alive && setData(d as ChartData))
        .catch(() => {});
    setData(null);
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [symbol, intervalS, instrument]);

  const candles = useMemo(() => data?.candles ?? [], [data]);

  const priceCandles = useMemo(
    () => (ctype === "heikin" ? heikinAshi(candles) : candles),
    [candles, ctype]
  );

  useEffect(() => {
    if (!chartRef.current || !data) return;
    const c = s.current;

    // route price data to the selected chart-type series
    const asLine = priceCandles.map((k) => ({ time: k.time as any, value: k.close }));
    (c.candle as ISeriesApi<"Candlestick">).setData(priceCandles as any);
    (c.barS as ISeriesApi<"Bar">).setData(priceCandles as any);
    (c.lineS as ISeriesApi<"Line">).setData(asLine as any);
    (c.areaS as ISeriesApi<"Area">).setData(asLine as any);
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
    setLine("ema9", ema(cd, 9), on.ema9);
    setLine("ema21", ema(cd, 21), on.ema21);
    setLine("ema50", ema(cd, 50), on.ema50);
    setLine("sma20", sma(cd, 20), on.sma20);
    setLine("vwap", vwap(cd), on.vwap && !!data.hasVolume);
    const bb = bollinger(cd, 20, 2);
    setLine("bu", bb.upper, on.boll);
    setLine("bl", bb.lower, on.boll);
    setLine("st", supertrend(cd, 10, 3), on.supertrend);

    // volume
    const vser = c.vol as ISeriesApi<"Histogram">;
    const showVol = on.vol && !!data.hasVolume;
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
    chartRef.current.priceScale("rsi").applyOptions({ visible: on.rsi });
    setLine("rsi", rsi(cd, 14), on.rsi);

    // macd
    const m = on.macd ? macd(cd) : { macd: [], signal: [], hist: [] };
    chartRef.current.priceScale("macd").applyOptions({ visible: on.macd });
    (c.macdLine as ISeriesApi<"Line">).applyOptions({ visible: on.macd });
    (c.macdSig as ISeriesApi<"Line">).applyOptions({ visible: on.macd });
    (c.macdHist as ISeriesApi<"Histogram">).applyOptions({ visible: on.macd });
    (c.macdLine as ISeriesApi<"Line">).setData(m.macd as any);
    (c.macdSig as ISeriesApi<"Line">).setData(m.signal as any);
    (c.macdHist as ISeriesApi<"Histogram">).setData(
      m.hist.map((h) => ({ time: h.time as any, value: h.value, color: h.value >= 0 ? "#16a34a66" : "#dc262666" })) as any
    );

    setLine("straddle", dedupe(data.series.straddle), on.straddle);
    setLine("score", dedupe(data.series.score), on.score);

    chartRef.current.timeScale().fitContent();
  }, [priceCandles, ctype, data, on]);

  // live last-price nudge
  const liveTick = liveSpots[symbol];
  const livePx =
    liveTick && Date.now() / 1000 - liveTick.ts < 12 ? liveTick.ltp : chain?.spot;
  useEffect(() => {
    if (!chartRef.current || !data || !candles.length || livePx == null) return;
    const last = candles[candles.length - 1];
    (s.current.candle as ISeriesApi<"Candlestick">).update({
      time: last.time as any,
      open: last.open,
      high: Math.max(last.high, livePx),
      low: Math.min(last.low, livePx),
      close: livePx,
    });
  }, [livePx, symbol, candles, data]);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs">
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

        {/* pick any strike's CE / PE */}
        {strikes.length > 0 && (
          <div className="flex items-center gap-0.5 rounded border border-term-border px-1">
            <select
              value={pickStrike}
              onChange={(e) => setPickStrike(Number(e.target.value))}
              className="bg-transparent py-0.5 text-2xs num outline-none"
              title="Strike to chart"
            >
              {strikes.map((k) => (
                <option key={k} value={k} className="bg-term-panel">
                  {k}
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

        <select
          value={intervalS}
          onChange={(e) => setIntervalS(Number(e.target.value))}
          className="rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs outline-none focus:border-term-accent"
        >
          {TIMEFRAMES.map(([lbl, v]) => (
            <option key={v} value={v}>
              {lbl}
            </option>
          ))}
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
            logScale ? "border-term-accent/50 bg-term-accent/15 text-term-text" : "border-term-border text-term-dim"
          }`}
          title="Logarithmic price scale"
        >
          Log
        </button>
        <button
          onClick={() => setDrawMode((v) => !v)}
          className={`rounded border px-1.5 py-0.5 ${
            drawMode ? "border-amber-500/60 bg-amber-500/15 text-amber-400" : "border-term-border text-term-dim"
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

        {TOGGLES.map(([k, lbl]) => {
          const dim = isOption && (k === "straddle" || k === "score");
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
                  : "border-term-border text-term-dim hover:bg-term-border"
              }`}
            >
              {lbl}
            </button>
          );
        })}
        <span className="ml-auto text-term-dim">
          {data
            ? data.candleSource === "broker"
              ? `${data.candles.length} bars · Flattrade${data.hasVolume ? " + vol" : ""}`
              : `${data.points} samples · sampled (connect Flattrade for real bars + volume)`
            : "loading…"}
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={wrapRef} className="absolute inset-0" />
        {legend && (
          <div className="pointer-events-none absolute left-2 top-1 z-10 rounded bg-term-panel/80 px-2 py-0.5 text-[10px] num text-term-text">
            {symbol} · {legend}
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
    </div>
  );
}
