import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { compact, nf, sk, signColor, oiCr } from "../lib/format";
import type { HotStrike, ScanRow } from "../types";
import { Num } from "./Screener";

type Spec = {
  scoreMin?: number;
  dteMax?: number;
  building?: boolean;
  hotOnly?: boolean;
  bias?: "UP" | "DOWN";
};

const LS_KEY = "blastFilter";

const loadSpec = (): Spec => {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
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

function Chip({
  on,
  onClick,
  title,
  children,
}: {
  on?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} title={title} className={`chipbtn ${on ? "on" : ""}`}>
      {children}
    </button>
  );
}

function HotCell({ hs }: { hs?: HotStrike[] }) {
  if (!hs?.length) return <span className="text-term-dim">—</span>;
  return (
    <div className="flex flex-col gap-0.5">
      {hs.map((h) => (
        <span
          key={`${h.strike}${h.side}`}
          className={`num whitespace-nowrap text-[10.5px] font-semibold ${hotStyle(h)}`}
          title={`${h.side} OI now ${oiCr(h.oi)} · ${h.chg >= 0 ? "built" : "unwound"} ${nf(
            Math.abs(h.chg) / 1e7,
            1
          )}L (${nf(Math.abs(h.pct), 0)}%) in ~${h.mins} min`}
        >
          {sk(h.strike)} {h.side} {h.chg >= 0 ? "+" : "−"}
          {nf(Math.abs(h.chg) / 1e7, 2)}Cr{" "}
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
  const [spec, setSpec] = useState<Spec>(loadSpec);
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(spec));
    } catch {
      /* storage blocked: the filter just won't survive a reload */
    }
  }, [spec]);
  const patch = (p: Partial<Spec>) => setSpec((s) => ({ ...s, ...p }));

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-term-border bg-term-panel2 px-3 py-2">
        <Num label="Score≥" value={spec.scoreMin} onChange={(v) => patch({ scoreMin: v })} />
        <Num label="DTE≤" value={spec.dteMax} onChange={(v) => patch({ dteMax: v })} />
        <Chip
          on={spec.building}
          onClick={() => patch({ building: spec.building ? undefined : true })}
          title="Blast score climbing fast over the last 5 minutes (the trigger of the 'starting to build' alert)"
        >
          Building
        </Chip>
        <Chip
          on={spec.hotOnly}
          onClick={() => patch({ hotOnly: spec.hotOnly ? undefined : true })}
          title="A near-ATM strike with an outsized OI move in the last ~15 minutes"
        >
          Hot OI strike
        </Chip>
        <div className="flex gap-1">
          {(["UP", "DOWN"] as const).map((b) => (
            <Chip key={b} on={spec.bias === b} onClick={() => patch({ bias: spec.bias === b ? undefined : b })}>
              {b === "UP" ? "Bias up" : "Bias down"}
            </Chip>
          ))}
        </div>
        <button onClick={() => setSpec({})} className="btn px-2 py-0.5 text-2xs">
          Reset
        </button>
      </div>

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

      <div className="min-h-0 flex-1 overflow-auto p-2">
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
              <TD cls="num text-right">
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
    </div>
  );
}
