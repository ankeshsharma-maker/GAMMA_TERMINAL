import { useState } from "react";
import { Scanner } from "./Scanner";
import { Screener } from "./Screener";
import { HistoricalScan } from "./HistoricalScan";
import { IndicatorScan } from "./IndicatorScan";
import { Movers, type Timeframe } from "./Movers";
import { Num } from "./Screener";
import { type Spec, PRESETS, specKey } from "./Scanner";
import { useIsMobile } from "../lib/useIsMobile";
import { Chrome, ChromeRow, ChromeTabs } from "./Chrome";

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
  const isMobile = useIsMobile();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = Object.values(spec).filter((v) => v !== undefined && v !== false).length;
  const patch = (p: Partial<Spec>) => {
    const next = { ...spec, ...p };
    setSpec(next);
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isMobile && (
        <div className="px-2 pt-1.5">
          <Chrome>
            <ChromeTabs<Tab>
              main={[
                { key: "blast", label: "Blast" },
                { key: "movers", label: "Movers" },
                { key: "screener", label: "Screener" },
              ]}
              more={[
                { key: "history", label: "History scan", short: "History" },
                { key: "indicators", label: "Indicators" },
              ]}
              value={tab}
              onChange={setTab}
            />
            {tab === "blast" && (
              <>
                <ChromeRow>
                  <button
                    type="button"
                    onClick={() => setFiltersOpen((o) => !o)}
                    className={`pick ${filtersOpen ? "!bg-term-accent/25" : ""}`}
                  >
                    Filters{activeFilters > 0 ? ` · ${activeFilters}` : ""} {filtersOpen ? "▴" : "▾"}
                  </button>
                  {PRESETS.map(([name, hint, p]) => (
                    <button
                      key={name}
                      title={hint}
                      type="button"
                      onClick={() => setSpec(p)}
                      className={`shrink-0 rounded-full border px-2.5 py-0.5 text-2xs font-semibold ${
                        specKey(spec) === specKey(p) ? "border-term-accent bg-term-accent/25 text-term-text" : "border-term-accent/30 text-term-dim"
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </ChromeRow>
                {filtersOpen && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-term-accent/25 px-2 py-2 text-2xs">
                    <Num label="Score≥" value={spec.scoreMin} onChange={(v) => patch({ scoreMin: v })} />
                    <Num label="DTE≤" value={spec.dteMax} onChange={(v) => patch({ dteMax: v })} />
                    <Chip on={spec.building} onClick={() => patch({ building: spec.building ? undefined : true })}>Building</Chip>
                    <Chip on={spec.hotOnly} onClick={() => patch({ hotOnly: spec.hotOnly ? undefined : true })}>Hot OI</Chip>
                    {(["UP", "DOWN"] as const).map((b) => (
                      <Chip key={b} on={spec.bias === b} onClick={() => patch({ bias: spec.bias === b ? undefined : b })}>
                        {b === "UP" ? "↑ Up" : "↓ Down"}
                      </Chip>
                    ))}
                    <button onClick={() => setSpec({})} className="btn px-2 py-0.5 text-2xs">Reset</button>
                  </div>
                )}
              </>
            )}
            {tab === "movers" && (
              <ChromeRow>
                {(["today", "yesterday", "7d", "compare"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setMoversTf(v)}
                    className={`shrink-0 rounded-full border px-3 py-0.5 text-2xs font-semibold ${
                      moversTf === v ? "border-term-accent bg-term-accent/25 text-term-text" : "border-term-accent/30 text-term-dim"
                    }`}
                  >
                    {v === "today" ? "Today" : v === "yesterday" ? "Yesterday" : v === "7d" ? "7 Day" : "Compare"}
                  </button>
                ))}
              </ChromeRow>
            )}
            {tab !== "blast" && tab !== "movers" && (
              <ChromeRow>
                <span className="text-term-dim">
                  {tab === "screener" ? "IV rank, PCR, straddle and OI build-up across F&O" : tab === "history" ? "OI state as of a past date" : "RSI, EMA and MACD as of a date"}
                </span>
              </ChromeRow>
            )}
          </Chrome>
        </div>
      )}

      <div className={`${isMobile ? "hidden" : "flex"} flex-wrap items-center gap-x-1 gap-y-1.5 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs`}>
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
