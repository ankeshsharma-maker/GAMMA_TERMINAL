import { useState } from "react";
import { Scanner } from "./Scanner";
import { Screener } from "./Screener";
import { Alerts } from "./Alerts";
import { HistoricalScan } from "./HistoricalScan";

export function ScannerView() {
  const [tab, setTab] = useState<"blast" | "screener" | "history">("blast");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs">
        {(
          [
            ["blast", "Gamma Blast"],
            ["screener", "Screener"],
            ["history", "History Scan"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded px-2.5 py-1 ${
              tab === k ? "bg-term-accent text-white" : "text-term-dim hover:bg-term-border"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-3 text-term-dim">
          {tab === "blast"
            ? "DTE-gated blend of ATM gamma, breakout, IV pop, straddle expansion, OI unwind & pin-break"
            : tab === "screener"
            ? "Session IV-rank, PCR, straddle, OI-buildup screen across the F&O universe"
            : "OI state (long/short buildup, unwinding, covering) for your watchlist as of a past date"}
        </span>
      </div>

      {tab === "blast" && (
        <>
          <Scanner />
          <Alerts compact />
        </>
      )}
      {tab === "screener" && <Screener />}
      {tab === "history" && <HistoricalScan />}
    </div>
  );
}
