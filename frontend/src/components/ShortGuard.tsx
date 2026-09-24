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
  const tone = (lvl: number) =>
    lvl >= 2 ? "bg-down/20 text-down" : lvl === 1 ? "bg-amber-500/20 text-amber-400" : "text-up";

  return (
    <div className="border-b border-term-border bg-term-panel px-3 py-2">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-[10px]">
        <span className="font-semibold uppercase tracking-wide text-term-dim">Short-strike guard</span>
        <span className="text-term-dim">
          alerts at Δ {levels.map((l) => nf(l, 2)).join(" / ")} · roll back to ~Δ 0.20
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="grid-table num text-[11px]">
          <thead className="bg-term-panel2 text-[10px] text-term-dim">
            <tr className="[&>th]:px-2 [&>th]:py-0.5 [&>th]:text-left">
              <th>Short leg</th>
              <th>Δ</th>
              <th>Strike vs spot</th>
              <th>Suggested roll (live quotes)</th>
            </tr>
          </thead>
          <tbody>
            {legs.map((r) => {
              const itm = r.distance != null && r.distance < 0;
              return (
                <tr key={`${r.src}-${r.symbol}-${r.expiry}-${r.strike}-${r.ot}`} className="[&>td]:px-2 [&>td]:py-1">
                  <td className="whitespace-nowrap">
                    <span className="font-semibold text-term-text">
                      {r.symbol} {sk(r.strike)} {r.ot}
                    </span>
                    <span className="ml-1 text-[9px] text-term-dim">
                      {r.src} · {nf(r.qty, 0)} qty · {r.expiry}
                    </span>
                  </td>
                  <td>
                    {r.absDelta == null ? (
                      <span className="text-term-dim">–</span>
                    ) : (
                      <span className={`rounded px-1.5 py-0.5 font-bold ${tone(r.level)}`}>{nf(r.absDelta, 2)}</span>
                    )}
                  </td>
                  <td className={`whitespace-nowrap ${itm ? "text-down" : "text-term-dim"}`}>
                    {r.distance == null ? "–" : itm ? `${nf(-r.distance, 0)} pts ITM` : `${nf(r.distance, 0)} pts away`}
                  </td>
                  <td className="whitespace-nowrap text-term-text">
                    {r.reason ? (
                      <span className="text-term-dim">{r.reason}</span>
                    ) : r.roll ? (
                      <>
                        → {sk(r.roll.strike)} {r.ot} <span className="text-term-dim">(Δ {nf(Math.abs(r.roll.delta), 2)})</span>
                        {" · "}
                        <span className={r.roll.netPerUnit >= 0 ? "text-up" : "text-down"}>
                          {r.roll.netPerUnit >= 0 ? "credit" : "debit"} {nf(Math.abs(r.roll.netPerUnit), 2)}/unit
                        </span>
                        <span className="text-term-dim"> (₹{nf(Math.abs(r.roll.netTotal), 0)})</span>
                      </>
                    ) : (
                      <span className="text-term-dim">safe — under Δ {nf(levels[0], 2)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
