import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { nf, sk } from "../lib/format";
import type { ShortGuardLeg } from "../types";

/** Every open short option with its live delta: amber past 0.30, red past 0.40
 *  (the backend also alerts once per level), and the roll back to ~0.20 delta
 *  priced at the live quotes. Renders nothing when there are no short options. */
export function ShortGuard() {
  const [legs, setLegs] = useState<ShortGuardLeg[]>([]);
  const [levels, setLevels] = useState<number[]>([0.3, 0.4]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.shortGuard().then(
        (d) => {
          if (!alive) return;
          setLegs(d.legs);
          setLevels(d.levels);
        },
        () => {}
      );
    load();
    const id = window.setInterval(() => !document.hidden && load(), 10000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  if (!legs.length) return null;
  return (
    <div className="border-b border-term-border bg-term-panel px-3 py-2">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-[10px]">
        <span className="font-semibold uppercase tracking-wide text-term-dim">Short-strike guard</span>
        <span className="text-term-dim">
          every option you've SOLD · warns when the market heads for your strike (Δ {levels.map((l) => nf(l, 2)).join(" / ")})
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {legs.map((r) => (
          <GuardLeg key={`${r.src}-${r.symbol}-${r.expiry}-${r.strike}-${r.ot}`} r={r} />
        ))}
      </div>
    </div>
  );
}

/** "+₹102" / "−₹3,600" -- a word joiner keeps the sign on the same line as the amount */
export const rs = (v: number) => `${v > 0 ? "+\u2060" : v < 0 ? "−\u2060" : ""}₹${nf(Math.abs(v), 0)}`;

/** the leg's status in plain words: how far the market is from the strike,
 *  P&L now, what the next move against it costs, and the exit price */
export function guardText(r: ShortGuardLeg) {
  const put = r.ot === "PE";
  const d = r.distance ?? 0;
  const itm = d < 0;
  const side = (put && itm) || (!put && !itm) ? "below" : "above";
  return {
    tag: r.level >= 2 ? "DANGER" : r.level === 1 ? "WARNING" : "OK",
    where:
      r.distance == null
        ? "–"
        : itm
        ? `in the money — ${r.symbol} is ${nf(Math.abs(d), 0)} pts ${side} your strike`
        : `${r.symbol} is ${nf(Math.abs(d), 0)} pts ${side} your strike`,
    next:
      r.moveCost != null && r.move != null
        ? `next ${nf(r.move, 0)} pts ${put ? "down" : "up"} ≈\u00a0${rs(-r.moveCost)}`
        : null,
  };
}

function GuardLeg({ r }: { r: ShortGuardLeg }) {
  const t = guardText(r);
  const tone =
    r.level >= 2 ? "bg-down/20 text-down" : r.level === 1 ? "bg-amber-500/20 text-amber-400" : "bg-up/15 text-up";
  return (
    <div className="rounded-md bg-term-bg/50 px-2.5 py-1.5 text-[12px] tabular-nums">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="font-semibold text-term-text">
            {r.symbol} {sk(r.strike)} {r.ot}
          </span>
          <span className="ml-1.5 text-[10px] text-term-dim">
            you SOLD {nf(r.qty, 0)} · {r.src} · {r.expiry}
          </span>
        </span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold ${tone}`}>{t.tag}</span>
      </div>
      {r.reason ? (
        <div className="mt-0.5 text-[11px] text-term-dim">{r.reason}</div>
      ) : (
        <>
          <div className={`mt-0.5 text-[11px] ${r.distance != null && r.distance < 0 ? "text-down" : "text-term-dim"}`}>
            {t.where}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-term-dim">
            {r.pnl != null && (
              <span>
                P&L now <span className={r.pnl >= 0 ? "text-up" : "text-down"}>{rs(r.pnl)}</span>
              </span>
            )}
            {t.next && <span>{t.next}</span>}
          </div>
          {r.level > 0 && r.buyBack != null && (
            <div className="mt-0.5 text-[11px] text-term-text">
              👉 {r.level >= 2 ? "Exit now" : "Consider exiting"}: buy back {nf(r.qty, 0)} @ ~{nf(r.buyBack, 2)}
              {r.roll && (
                <span className="text-term-dim">
                  {" "}
                  · or move {r.ot === "PE" ? "down" : "up"} to {sk(r.roll.strike)} {r.ot} ({r.roll.netPerUnit >= 0 ? "collects" : "costs"} ₹
                  {nf(Math.abs(r.roll.netTotal), 0)})
                </span>
              )}
            </div>
          )}
          <div className="mt-0.5 text-[9px] text-term-dim/80">delta {r.absDelta != null ? nf(r.absDelta, 2) : "–"}</div>
        </>
      )}
    </div>
  );
}
