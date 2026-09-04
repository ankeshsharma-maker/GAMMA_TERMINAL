import { useStore } from "../store";
import { OIProfile } from "./OIProfile";
import { ExpiryTabs } from "./ExpiryTabs";
import { OptionChain } from "./OptionChain";

/**
 * One-scrip view: the OI-profile graph beside the option chain for the selected
 * symbol. Opened by clicking a row in the scanner / screener.
 */
export function ScripView() {
  const symbol = useStore((s) => s.symbol);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-2">
      {/* OI graph */}
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r-2 border-term-border">
        <div className="border-b border-term-border bg-term-panel2 px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-term-dim">
          {symbol} · OI profile
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <OIProfile />
        </div>
      </div>

      {/* option chain (per-strike OI) */}
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="border-b border-term-border bg-term-panel2 px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-term-dim">
          {symbol} · Option chain
        </div>
        <ExpiryTabs />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <OptionChain />
        </div>
      </div>
    </div>
  );
}
