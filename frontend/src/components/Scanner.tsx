import { Fragment, useMemo, useState } from "react";
import { useStore } from "../store";
import { compact, nf, sk, signColor, oiCr } from "../lib/format";
import type { HotStrike, ScanRow } from "../types";
import { Num } from "./Screener";

export type Spec = {
  scoreMin?: number;
  dteMax?: number;
  building?: boolean;
  hotOnly?: boolean;
  bias?: "UP" | "DOWN";
};

const matches = (r: ScanRow, s: Spec) =>
  (s.scoreMin == null || r.score >= s.scoreMin) &&
  (s.dteMax == null || r.dte <= s.dteMax) &&
  (!s.building || r.building === true) &&
  (!s.hotOnly || (r.hotStrikes?.length ?? 0) > 0) &&
  (!s.bias || r.bias === s.bias);

const PRESETS: [string, string, Spec][] = [
  [
    "Building + hot strike",
    "Same trigger as the 'starting to build' alert: the score is climbing fast AND a near-ATM strike has an outsized OI move",
    { building: true, hotOnly: true },
  ],
  ["Building", "Blast score climbing fast over the last 5 minutes", { building: true }],
  ["Hot OI strike", "A near-ATM strike with an outsized OI move in the last ~15 minutes", { hotOnly: true }],
  ["Expiry day", "Days to expiry ≤ 1 — the only time the score can reach its alert levels", { dteMax: 1 }],
  ["Score ≥ 60", "Already at the warning level", { scoreMin: 60 }],
];

const specKey = (s: Spec) =>
  JSON.stringify(Object.entries(s).filter(([, v]) => v != null && v !== false).sort());

// same 4-colour OI scheme as the OI Profile: call add red, call cut amber, put add green, put cut sky
const hotStyle = (h: HotStrike) =>
  h.side === "CE" ? (h.chg >= 0 ? "text-down" : "text-amber-400") : h.chg >= 0 ? "text-up" : "text-sky-400";

function HotCell({ hs }: { hs?: HotStrike[] }) {
  if (!hs?.length) return <span className="text-term-dim">—</span>;
  return (
    <div className="flex flex-col gap-0.5">
      {hs.map((h) => (
        <span
          key={`${h.strike}${h.side}`}
          className={`num whitespace-nowrap text-[10.5px] font-semibold ${hotStyle(h)}`}
          title={`${h.side} OI now ${oiCr(h.oi)} · ${h.chg >= 0 ? "built" : "unwound"} ${oiCr(Math.abs(h.chg))} (${nf(
            Math.abs(h.pct),
            0
          )}%) in ~${h.mins} min`}
        >
          {sk(h.strike)} {h.side} {h.chg >= 0 ? "+" : "−"}
          {oiCr(Math.abs(h.chg))}{" "}
          <span className="font-normal opacity-80">
            ({h.pct >= 0 ? "+" : "−"}
            {nf(Math.abs(h.pct), 0)}%)
          </span>
        </span>
      ))}
    </div>
  );
}

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
      <span className={`num w-8 text-center text-base font-bold ${scoreText(r.score)}`}>
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
      r ? "text-center" : "text-left"
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

export function Scanner({ spec, setSpec }: { spec: Spec; setSpec: (s: Spec) => void }) {
  const { scan, selectSymbol, setView, symClassOk } = useStore();

  const all = useMemo(() => scan.filter((r) => symClassOk(r.symbol)), [scan, symClassOk]);
  const rows = useMemo(
    () => all.filter((r) => matches(r, spec)).sort((a, b) => b.score - a.score),
    [all, spec]
  );
  const openScrip = (sym: string) => {
    selectSymbol(sym, true);
    setView("scrip");
  };
  const filtered = specKey(spec) !== "[]";
  const [openRow, setOpenRow] = useState<string | null>(null);
  const cth = "border-b border-r border-term-border px-1 py-1.5 text-center font-medium";
  const ctd = "border-b border-r border-term-border/60 px-1 py-1.5 align-middle";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-term-border bg-term-panel2 px-3 py-1 text-2xs">
        <span className="text-term-dim">Presets:</span>
        {PRESETS.map(([name, hint, p]) => (
          <button
            key={name}
            title={hint}
            onClick={() => setSpec(p)}
            className={`rounded border px-1.5 py-0.5 ${
              specKey(spec) === specKey(p)
                ? "border-term-accent bg-term-accent/20 text-term-text"
                : "border-term-dim/70 text-term-dim hover:bg-term-border hover:text-term-text"
            }`}
          >
            {name}
          </button>
        ))}
        <span className="ml-auto text-term-dim">
          {rows.length} of {all.length} watchlist symbols match
        </span>
      </div>

      {/* folded phone (Galaxy Z Fold6 cover screen, ~370 px): the 6 columns that matter fit the width;
          the other 10 fold open under a row when it's tapped. sm+ (unfolded / laptop): the full table */}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5 sm:hidden">
        <table className="grid-table w-full table-fixed text-[11px]">
          <colgroup>
            <col style={{ width: "24%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "10%" }} />
            <col />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-term-panel text-[9px] uppercase text-term-dim">
            <tr>
              <th className={`${cth} text-left`}>Symbol</th>
              <th className={cth}>Score</th>
              <th className={cth}>Δ5m</th>
              <th className={cth}>Bias</th>
              <th className={cth}>DTE</th>
              <th className={`${cth} text-left`}>Hot strike</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="border border-term-border px-3 py-8 text-center text-term-dim">
                  {all.length === 0 ? "warming up — the scanner needs a few polls of history…" : "No watchlist symbol matches right now."}
                  {filtered && all.length > 0 && (
                    <div className="mt-2">
                      <button onClick={() => setSpec({})} className="btn px-2 py-0.5 text-2xs">
                        Reset filters
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            )}
            {rows.map((r, i) => {
              const open = openRow === r.symbol;
              const h = r.hotStrikes?.[0];
              return (
                <Fragment key={r.symbol}>
                  <tr
                    onClick={() => setOpenRow(open ? null : r.symbol)}
                    className={`click-row ${open ? "bg-term-accent/10" : i % 2 ? "bg-term-panel2/40" : ""}`}
                  >
                    <td className={ctd}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openScrip(r.symbol);
                        }}
                        title="Open chart + OI + chain"
                        className="block w-full truncate text-left text-[11.5px] font-semibold text-term-text"
                      >
                        {r.symbol}
                        <span className="text-term-accent">›</span>
                      </button>
                      <span className="text-[9px] text-term-dim">{open ? "▴ less" : "▾ more"}</span>
                    </td>
                    <td className={`${ctd} text-center`}>
                      <div className={`num text-[14px] font-bold leading-tight ${scoreText(r.score)}`}>{nf(r.score, 0)}</div>
                      <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-term-border">
                        <div className={`h-full ${scoreColor(r.score)}`} style={{ width: `${Math.min(100, r.score)}%` }} />
                      </div>
                    </td>
                    <td className={`${ctd} num text-center`}>
                      {r.scoreChg5m == null ? (
                        <span className="text-term-dim">—</span>
                      ) : (
                        <span className={`${signColor(r.scoreChg5m)} ${r.building ? "font-bold" : ""}`}>
                          {r.scoreChg5m > 0 ? "+" : ""}
                          {nf(r.scoreChg5m, 0)}
                        </span>
                      )}
                      {r.building && <div className="text-[8px] font-bold text-amber-400">BUILDING</div>}
                    </td>
                    <td className={`${ctd} text-center`}>
                      <span className={`rounded px-1 py-0.5 text-[9px] font-semibold ${biasPill(r.bias)}`}>
                        {r.bias === "UP" ? "▲ UP" : r.bias === "DOWN" ? "▼ DN" : "–"}
                      </span>
                    </td>
                    <td className={`${ctd} num text-center`}>{nf(r.dte, 1)}</td>
                    <td className={ctd}>
                      {h ? (
                        <div className={`num leading-tight ${hotStyle(h)}`}>
                          <div className="truncate font-semibold">
                            {sk(h.strike)} {h.side}
                          </div>
                          <div className="truncate text-[9.5px]">
                            {h.chg >= 0 ? "+" : "−"}
                            {oiCr(Math.abs(h.chg))} ({h.pct >= 0 ? "+" : "−"}
                            {nf(Math.abs(h.pct), 0)}%)
                          </div>
                          {(r.hotStrikes?.length ?? 0) > 1 && (
                            <div className="text-[9px] font-normal text-term-dim">+{(r.hotStrikes?.length ?? 1) - 1} more</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-term-dim">—</span>
                      )}
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={6} className="border-b border-term-border bg-term-panel2/60 px-2 py-2">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="mb-0.5 text-[9px] uppercase text-term-dim">Sub-scores</div>
                            <CompBars c={r.components} />
                          </div>
                          {(r.hotStrikes?.length ?? 0) > 1 && (
                            <div className="min-w-0">
                              <div className="mb-0.5 text-[9px] uppercase text-term-dim">Hot OI strikes (~15m)</div>
                              <HotCell hs={r.hotStrikes} />
                            </div>
                          )}
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-x-3 text-[11px]">
                          {(
                            [
                              ["Spot", nf(r.spot, 0), ""],
                              ["5m Δ%", nf(r.move5mPct, 2), signColor(r.move5mPct)],
                              ["ATM IV", nf(r.atmIV, 1), ""],
                              ["IV Δ5m", nf(r.ivChg5m, 1), signColor(r.ivChg5m)],
                              ["Straddle Δ5m%", nf(r.straddlePct5m, 0), signColor(r.straddlePct5m)],
                              ["Net GEX", compact(r.netGex), signColor(r.netGex)],
                              ["PCR", nf(r.pcr, 2), ""],
                              ["|Spot − max pain|", `${nf(r.mpDistPct, 2)}%`, ""],
                            ] as [string, string, string][]
                          ).map(([k, v, c]) => (
                            <div key={k} className="flex items-baseline justify-between border-b border-term-border/40 py-1">
                              <span className="text-term-dim">{k}</span>
                              <span className={`num ${c || "text-term-text"}`}>{v}</span>
                            </div>
                          ))}
                        </div>
                        {r.reasons[0] && <div className="mt-1.5 text-[10.5px] leading-snug text-term-dim">{r.reasons[0]}</div>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="hidden min-h-0 flex-1 overflow-auto p-2 sm:block">
      <table className="grid-table text-xs">
        <thead className="sticky top-0 z-10 bg-term-panel text-[10px] uppercase text-term-dim">
          <tr>
            <TH>Symbol</TH>
            <TH>Blast Score</TH>
            <TH r>Δ score 5m</TH>
            <TH>Hot OI strike (~15m)</TH>
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
              <td colSpan={16} className="border border-term-border px-3 py-10 text-center text-term-dim">
                {all.length === 0 ? (
                  "warming up — the scanner needs a few polls of history…"
                ) : (
                  <>
                    No watchlist symbol matches {filtered ? "these filters" : "yet"} right now.
                    <br />
                    <span className="text-[10px]">
                      The scanner covers your watchlist symbols — add a symbol to a watchlist to include it.
                    </span>
                    {filtered && (
                      <div className="mt-2">
                        <button onClick={() => setSpec({})} className="btn px-2 py-0.5 text-2xs">
                          Reset filters
                        </button>
                      </div>
                    )}
                  </>
                )}
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
              <TD cls="num text-center">
                {r.scoreChg5m == null ? (
                  <span className="text-term-dim">—</span>
                ) : (
                  <span className={`${signColor(r.scoreChg5m)} ${r.building ? "font-bold" : ""}`}>
                    {r.scoreChg5m > 0 ? "+" : ""}
                    {nf(r.scoreChg5m, 0)}
                  </span>
                )}
                {r.building && (
                  <span className="ml-1 rounded bg-amber-500/20 px-1 text-[9px] font-semibold text-amber-400">
                    BUILDING
                  </span>
                )}
              </TD>
              <TD>
                <HotCell hs={r.hotStrikes} />
              </TD>
              <TD>
                <CompBars c={r.components} />
              </TD>
              <TD>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${biasPill(r.bias)}`}>
                  {r.bias}
                </span>
              </TD>
              <TD cls="num text-center">{nf(r.dte, 1)}</TD>
              <TD cls="num text-center">{nf(r.spot, 0)}</TD>
              <TD cls={`num text-center ${signColor(r.move5mPct)}`}>{nf(r.move5mPct, 2)}</TD>
              <TD cls="num text-center">{nf(r.atmIV, 1)}</TD>
              <TD cls={`num text-center ${signColor(r.ivChg5m)}`}>{nf(r.ivChg5m, 1)}</TD>
              <TD cls={`num text-center ${signColor(r.straddlePct5m)}`}>{nf(r.straddlePct5m, 0)}</TD>
              <TD cls={`num text-center ${signColor(r.netGex)}`}>{compact(r.netGex)}</TD>
              <TD cls="num text-center">{nf(r.pcr, 2)}</TD>
              <TD cls="num text-center">{nf(r.mpDistPct, 2)}%</TD>
              <TD cls="text-[10px] text-term-dim">{r.reasons[0] ?? "—"}</TD>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
