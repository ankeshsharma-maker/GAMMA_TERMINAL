import { useStore } from "../store";
import { Chart } from "./Chart";
import { OIProfile } from "./OIProfile";
import { ExpiryTabs } from "./ExpiryTabs";
import { OptionChain } from "./OptionChain";

/**
 * One-scrip dashboard: candle chart + OI graph + option chain for the selected
 * symbol, all at once. Opened by clicking a row in the scanner / screener.
 */
export function ScripView() {
  const symbol = useStore((s) => s.symbol);

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,42%)_minmax(0,58%)]">
      {/* candle chart */}
      <div className="min-h-0 border-b-2 border-term-border">
        <div className="flex h-full flex-col">
          <div className="border-b border-term-border bg-term-panel2 px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-term-dim">
            {symbol} · Candle chart
          </div>
          <div className="min-h-0 flex-1">
            <Chart />
          </div>
        </div>
      </div>

      {/* OI graph  |  option chain */}
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col border-r-2 border-term-border">
          <div className="border-b border-term-border bg-term-panel2 px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-term-dim">
            {symbol} · OI profile
          </div>
          <div className="min-h-0 flex-1">
            <OIProfile />
          </div>
        </div>

        <div className="flex min-h-0 flex-col">
          <ExpiryTabs />
          <OptionChain />
        </div>
      </div>
    </div>
  );
}
