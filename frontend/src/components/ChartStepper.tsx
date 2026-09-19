import { useStore } from "../store";

/** Prev / Next through the list the chart was opened from (Screener, Top Movers,
 *  Indicators, Watchlist) -- in the order that list was showing. Renders nothing
 *  when the chart wasn't opened from a list. */
export function ChartStepper() {
  const queue = useStore((s) => s.chartQueue);
  const symbol = useStore((s) => s.symbol);
  const step = useStore((s) => s.chartStep);
  if (!queue) return null;

  const list = queue.symbols;
  const i = list.indexOf(symbol);
  // current symbol not in the list (picked from the dropdown): Next -> first, Prev -> last
  const prevSym = i === -1 ? list[list.length - 1] : list[i - 1];
  const nextSym = i === -1 ? list[0] : list[i + 1];

  const btn =
    "px-1.5 py-0.5 text-term-dim hover:bg-term-border hover:text-term-text disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-term-dim";
  return (
    <div className="segx text-2xs" title={`Charts from ${queue.source}`}>
      <button
        onClick={() => step(-1)}
        disabled={!prevSym}
        title={prevSym ? `Previous chart: ${prevSym} (${queue.source})` : `Start of ${queue.source}`}
        className={btn}
      >
        ‹ Prev
      </button>
      <span className="num px-1.5 py-0.5 text-term-dim">
        {i === -1 ? "–" : i + 1}/{list.length}
      </span>
      <button
        onClick={() => step(1)}
        disabled={!nextSym}
        title={nextSym ? `Next chart: ${nextSym} (${queue.source})` : `End of ${queue.source}`}
        className={`${btn} font-semibold text-term-text`}
      >
        Next ›
      </button>
    </div>
  );
}
