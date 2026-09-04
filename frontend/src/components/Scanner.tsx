import { useStore } from "../store";
import { compact, nf, signColor } from "../lib/format";
import type { ScanRow } from "../types";

const scoreColor = (s: number) =>
  s >= 80 ? "bg-down" : s >= 60 ? "bg-amber-500" : s >= 40 ? "bg-term-accent" : "bg-term-border";
const scoreText = (s: number) =>
  s >= 80 ? "text-down" : s >= 60 ? "text-amber-400" : s >= 40 ? "text-term-accent" : "text-term-dim";

const biasPill = (b: ScanRow["bias"]) =>
  b === "UP"
    ? "bg-up/20 text-up"
    : b === "DOWN"
    ? "bg-down/20 text-down"
    : "bg-term-border text-term-dim";

const COMPS: [string, string][] = [
  ["dte", "DTE"],
  ["gamma", "Γ"],
  ["breakout", "Brk"],
  ["straddle", "Strd"],
  ["ivpop", "IV"],
  ["unwind", "OI"],
  ["pin", "Pin"],
];

function ScoreCell({ r }: { r: ScanRow }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`num w-8 text-right text-base font-bold ${scoreText(r.score)}`}>
        {nf(r.score, 0)}
      </span>
      <div className="h-2 w-20 overflow-hidden rounded bg-term-border">
        <div className={`h-full ${scoreColor(r.score)}`} style={{ width: `${Math.min(100, r.score)}%` }} />
      </div>
    </div>
  );
}

function CompBars({ c }: { c: Record<string, number> }) {
  return (
    <div className="flex gap-1">
      {COMPS.map(([k, lbl]) => {
        const v = c?.[k] ?? 0;
        return (
          <div key={k} className="flex w-6 flex-col items-center gap-0.5" title={`${lbl} ${nf(v * 100, 0)}`}>
            <div className="flex h-6 w-2 items-end overflow-hidden rounded-sm bg-term-border">
              <div
                className={v >= 0.66 ? "bg-down" : v >= 0.33 ? "bg-amber-500" : "bg-term-accent"}
                style={{ height: `${Math.max(6, Math.min(100, v * 100))}%`, width: "100%" }}
              />
            </div>
            <span className="text-[8px] text-term-dim">{lbl}</span>
          </div>
        );
      })}
    </div>
  );
}

const TH = ({ children, r = false }: { children: React.ReactNode; r?: boolean }) => (
  <th
    className={`border-b border-r border-term-border px-2 py-1.5 font-medium ${
      r ? "text-right" : "text-left"
    }`}
  >
    {children}
  </th>
);
const TD = ({
  children,
  cls = "",
}: {
  children: React.ReactNode;
  cls?: string;
}) => <td className={`border-b border-r border-term-border/60 px-2 py-2 ${cls}`}>{children}</td>;

export function Scanner() {
  const { scan, selectSymbol, setView, symClassOk } = useStore();
  const rows = [...scan].filter((r) => symClassOk(r.symbol)).sort((a, b) => b.score - a.score);
  const openScrip = (sym: string) => {
    selectSymbol(sym, true);
    setView("scrip");
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <table className="w-full border-separate border-spacing-0 border border-term-border text-xs">
        <thead className="sticky top-0 z-10 bg-term-panel text-[10px] uppercase text-term-dim">
          <tr>
            <TH>Symbol</TH>
            <TH>Blast Score</TH>
            <TH>Sub-scores (DTE·Γ·Brk·Strd·IV·OI·Pin)</TH>
            <TH>Bias</TH>
            <TH r>DTE</TH>
            <TH r>Spot</TH>
            <TH r>5m Δ%</TH>
            <TH r>ATM IV</TH>
            <TH r>IV Δ5m</TH>
            <TH r>Strd Δ5m%</TH>
            <TH r>Net GEX</TH>
            <TH r>PCR</TH>
            <TH r>|Spot−MP|</TH>
            <TH>Top signal</TH>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={14} className="border border-term-border px-3 py-10 text-center text-term-dim">
                warming up — the scanner needs a few polls of history…
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr
              key={r.symbol}
              onClick={() => openScrip(r.symbol)}
              title="Open scrip dashboard (chart + OI + chain)"
              className={`click-row ${i % 2 ? "bg-term-panel2/40" : ""}`}
            >
              <TD cls="text-sm">
                <span className="chipbtn font-semibold text-term-text">
                  {r.symbol}
                  <span className="text-term-accent">›</span>
                </span>
              </TD>
              <TD>
                <ScoreCell r={r} />
              </TD>
              <TD>
                <CompBars c={r.components} />
              </TD>
              <TD>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${biasPill(r.bias)}`}>
                  {r.bias}
                </span>
              </TD>
              <TD cls="num text-right">{nf(r.dte, 1)}</TD>
              <TD cls="num text-right">{nf(r.spot, 0)}</TD>
              <TD cls={`num text-right ${signColor(r.move5mPct)}`}>{nf(r.move5mPct, 2)}</TD>
              <TD cls="num text-right">{nf(r.atmIV, 1)}</TD>
              <TD cls={`num text-right ${signColor(r.ivChg5m)}`}>{nf(r.ivChg5m, 1)}</TD>
              <TD cls={`num text-right ${signColor(r.straddlePct5m)}`}>{nf(r.straddlePct5m, 0)}</TD>
              <TD cls={`num text-right ${signColor(r.netGex)}`}>{compact(r.netGex)}</TD>
              <TD cls="num text-right">{nf(r.pcr, 2)}</TD>
              <TD cls="num text-right">{nf(r.mpDistPct, 2)}%</TD>
              <TD cls="text-[10px] text-term-dim">{r.reasons[0] ?? "—"}</TD>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
