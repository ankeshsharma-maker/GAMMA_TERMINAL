import { useState } from "react";
import { useStore } from "../store";
import { OIProfile } from "./OIProfile";
import { OIHistory } from "./OIHistory";
import { ExpiryTabs } from "./ExpiryTabs";
import { OptionChain } from "./OptionChain";

/**
 * One-scrip view: OI-profile graph, the full option chain, or the historical
 * daily OI/PCR/max-pain trend — one pane at a time. Opened by clicking a row
 * in the scanner / screener, or from the "OI" menu item.
 */
export function ScripView() {
  const symbol = useStore((s) => s.symbol);
  const [pane, setPane] = useState<"oi" | "chain" | "history">("oi");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-term-border bg-term-panel2 px-3 py-1">
        <span className="text-2xs font-semibold uppercase tracking-wide text-term-dim">{symbol}</span>
        <div className="seg">
          <button onClick={() => setPane("oi")} className={pane === "oi" ? "on" : ""}>
            OI Profile
          </button>
          <button onClick={() => setPane("chain")} className={pane === "chain" ? "on" : ""}>
            Option Chain
          </button>
          <button onClick={() => setPane("history")} className={pane === "history" ? "on" : ""}>
            History
          </button>
        </div>
      </div>

      {pane === "oi" && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <OIProfile />
        </div>
      )}
      {pane === "chain" && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <ExpiryTabs />
          <OptionChain />
        </div>
      )}
      {pane === "history" && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <OIHistory />
        </div>
      )}
    </div>
  );
}
