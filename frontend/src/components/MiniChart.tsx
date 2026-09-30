import { useEffect, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
} from "lightweight-charts";
import { api } from "../lib/api";
import { computeGammaFlip } from "../lib/gammaFlip";
import {
  ema,
  vwap,
  bollinger,
  rsi,
  sma,
  macd,
  supertrend,
  pivots,
  type Candle,
  type Pt,
} from "../lib/indicators";

const IST = "Asia/Kolkata";
const istT = (t: number) =>
  new Date(t * 1000).toLocaleTimeString("en-GB", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const istD = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-GB", { timeZone: IST, day: "2-digit", month: "short" });

export type MiniInd = {
  ema9: boolean;
  ema21: boolean;
  ema50: boolean;
  vwap: boolean;
  boll: boolean;
  supertrend: boolean;
  pivots: boolean;
  rsi: boolean;
  sma20: boolean;
  vol: boolean;
  macd: boolean;
  fibpivot: boolean;
  gammaflip: boolean;
};
export const MINI_IND_DEFAULT: MiniInd = {
  ema9: true,
  ema21: true,
  ema50: false,
  vwap: false,
  boll: false,
  supertrend: false,
  pivots: false,
  rsi: false,
  sma20: false,
  vol: true,
  macd: false,
  fibpivot: false,
  gammaflip: false,
};

/** A no-frills candlestick pane with a few overlay indicators. Used by the
 *  Chart "split" view and the Scalper multi-chart. Overlays: EMA 9/21/50,
 *  VWAP, Bollinger(20,2), Supertrend(10,3), previous-session pivots
 *  (PP / R1-3 / S1-3) and a bottom RSI(14) sub-pane. */
export function MiniChart({
  symbol,
  instrument,
  intervalS,
  label,
  ind,
  src,
  hideTime = false,
}: {
  symbol: string;
  instrument: string;
  intervalS: number;
  label: string;
  ind?: MiniInd;
  src?: "auto" | "broker" | "upstox";
  hideTime?: boolean;
}) {
  const on = ind ?? MINI_IND_DEFAULT;
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const serRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineRef = useRef<Record<string, ISeriesApi<"Line">>>({});
  const pvtRef = useRef<IPriceLine[]>([]);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const macdHistRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const gfLineRef = useRef<IPriceLine | null>(null);
  const [bars, setBars] = useState(0);
  // which symbol / instrument / timeframe the visible window was last set for
  const viewKeyRef = useRef("");
  const [rsiVal, setRsiVal] = useState<number | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const chart = createChart(wrapRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8b98a9",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      localization: { timeFormatter: (t: number) => `${istD(t)} ${istT(t)}` },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        tickMarkFormatter: (t: number, tickType: number) => (tickType <= 2 ? istD(t) : istT(t)),
      },
      crosshair: { mode: 0 },
      handleScale: true,
      handleScroll: true,
    });
    chartRef.current = chart;
    serRef.current = chart.addCandlestickSeries({
      upColor: "#16a34a",
      downColor: "#dc2626",
      borderVisible: false,
      wickUpColor: "#16a34a",
      wickDownColor: "#dc2626",
    });
    const line = (color: string, w = 1, opts: Record<string, unknown> = {}) =>
      chart.addLineSeries({
        color,
        lineWidth: w as any,
        priceLineVisible: false,
        lastValueVisible: false,
        ...opts,
      });
    lineRef.current = {
      ema9: line("#3b82f6"),
      ema21: line("#f59e0b"),
      ema50: line("#a855f7"),
      vwap: line("#eab308", 2),
      bbU: line("#64748b"),
      bbM: line("#64748b", 1, { lineStyle: LineStyle.Dashed }),
      bbL: line("#64748b"),
      st: line("#14b8a6", 2),
      rsi: line("#c084fc", 1, { priceScaleId: "rsi", lastValueVisible: true }),
      sma20: line("#22d3ee"),
      macd: line("#38bdf8", 1, { priceScaleId: "macd" }),
      macdSig: line("#f97316", 1, { priceScaleId: "macd" }),
    };
    volRef.current = chart.addHistogramSeries({
      priceScaleId: "vol",
      priceLineVisible: false,
      lastValueVisible: false,
      base: 0,
    });
    macdHistRef.current = chart.addHistogramSeries({
      priceScaleId: "macd",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("vol").applyOptions({ visible: false, scaleMargins: { top: 0.8, bottom: 0 } });
    chart.priceScale("macd").applyOptions({ scaleMargins: { top: 0.74, bottom: 0 }, visible: false });
    chart.priceScale("rsi").applyOptions({
      scaleMargins: { top: 0.74, bottom: 0 },
      visible: false,
    });
    const ro = new ResizeObserver(() => {
      const el = wrapRef.current;
      if (el) chart.resize(el.clientWidth, el.clientHeight);
    });
    ro.observe(wrapRef.current);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      serRef.current = null;
      lineRef.current = {};
      pvtRef.current = [];
      volRef.current = null;
      macdHistRef.current = null;
      gfLineRef.current = null;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .chart(symbol, intervalS, instrument || undefined, src)
        .then((d) => {
          if (!alive || !serRef.current || !chartRef.current) return;
          const cs = (d.candles ?? []) as Candle[];
          serRef.current.setData(cs as any);
          setBars(cs.length);
          const put = (k: keyof typeof lineRef.current, pts: Pt[], vis: boolean) => {
            const s = lineRef.current[k];
            if (!s) return;
            s.applyOptions({ visible: vis });
            s.setData((vis ? pts : []) as any);
          };
          put("ema9", ema(cs, 9), on.ema9);
          put("ema21", ema(cs, 21), on.ema21);
          put("ema50", ema(cs, 50), on.ema50);
          put("vwap", vwap(cs), on.vwap && !!(d as any).hasVolume);

          const bb = bollinger(cs, 20, 2);
          put("bbU", bb.upper, on.boll);
          put("bbM", bb.mid, on.boll);
          put("bbL", bb.lower, on.boll);

          put("st", supertrend(cs, 10, 3), on.supertrend);
          put("sma20", sma(cs, 20), on.sma20);

          // volume, faint behind the lower part of the candles (as on the full chart)
          const showVol = on.vol && !!(d as any).hasVolume;
          volRef.current?.applyOptions({ visible: showVol });
          volRef.current?.setData(
            showVol
              ? (cs.map((k) => ({
                  time: k.time,
                  value: k.volume ?? 0,
                  color: k.close >= k.open ? "#16a34a44" : "#dc262644",
                })) as any)
              : []
          );

          // MACD (12, 26, 9)
          const mc = on.macd ? macd(cs) : { macd: [], signal: [], hist: [] };
          put("macd", mc.macd, on.macd);
          put("macdSig", mc.signal, on.macd);
          macdHistRef.current?.applyOptions({ visible: on.macd });
          macdHistRef.current?.setData(
            (on.macd
              ? mc.hist.map((h) => ({ time: h.time, value: h.value, color: h.value >= 0 ? "#16a34a99" : "#dc262699" }))
              : []) as any
          );

          // lower panes (RSI, MACD) share the bottom of the chart; volume sits behind the candles
          const nSub = (on.rsi ? 1 : 0) + (on.macd ? 1 : 0);
          const band = nSub === 1 ? 0.22 : 0.17;
          const gap = 0.03;
          const reserve = nSub === 0 ? 0.06 : nSub * band + (nSub - 1) * gap + 0.05;
          const ch = chartRef.current;
          ch.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: reserve } });
          ch.priceScale("vol").applyOptions({
            visible: false,
            scaleMargins: { top: Math.max(0.3, 1 - reserve - 0.16), bottom: reserve },
          });
          let slot = 0;
          const place = (id: string, shown: boolean) => {
            if (!shown) {
              ch.priceScale(id).applyOptions({ visible: false });
              return;
            }
            const bottom = 0.02 + (nSub - 1 - slot) * (band + gap);
            slot += 1;
            ch.priceScale(id).applyOptions({
              scaleMargins: { top: 1 - bottom - band, bottom },
              visible: true,
            });
          };
          place("rsi", on.rsi);
          place("macd", on.macd);
          const rp = rsi(cs, 14);
          put("rsi", rp, on.rsi);
          setRsiVal(on.rsi && rp.length ? rp[rp.length - 1].value : null);

          // previous-session pivots as horizontal price lines
          for (const pl of pvtRef.current) serRef.current.removePriceLine(pl);
          pvtRef.current = [];
          const pivotSets: [boolean, boolean][] = [
            [on.pivots, false],
            [on.fibpivot, true],
          ];
          for (const [wanted, fib] of pivotSets) {
            if (!wanted) continue;
            const p = pivots(cs, fib);
            if (p) {
              const rows: [string, number, string, LineStyle][] = [
                ["R3", p.r3, "#f87171", LineStyle.Dotted],
                ["R2", p.r2, "#f87171", LineStyle.Dashed],
                ["R1", p.r1, "#f87171", LineStyle.Dashed],
                ["PP", p.pp, "#eab308", LineStyle.Solid],
                ["S1", p.s1, "#4ade80", LineStyle.Dashed],
                ["S2", p.s2, "#4ade80", LineStyle.Dashed],
                ["S3", p.s3, "#4ade80", LineStyle.Dotted],
              ];
              pvtRef.current.push(
                ...rows.map(([title, price, color, lineStyle]) =>
                  serRef.current!.createPriceLine({
                    price: Number(price.toFixed(2)),
                    color,
                    lineWidth: 1,
                    lineStyle,
                    axisLabelVisible: true,
                    title: fib ? "f" + title : title,
                  })
                )
              );
            }
          }

          // The answer carries days of history: fitting all of it into a small pane shrinks the
          // candles to slivers. Frame the latest bars for the pane's width when the chart
          // changes, and leave a zoom / scroll the user made alone on the 15 s refresh.
          const vk = `${symbol}|${instrument}|${intervalS}`;
          if (viewKeyRef.current !== vk && cs.length) {
            viewKeyRef.current = vk;
            const w = wrapRef.current?.clientWidth ?? 600;
            const show = Math.max(30, Math.min(cs.length, Math.floor(w / 8)));
            chartRef.current.timeScale().setVisibleLogicalRange({ from: cs.length - show, to: cs.length + 3 });
          }
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [
    symbol,
    instrument,
    intervalS,
    src,
    on.ema9,
    on.ema21,
    on.ema50,
    on.vwap,
    on.boll,
    on.supertrend,
    on.pivots,
    on.fibpivot,
    on.rsi,
    on.sma20,
    on.vol,
    on.macd,
  ]);

  // gamma flip: today's live level from the symbol's own chain (any symbol, not just the open one)
  useEffect(() => {
    let alive = true;
    const clear = () => {
      if (gfLineRef.current && serRef.current) {
        try {
          serRef.current.removePriceLine(gfLineRef.current);
        } catch {
          /* chart rebuilt */
        }
      }
      gfLineRef.current = null;
    };
    clear();
    if (!on.gammaflip || instrument) return clear;
    const load = () =>
      api.chain(symbol).then(
        (c) => {
          if (!alive || !serRef.current) return;
          const lvl =
            c.gammaFlip ?? (c.rows?.length ? computeGammaFlip(c.rows, c.liveSpot?.ltp ?? c.spot)?.strike : null) ?? null;
          clear();
          if (lvl != null)
            gfLineRef.current = serRef.current.createPriceLine({
              price: Number(lvl.toFixed(2)),
              color: "#e879f9",
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: "gamma flip",
            });
        },
        () => {}
      );
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
      clear();
    };
  }, [symbol, instrument, on.gammaflip]);

  useEffect(() => {
    chartRef.current?.timeScale().applyOptions({ visible: !hideTime });
  }, [hideTime]);

  return (
    <div className="relative h-full w-full">
      <div ref={wrapRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute left-2 top-1 z-10 rounded bg-term-panel/80 px-2 py-0.5 text-[10px] num text-term-text">
        {label}
        {rsiVal != null && (
          <span
            className={`ml-2 ${
              rsiVal >= 70 ? "text-down" : rsiVal <= 30 ? "text-up" : "text-term-dim"
            }`}
          >
            RSI {rsiVal.toFixed(1)}
          </span>
        )}
      </div>
      {bars < 3 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-[11px] text-term-dim">
          collecting…
        </div>
      )}
    </div>
  );
}
