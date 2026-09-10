import { useState } from "react";
import { Scanner } from "./Scanner";
import { Screener } from "./Screener";
import { HistoricalScan } from "./HistoricalScan";
import { IndicatorScan } from "./IndicatorScan";
import { Movers } from "./Movers";

type Tab = "blast" | "movers" | "screener" | "history" | "indicators";

export function ScannerView() {
  const [tab, setTab] = useState<Tab>("blast");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs">
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
            className={`shrink-0 rounded px-2.5 py-1 ${
              tab === k ? "bg-term-accent text-white" : "text-term-dim hover:bg-term-border"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="w-full text-[11px] leading-snug text-term-dim sm:ml-3 sm:w-auto sm:text-2xs">
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

      {tab === "blast" && <Scanner />}
      {tab === "movers" && <Movers />}
      {tab === "screener" && <Screener />}
      {tab === "history" && <HistoricalScan />}
      {tab === "indicators" && <IndicatorScan />}
    </div>
  );
}
