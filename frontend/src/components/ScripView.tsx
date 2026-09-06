import { useState } from "react";
import { useStore } from "../store";
import { OIProfile } from "./OIProfile";
import { ExpiryTabs } from "./ExpiryTabs";
import { OptionChain } from "./OptionChain";

/**
 * One-scrip view: the OI-profile graph for the selected symbol, with a toggle
 * to switch the same pane over to the full option chain. Opened by clicking a
 * row in the scanner / screener.
 */
export function ScripView() {
  const symbol = useStore((s) => s.symbol);
  const [pane, setPane] = useState<"oi" | "chain">("oi");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-term-border bg-term-panel2 px-3 py-1">
        <span className="text-2xs font-semibold uppercase tracking-wide text-term-dim">
          {symbol}
        </span>
        <div className="seg">
          <button onClick={() => setPane("oi")} className={pane === "oi" ? "on" : ""}>
            OI Profile
          </button>
          <button onClick={() => setPane("chain")} className={pane === "chain" ? "on" : ""}>
            Option Chain
          </button>
        </div>
      </div>

      {pane === "oi" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <OIProfile />
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <ExpiryTabs />
          <OptionChain />
        </div>
      )}
    </div>
  );
}
