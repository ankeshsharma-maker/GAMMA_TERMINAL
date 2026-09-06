import { useState } from "react";
import { Scanner } from "./Scanner";
import { Screener } from "./Screener";
import { Alerts } from "./Alerts";
import { HistoricalScan } from "./HistoricalScan";
import { IndicatorScan } from "./IndicatorScan";
import { Movers } from "./Movers";

type Tab = "blast" | "movers" | "screener" | "history" | "indicators";

export function ScannerView() {
  const [tab, setTab] = useState<Tab>("blast");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs">
        {(
          [
            ["blast", "Gamma Blast"],
            ["movers", "Top Movers"],
            ["screener", "Screener"],
            ["history", "History Scan"],
            ["indicators", "Indicators"],
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
            : tab === "movers"
            ? "Top gainers & losers for the day, ranked by session % move"
            : tab === "screener"
            ? "Session IV-rank, PCR, straddle, OI-buildup screen across the F&O universe"
            : tab === "history"
            ? "OI state (long/short buildup, unwinding, covering) for your watchlist as of a past date"
            : "RSI, EMA 9/21/50 crossovers & MACD histogram for your watchlist as of a chosen date"}
        </span>
      </div>

      {tab === "blast" && (
        <>
          <Scanner />
          <Alerts compact />
        </>
      )}
      {tab === "movers" && <Movers />}
      {tab === "screener" && <Screener />}
      {tab === "history" && <HistoricalScan />}
      {tab === "indicators" && <IndicatorScan />}
    </div>
  );
}
