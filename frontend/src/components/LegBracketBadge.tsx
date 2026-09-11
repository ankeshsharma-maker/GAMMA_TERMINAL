import { useState } from "react";
import { api } from "../lib/api";
import { nf } from "../lib/format";

export type LegRule = {
  id: string;
  symbol: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  status: string;
  sl: number | null;
  target: number | null;
  trail: number | null;
  unit: "pts" | "pct" | "rs";
  entryPx: number | null;
};

// mirrors backend parse_noren_tsym (app/brokers/flattrade.py) -- for
// matching a position row to its bracket rule client-side only; the
// backend re-parses the tsym itself when a bracket is actually created.
const TSYM_RE = /^([A-Z]+)(\d{2}[A-Z]{3}\d{2})([CP])(\d+(?:\.\d+)?)$/;
export function parseTsym(tsym: string | undefined | null) {
  const m = TSYM_RE.exec((tsym || "").toUpperCase());
  if (!m) return null;
  return { symbol: m[1], optionType: m[3] === "C" ? "CE" : "PE", strike: Number(m[4]) };
}

/** Find the active bracket (if any) for a raw broker position row. */
export function findBracket(r: any, rules: LegRule[]): LegRule | undefined {
  const p = parseTsym(r.tsym);
  if (!p) return undefined;
  return rules.find(
    (x) =>
      x.status === "active" &&
      x.symbol === p.symbol &&
      x.optionType === p.optionType &&
      Math.abs(x.strike - p.strike) < 1e-6
  );
}

const SEG = "px-1.5 py-0.5";
const on = "bg-term-accent text-white";
const off = "text-term-dim";

/** Attach / show / clear a target-stop-loss bracket on an already-open
 *  broker position (manual 1-click / scalp / anything AutoBot or a leg
 *  rule didn't itself open). Mirrors StopEditor's paper-position UI. */
export function LegBracketBadge({
  r,
  bracket,
  onChanged,
}: {
  r: any;
  bracket: LegRule | undefined;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [unit, setUnit] = useState<"pts" | "pct" | "rs">("pts");
  const [sl, setSl] = useState("");
  const [target, setTarget] = useState("");
  const [trail, setTrail] = useState("");
  const [busy, setBusy] = useState(false);

  const entryPx = Number(r.netavgprc ?? r.daybuyavgprc ?? r.daysellavgprc ?? 0);

  const attach = async () => {
    if (!sl && !target && !trail) return alert("Set a stop-loss, target or trail");
    if (!entryPx) return alert("No entry price on this position yet — try again in a moment");
    setBusy(true);
    try {
      await api.legRuleAttach({
        tsym: r.tsym,
        exch: r.exch || "NFO",
        netqty: r.netqty,
        entryPx,
        prd: r.prd,
        unit,
        sl: sl || null,
        target: target || null,
        trail: trail || null,
      });
      setOpen(false);
      setSl("");
      setTarget("");
      setTrail("");
      onChanged();
    } catch (e: any) {
      alert(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!bracket) return;
    setBusy(true);
    try {
      await api.legRuleDel(bracket.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    if (bracket) {
      const u = bracket.unit === "pct" ? "%" : bracket.unit === "rs" ? "₹" : "pts";
      return (
        <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1 text-[10px] text-amber-400">
          <span title={`bracketed from entry ${nf(bracket.entryPx, 2)}`}>
            {bracket.sl != null && <>SL {bracket.sl}{u}</>}
            {bracket.target != null && (
              <span className={bracket.sl != null ? "ml-1 text-up" : "text-up"}>
                TGT {bracket.target}{u}
              </span>
            )}
            {bracket.trail != null && (
              <span className="ml-1 rounded bg-amber-500/30 px-0.5 text-[8px]">TRL {bracket.trail}</span>
            )}
          </span>
          <button disabled={busy} onClick={clear} className="hover:text-down" title="Remove bracket">
            ×
          </button>
        </span>
      );
    }
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded border border-term-border px-1 text-[10px] text-term-dim hover:text-term-text"
        title="Auto square-off this position at a target / stop-loss"
      >
        + SL / TGT
      </button>
    );
  }

  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-1 rounded border border-amber-500/40 bg-term-panel p-1 text-[10px]"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex overflow-hidden rounded border border-term-border">
        {(["pts", "pct", "rs"] as const).map((u) => (
          <button key={u} onClick={() => setUnit(u)} className={`${SEG} ${unit === u ? on : off}`}>
            {u === "pts" ? "Pts" : u === "pct" ? "%" : "₹"}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1 text-down">
        SL
        <input
          value={sl}
          onChange={(e) => setSl(e.target.value.replace(/[^\d.]/g, ""))}
          placeholder="0"
          className="num w-12 rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text outline-none focus:border-term-accent"
        />
      </label>
      <label className="flex items-center gap-1 text-up">
        TGT
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value.replace(/[^\d.]/g, ""))}
          placeholder="0"
          className="num w-12 rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text outline-none focus:border-term-accent"
        />
      </label>
      <label className="flex items-center gap-1 text-term-dim">
        trail
        <input
          value={trail}
          onChange={(e) => setTrail(e.target.value.replace(/[^\d.]/g, ""))}
          placeholder="0"
          className="num w-12 rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text outline-none focus:border-term-accent"
        />
      </label>
      <button disabled={busy} onClick={attach} className="rounded bg-amber-500/30 px-1.5 py-0.5 text-amber-300">
        {busy ? "…" : "Set"}
      </button>
      <button onClick={() => setOpen(false)} className="px-1 text-term-dim hover:text-term-text">
        ✕
      </button>
    </div>
  );
}
