import { useEffect, useRef, useState } from "react";
import { createChart, ColorType, type IChartApi, type ISeriesApi } from "lightweight-charts";
import { api } from "../lib/api";
import { ema, vwap, type Candle, type Pt } from "../lib/indicators";

export type MiniInd = { ema9: boolean; ema21: boolean; ema50: boolean; vwap: boolean };
export const MINI_IND_DEFAULT: MiniInd = { ema9: true, ema21: true, ema50: false, vwap: false };

/** A no-frills candlestick pane with a few overlay indicators. Used by the
 *  Chart "split" view and the Scalper multi-chart. */
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
  const [bars, setBars] = useState(0);

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
    const line = (color: string, w = 1) =>
      chart.addLineSeries({ color, lineWidth: w as any, priceLineVisible: false, lastValueVisible: false });
    lineRef.current = {
      ema9: line("#3b82f6"),
      ema21: line("#f59e0b"),
      ema50: line("#a855f7"),
      vwap: line("#eab308", 2),
    };
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
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .chart(symbol, intervalS, instrument || undefined, src)
        .then((d) => {
          if (!alive || !serRef.current) return;
          const cs = (d.candles ?? []) as Candle[];
          serRef.current.setData(cs as any);
          setBars(cs.length);
          const put = (k: keyof MiniInd, pts: Pt[], vis: boolean) => {
            const s = lineRef.current[k];
            if (!s) return;
            s.applyOptions({ visible: vis });
            s.setData((vis ? pts : []) as any);
          };
          put("ema9", ema(cs, 9), on.ema9);
          put("ema21", ema(cs, 21), on.ema21);
          put("ema50", ema(cs, 50), on.ema50);
          put("vwap", vwap(cs), on.vwap && !!(d as any).hasVolume);
          chartRef.current?.timeScale().fitContent();
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [symbol, instrument, intervalS, src, on.ema9, on.ema21, on.ema50, on.vwap]);

  return (
    <div className="relative h-full w-full">
      <div ref={wrapRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute left-2 top-1 z-10 rounded bg-term-panel/80 px-2 py-0.5 text-[10px] num text-term-text">
        {label}
      </div>
      {bars < 3 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-[11px] text-term-dim">
          collecting…
        </div>
      )}
    </div>
  );
}
