import { useEffect, useRef, useState } from "react";
import { createChart, ColorType, type IChartApi, type ISeriesApi } from "lightweight-charts";
import { api } from "../lib/api";
import type { Candle } from "../lib/indicators";

/** A second, no-frills candlestick pane — used by the Chart "split" view so
 *  the underlying and a derivative can be watched side by side. Shares the
 *  parent's symbol + timeframe; only the instrument differs. */
export function MiniChart({
  symbol,
  instrument,
  intervalS,
  label,
}: {
  symbol: string;
  instrument: string;
  intervalS: number;
  label: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const serRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
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
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .chart(symbol, intervalS, instrument || undefined)
        .then((d) => {
          if (!alive || !serRef.current) return;
          const cs = (d.candles ?? []) as Candle[];
          serRef.current.setData(cs as any);
          setBars(cs.length);
          chartRef.current?.timeScale().fitContent();
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [symbol, instrument, intervalS]);

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
