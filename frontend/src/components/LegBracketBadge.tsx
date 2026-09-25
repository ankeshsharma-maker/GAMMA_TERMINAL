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
  unit: "px" | "pts" | "pct" | "rs";
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

/** round to the 0.05 tick */
const tick = (v: number) => Math.round(v * 20) / 20;

/** Set / show / edit / clear a stop-loss + target on ONE open broker leg. The
 *  server watches that leg's price and squares it off at market when one is
 *  hit -- even with the app closed. Default: actual PRICES (SL 120 / TGT 50),
 *  pre-filled from the current price; points / % / ₹ distances from entry are
 *  still there. */
export function LegBracketBadge({
  r,
  bracket,
  onChanged,
}: {
  r: any;
  bracket: LegRule | undefined;
  onChanged: () => void;
}) {
  const netqty = Number(r.netqty) || 0;
  const long = netqty > 0;
  const ltp = Number(r.lp) || 0;
  const entryPx = Number(r.netavgprc ?? r.daybuyavgprc ?? r.daysellavgprc ?? 0);

  const [open, setOpen] = useState(false);
  const [unit, setUnit] = useState<"px" | "pts" | "pct" | "rs">("px");
  const [sl, setSl] = useState("");
  const [target, setTarget] = useState("");
  const [trail, setTrail] = useState("");
  const [busy, setBusy] = useState(false);

  // a sensible start from the current price: SL 25% against, target 50% for (price mode)
  const startEdit = () => {
    if (bracket) {
      setUnit(bracket.unit);
      setSl(bracket.sl != null ? String(bracket.sl) : "");
      setTarget(bracket.target != null ? String(bracket.target) : "");
      setTrail(bracket.trail != null ? String(bracket.trail) : "");
    } else {
      setUnit("px");
      const base = ltp || entryPx;
      setSl(base ? nf(tick(long ? base * 0.75 : base * 1.25), 2).replace(/,/g, "") : "");
      setTarget(base ? nf(tick(long ? base * 1.5 : base * 0.5), 2).replace(/,/g, "") : "");
      setTrail("");
    }
    setOpen(true);
  };

  const save = async () => {
    if (!sl && !target && !trail) return alert("Set a stop-loss, target or trail");
    if (!entryPx) return alert("No entry price on this position yet — try again in a moment");
    if (unit === "px" && ltp) {
      const s = parseFloat(sl);
      const t = parseFloat(target);
      // a price stop / target on the wrong side of the market would fire at once
      if (sl && (long ? s >= ltp : s <= ltp))
        return alert(`SL ${s} is ${long ? "above" : "below"} the current price ${ltp} — it would exit immediately.`);
      if (target && (long ? t <= ltp : t >= ltp))
        return alert(`Target ${t} is ${long ? "below" : "above"} the current price ${ltp} — it would exit immediately.`);
    }
    setBusy(true);
    try {
      if (bracket) await api.legRuleDel(bracket.id); // edit = replace
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
      const u = bracket.unit === "px" ? "" : bracket.unit === "pct" ? "%" : bracket.unit === "rs" ? "₹" : "pts";
      return (
        <span className="inline-flex items-center gap-1.5 rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-amber-300">
          <span title={`watched by the server from entry ${nf(bracket.entryPx, 2)}; squares off at market when hit`}>
            {bracket.sl != null && <span className="text-down">SL {bracket.sl}{u}</span>}
            {bracket.target != null && (
              <span className={bracket.sl != null ? "ml-1.5 text-up" : "text-up"}>
                TGT {bracket.target}
                {u}
              </span>
            )}
            {bracket.trail != null && <span className="ml-1.5 text-amber-300">TRL {bracket.trail}</span>}
          </span>
          <button disabled={busy} onClick={startEdit} className="text-term-dim hover:text-term-text" title="Edit">
            ✎
          </button>
          <button disabled={busy} onClick={clear} className="text-term-dim hover:text-down" title="Remove">
            ×
          </button>
        </span>
      );
    }
    return (
      <button
        onClick={startEdit}
        className="rounded border border-amber-500/60 px-2 py-0.5 text-[11px] font-semibold text-amber-300 hover:bg-amber-500/10"
        title="Stop-loss / target on this leg: the server squares it off at market when hit"
      >
        + SL / TGT
      </button>
    );
  }

  const inp =
    "num w-16 rounded border border-term-border bg-term-bg px-1.5 py-1 text-[12px] text-term-text outline-none focus:border-term-accent";
  return (
    <div
      className="mt-1 flex w-full flex-col gap-1.5 rounded border border-amber-500/40 bg-term-panel p-2 text-[11px]"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-2 text-term-dim">
        <span>
          LTP <span className="num text-term-text">{nf(ltp, 2)}</span> · entry{" "}
          <span className="num text-term-text">{nf(entryPx, 2)}</span> · {long ? "long" : "short"}
        </span>
        <div className="seg ml-auto">
          {(["px", "pts", "pct", "rs"] as const).map((u) => (
            <button key={u} onClick={() => setUnit(u)} className={unit === u ? "on" : ""}>
              {u === "px" ? "Price" : u === "pts" ? "Pts" : u === "pct" ? "%" : "₹"}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1 text-down">
          SL
          <input id={`sl-${r.tsym}`} value={sl} onChange={(e) => setSl(e.target.value.replace(/[^\d.]/g, ""))} placeholder="–" className={inp} />
        </label>
        <label className="flex items-center gap-1 text-up">
          Target
          <input id={`tgt-${r.tsym}`} value={target} onChange={(e) => setTarget(e.target.value.replace(/[^\d.]/g, ""))} placeholder="–" className={inp} />
        </label>
        <label className="flex items-center gap-1 text-term-dim">
          trail pts
          <input id={`trl-${r.tsym}`} value={trail} onChange={(e) => setTrail(e.target.value.replace(/[^\d.]/g, ""))} placeholder="–" className={inp} />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] leading-snug text-term-dim">
          {unit === "px"
            ? long
              ? "Prices: SL below, target above the current price."
              : "Prices: SL above, target below the current price."
            : "Distances from your entry price."}{" "}
          The server exits at market when one is hit.
        </span>
        <button onClick={() => setOpen(false)} className="ml-auto rounded border border-term-border px-2 py-1 text-term-dim">
          Cancel
        </button>
        <button disabled={busy} onClick={save} className="rounded bg-amber-500 px-3 py-1 font-semibold text-black">
          {busy ? "…" : bracket ? "Update" : "Set"}
        </button>
      </div>
    </div>
  );
}
