import { useState } from "react";
import { useStore } from "../store";
import { useIsMobile } from "../lib/useIsMobile";
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
  const chain = useStore((s) => s.chain);
  const isMobile = useIsMobile();
  const [pane, setPane] = useState<"oi" | "chain" | "history">("oi");

  const paneSeg = (
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
  );

  // On the web portal the pane switcher rides the OI Profile / Option Chain
  // toolbar row (one row saved). Keep the standalone bar for History, on
  // mobile, and while the chain is still loading (those panes show only a
  // spinner then, no toolbar to ride on).
  const showOwnBar = isMobile || pane === "history" || !chain;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showOwnBar && (
        <div className="flex items-center gap-3 border-b border-term-border bg-term-panel2 px-3 py-1">
          <span className="text-2xs font-semibold uppercase tracking-wide text-term-dim">
            {symbol}
          </span>
          {paneSeg}
        </div>
      )}

      {pane === "oi" && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <OIProfile paneNav={isMobile ? undefined : paneSeg} />
        </div>
      )}
      {pane === "chain" && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <ExpiryTabs />
          <OptionChain paneNav={isMobile ? undefined : paneSeg} />
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
