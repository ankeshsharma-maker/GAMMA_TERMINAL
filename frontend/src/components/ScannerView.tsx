import { useState } from "react";
import { Scanner } from "./Scanner";
import { Screener } from "./Screener";
import { HistoricalScan } from "./HistoricalScan";
import { IndicatorScan } from "./IndicatorScan";
import { Movers, type Timeframe } from "./Movers";
import { Num } from "./Screener";
import { type Spec } from "./Scanner";

type Tab = "blast" | "movers" | "screener" | "history" | "indicators";

const LS_KEY = "blastFilter";
const loadSpec = (): Spec => {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
};

function Chip({ on, onClick, title, children }: { on?: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return <button onClick={onClick} title={title} className={`chipbtn ${on ? "on" : ""}`}>{children}</button>;
}

export function ScannerView() {
  const [tab, setTab] = useState<Tab>("blast");
  const [spec, setSpec] = useState<Spec>(loadSpec);
  const [moversTf, setMoversTf] = useState<Timeframe>("today");
  const patch = (p: Partial<Spec>) => {
    const next = { ...spec, ...p };
    setSpec(next);
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

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
            className={`shrink-0 rounded border px-2.5 py-1 ${
              tab === k
                ? "border-term-accent bg-term-accent text-white"
                : "border-term-dim/70 text-term-dim hover:bg-term-border"
            }`}
          >
            {label}
          </button>
        ))}

        {/* Blast filters inline — only when Gamma Blast tab is active */}
        {tab === "blast" && (
          <>
            <div className="mx-1 h-4 w-px bg-term-border/60" />
            <Num label="Score≥" value={spec.scoreMin} onChange={(v) => patch({ scoreMin: v })} />
            <Num label="DTE≤" value={spec.dteMax} onChange={(v) => patch({ dteMax: v })} />
            <Chip on={spec.building} onClick={() => patch({ building: spec.building ? undefined : true })} title="Blast score climbing fast over the last 5 minutes">Building</Chip>
            <Chip on={spec.hotOnly} onClick={() => patch({ hotOnly: spec.hotOnly ? undefined : true })} title="A near-ATM strike with an outsized OI move in the last ~15 minutes">Hot OI</Chip>
            {(["UP", "DOWN"] as const).map((b) => (
              <Chip key={b} on={spec.bias === b} onClick={() => patch({ bias: spec.bias === b ? undefined : b })}>
                {b === "UP" ? "↑" : "↓"}
              </Chip>
            ))}
            <button onClick={() => setSpec({})} className="btn px-2 py-0.5 text-2xs">Reset</button>
          </>
        )}

        {/* Movers timeframe buttons inline — only when Top Movers tab is active */}
        {tab === "movers" && (
          <>
            <div className="mx-1 h-4 w-px bg-term-border/60" />
            {(["today", "yesterday", "7d", "compare"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setMoversTf(v)}
                className={`rounded border px-2 py-0.5 font-semibold ${
                  moversTf === v
                    ? "border-term-accent bg-term-accent/20 text-term-text"
                    : "border-term-dim/70 text-term-dim hover:bg-term-border hover:text-term-text"
                }`}
              >
                {v === "today" ? "Today" : v === "yesterday" ? "Yesterday" : v === "7d" ? "7 Day" : "Compare"}
              </button>
            ))}
          </>
        )}

        {tab !== "blast" && tab !== "movers" && (
          <span className="w-full text-[11px] leading-snug text-term-dim sm:ml-3 sm:w-auto sm:text-2xs">
            {tab === "screener"
              ? "Session IV-rank, PCR, straddle, OI-buildup screen across the F&O universe"
              : tab === "history"
              ? "OI state (long/short buildup, unwinding, covering) for your watchlist as of a past date"
              : "RSI, EMA 9/21/50 crossovers & MACD histogram for your watchlist as of a chosen date"}
          </span>
        )}
      </div>

      {tab === "blast" && <Scanner spec={spec} setSpec={setSpec} />}
      {tab === "movers" && <Movers tf={moversTf} setTf={setMoversTf} />}
      {tab === "screener" && <Screener />}
      {tab === "history" && <HistoricalScan />}
      {tab === "indicators" && <IndicatorScan />}
    </div>
  );
}
