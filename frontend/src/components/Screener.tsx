import { useMemo, useState } from "react";
import { useStore } from "../store";
import { nf, signColor, compact } from "../lib/format";
import type { OIBuildup, ScreenerRow } from "../types";

type Spec = {
  ivRankMin?: number;
  ivRankMax?: number;
  pcrMin?: number;
  pcrMax?: number;
  atmIVMin?: number;
  dteMax?: number;
  sessionMoveMin?: number;
  sessionMoveMax?: number;
  straddlePctMin?: number;
  oiBuildup?: OIBuildup[];
  sortBy?: keyof ScreenerRow;
  sortDir?: "asc" | "desc";
};

const BUILDUPS: OIBuildup[] = [
  "LONG_BUILDUP",
  "SHORT_BUILDUP",
  "SHORT_COVERING",
  "LONG_UNWINDING",
];

const buildupStyle: Record<OIBuildup, string> = {
  LONG_BUILDUP: "bg-up/20 text-up",
  SHORT_BUILDUP: "bg-down/20 text-down",
  SHORT_COVERING: "bg-cyan-500/20 text-cyan-400",
  LONG_UNWINDING: "bg-amber-500/20 text-amber-400",
  NEUTRAL: "bg-term-border text-term-dim",
};

const buildupLabel: Record<OIBuildup, string> = {
  LONG_BUILDUP: "Long Buildup",
  SHORT_BUILDUP: "Short Buildup",
  SHORT_COVERING: "Short Covering",
  LONG_UNWINDING: "Long Unwind",
  NEUTRAL: "—",
};

function applySpec(rows: ScreenerRow[], s: Spec): ScreenerRow[] {
  const ok = (r: ScreenerRow) =>
    (s.ivRankMin == null || (r.ivRank != null && r.ivRank >= s.ivRankMin)) &&
    (s.ivRankMax == null || (r.ivRank != null && r.ivRank <= s.ivRankMax)) &&
    (s.pcrMin == null || (r.pcr != null && r.pcr >= s.pcrMin)) &&
    (s.pcrMax == null || (r.pcr != null && r.pcr <= s.pcrMax)) &&
    (s.atmIVMin == null || (r.atmIV != null && r.atmIV >= s.atmIVMin)) &&
    (s.dteMax == null || (r.dte != null && r.dte <= s.dteMax)) &&
    (s.sessionMoveMin == null || r.sessionMovePct >= s.sessionMoveMin) &&
    (s.sessionMoveMax == null || r.sessionMovePct <= s.sessionMoveMax) &&
    (s.straddlePctMin == null ||
      (r.straddlePctOfSpot != null && r.straddlePctOfSpot >= s.straddlePctMin)) &&
    (!s.oiBuildup?.length || s.oiBuildup.includes(r.oiBuildup));

  const sortBy = s.sortBy ?? "ivRank";
  const dir = s.sortDir === "asc" ? 1 : -1;
  return rows.filter(ok).sort((a, b) => {
    const av = a[sortBy] as number | null;
    const bv = b[sortBy] as number | null;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
  });
}

function Num({
  label,
  value,
  onChange,
  w = "w-14",
}: {
  label: string;
  value?: number;
  onChange: (v: number | undefined) => void;
  w?: string;
}) {
  return (
    <label className="flex items-center gap-1 text-2xs text-term-dim">
      {label}
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        className={`${w} rounded border border-term-border bg-term-bg px-1 py-0.5 num text-term-text outline-none focus:border-term-accent`}
      />
    </label>
  );
}

export function Screener() {
  const { screener, screenerProgress, screenerPresets, selectSymbol } = useStore();
  const [spec, setSpec] = useState<Spec>({ sortBy: "ivRank", sortDir: "desc" });

  const patch = (p: Partial<Spec>) => setSpec((s) => ({ ...s, ...p }));
  const toggleBuildup = (b: OIBuildup) =>
    setSpec((s) => {
      const cur = new Set(s.oiBuildup ?? []);
      cur.has(b) ? cur.delete(b) : cur.add(b);
      return { ...s, oiBuildup: [...cur] };
    });

  const rows = useMemo(() => applySpec(screener, spec), [screener, spec]);
  const p = screenerProgress;

  const applyPreset = (name: string) => {
    const preset = screenerPresets[name] as Partial<Spec> | undefined;
    if (preset) setSpec((s) => ({ sortBy: s.sortBy, sortDir: s.sortDir, ...preset }));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-term-border bg-term-panel2 px-3 py-2">
        <Num label="IVR≥" value={spec.ivRankMin} onChange={(v) => patch({ ivRankMin: v })} />
        <Num label="IVR≤" value={spec.ivRankMax} onChange={(v) => patch({ ivRankMax: v })} />
        <Num label="PCR≥" value={spec.pcrMin} onChange={(v) => patch({ pcrMin: v })} />
        <Num label="PCR≤" value={spec.pcrMax} onChange={(v) => patch({ pcrMax: v })} />
        <Num label="ATM IV≥" value={spec.atmIVMin} onChange={(v) => patch({ atmIVMin: v })} />
        <Num label="DTE≤" value={spec.dteMax} onChange={(v) => patch({ dteMax: v })} />
        <Num label="Move%≥" value={spec.sessionMoveMin} onChange={(v) => patch({ sessionMoveMin: v })} />
        <Num label="Strd%≥" value={spec.straddlePctMin} onChange={(v) => patch({ straddlePctMin: v })} />
        <div className="flex gap-1">
          {BUILDUPS.map((b) => (
            <button
              key={b}
              onClick={() => toggleBuildup(b)}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                spec.oiBuildup?.includes(b) ? buildupStyle[b] : "bg-term-panel text-term-dim"
              }`}
            >
              {buildupLabel[b]}
            </button>
          ))}
        </div>
        <button
          onClick={() => setSpec({ sortBy: "ivRank", sortDir: "desc" })}
          className="btn px-2 py-0.5 text-2xs"
        >
          Reset
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-term-border bg-term-panel2 px-3 py-1 text-2xs">
        <span className="text-term-dim">Presets:</span>
        {Object.keys(screenerPresets).map((name) => (
          <button
            key={name}
            onClick={() => applyPreset(name)}
            className="rounded border border-term-border px-1.5 py-0.5 text-term-dim hover:bg-term-border hover:text-term-text"
          >
            {name}
          </button>
        ))}
        <span className="ml-auto text-term-dim">
          {p ? (
            <>
              scanned {p.scanned}/{p.total}
              {p.current ? ` · ${p.current}` : p.lastFull ? " · cycle complete" : ""} · {rows.length} match
            </>
          ) : (
            "loading…"
          )}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead className="sticky top-0 z-10 bg-term-panel text-[10px] uppercase text-term-dim">
            <tr>
              {(
                [
                  ["symbol", "Symbol"],
                  ["spot", "LTP"],
                  ["sessionMovePct", "Sess %"],
                  ["pcr", "PCR"],
                  ["atmIV", "ATM IV"],
                  ["ivRank", "IV Rank"],
                  ["straddlePctOfSpot", "Strd %"],
                  ["maxPainDistPct", "MP dist"],
                  ["dte", "DTE"],
                ] as [keyof ScreenerRow, string][]
              ).map(([key, label]) => (
                <th
                  key={key}
                  onClick={() =>
                    patch({
                      sortBy: key,
                      sortDir: spec.sortBy === key && spec.sortDir === "desc" ? "asc" : "desc",
                    })
                  }
                  className="cursor-pointer border-b border-term-border px-2 py-1.5 text-left font-medium hover:text-term-text"
                >
                  {label}
                  {spec.sortBy === key ? (spec.sortDir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
              <th className="border-b border-term-border px-2 py-1.5 text-left font-medium">OI Buildup</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-term-dim">
                  {screener.length === 0
                    ? "scanning the F&O universe — first rows appear within a minute…"
                    : "no symbols match these filters"}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.symbol}
                onClick={() => selectSymbol(r.symbol)}
                className="cursor-pointer border-b border-term-border/40 hover:bg-term-panel/60"
              >
                <td className="px-2 py-1.5 font-semibold">{r.symbol}</td>
                <td className="num px-2 py-1.5">{nf(r.spot, 1)}</td>
                <td className={`num px-2 py-1.5 ${signColor(r.sessionMovePct)}`}>
                  {nf(r.sessionMovePct, 2)}
                </td>
                <td className="num px-2 py-1.5">{nf(r.pcr, 2)}</td>
                <td className="num px-2 py-1.5">{nf(r.atmIV, 1)}</td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 w-14 overflow-hidden rounded bg-term-border">
                      <div
                        className={`h-full ${
                          (r.ivRank ?? 0) >= 70
                            ? "bg-down"
                            : (r.ivRank ?? 0) <= 30
                            ? "bg-up"
                            : "bg-term-accent"
                        }`}
                        style={{ width: `${r.ivRank ?? 0}%` }}
                      />
                    </div>
                    <span className="num w-7 text-right">{r.ivRank != null ? nf(r.ivRank, 0) : "–"}</span>
                  </div>
                </td>
                <td className="num px-2 py-1.5">{nf(r.straddlePctOfSpot, 2)}</td>
                <td className={`num px-2 py-1.5 ${signColor(r.maxPainDistPct)}`}>
                  {nf(r.maxPainDistPct, 2)}
                </td>
                <td className="num px-2 py-1.5">{nf(r.dte, 1)}</td>
                <td className="px-2 py-1.5">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${buildupStyle[r.oiBuildup]}`}>
                    {buildupLabel[r.oiBuildup]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
