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
import {
  ema,
  vwap,
  bollinger,
  rsi,
  supertrend,
  pivots,
  type Candle,
  type Pt,
} from "../lib/indicators";

export type MiniInd = {
  ema9: boolean;
  ema21: boolean;
  ema50: boolean;
  vwap: boolean;
  boll: boolean;
  supertrend: boolean;
  pivots: boolean;
  rsi: boolean;
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
}: {
  symbol: string;
  instrument: string;
  intervalS: number;
  label: string;
  ind?: MiniInd;
  src?: "auto" | "broker" | "upstox";
}) {
  const on = ind ?? MINI_IND_DEFAULT;
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const serRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineRef = useRef<Record<string, ISeriesApi<"Line">>>({});
  const pvtRef = useRef<IPriceLine[]>([]);
  const [bars, setBars] = useState(0);
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
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true },
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
    };
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

          // RSI sub-pane — reserve bottom space on the price scale when shown
          chartRef.current.priceScale("right").applyOptions({
            scaleMargins: { top: 0.06, bottom: on.rsi ? 0.3 : 0.06 },
          });
          chartRef.current.priceScale("rsi").applyOptions({
            scaleMargins: { top: 0.74, bottom: 0 },
            visible: on.rsi,
          });
          const rp = rsi(cs, 14);
          put("rsi", rp, on.rsi);
          setRsiVal(on.rsi && rp.length ? rp[rp.length - 1].value : null);

          // previous-session pivots as horizontal price lines
          for (const pl of pvtRef.current) serRef.current.removePriceLine(pl);
          pvtRef.current = [];
          if (on.pivots) {
            const p = pivots(cs);
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
              pvtRef.current = rows.map(([title, price, color, lineStyle]) =>
                serRef.current!.createPriceLine({
                  price: Number(price.toFixed(2)),
                  color,
                  lineWidth: 1,
                  lineStyle,
                  axisLabelVisible: true,
                  title,
                })
              );
            }
          }

          chartRef.current.timeScale().fitContent();
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
    on.rsi,
  ]);

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
