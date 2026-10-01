import { useEffect, useState } from "react";
import { api, type RangeCheckData } from "../lib/api";
import { nf } from "../lib/format";

const VERDICT = {
  favourable: { word: "FAVOURABLE", cls: "border-up/50 bg-up/15 text-up" },
  average: { word: "AVERAGE", cls: "border-amber-500/50 bg-amber-500/15 text-amber-300" },
  poor: { word: "POOR", cls: "border-down/50 bg-down/15 text-down" },
} as const;

/** Range-day check for the selling side: how often this index stayed inside a band around its open until the close,
 *  on days like today (same weekday, same kind of opening gap). Price only -- not option premiums. */
export function RangeCheck({ symbol }: { symbol: string }) {
  const [d, setD] = useState<RangeCheckData | null>(null);
  useEffect(() => {
    let alive = true;
    setD(null);
    const load = () => api.rangeCheck(symbol).then((r) => alive && setD(r), () => {});
    load();
    const t = window.setInterval(load, 300000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [symbol]);
  if (!d || !d.ok) return null;
  const v = d.verdict ? VERDICT[d.verdict] : null;
  const cell = (s: { pInside: number; n: number } | null) =>
    s ? (
      <span className={s.pInside >= 80 ? "text-up" : s.pInside < 70 ? "text-down" : "text-term-text"}>{nf(s.pInside, 0)}%</span>
    ) : (
      <span className="text-term-dim">–</span>
    );
  const th = "border border-term-border px-2 py-1 text-[10px] font-medium uppercase text-term-dim";
  const td = "border border-term-border/60 px-2 py-1.5 text-center";
  return (
    <div className="mx-3 mt-2 rounded-lg border border-term-accent/40 bg-term-accent/10 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-term-dim">Range-day check · {d.symbol}</span>
        {v && <span className={`rounded border px-2 py-0.5 text-[11px] font-bold ${v.cls}`}>{v.word} for selling</span>}
      </div>
      <div className="mt-1 text-[12px] text-term-text">
        {d.weekday}
        {d.gapPct != null ? (
          <>
            {" "}· today's open{" "}
            <b className={d.gapPct >= 0 ? "text-up" : "text-down"}>
              {d.gapPct >= 0 ? "+" : ""}
              {nf(d.gapPct, 2)}%
            </b>{" "}
            ({d.gapKind})
          </>
        ) : (
          <span className="text-term-dim"> · opening gap shows once the market opens</span>
        )}
        {d.verdictP != null && <> — in similar past days the index stayed inside ±1% of its open <b>{nf(d.verdictP, 0)}%</b> of the time</>}
      </div>
      <table className="mt-2 w-full border-collapse text-[12px]">
        <thead>
          <tr>
            <th className={th}>Band from open</th>
            <th className={th}>All days</th>
            <th className={th}>This weekday</th>
            <th className={th}>{d.gapKind ?? "Gap"} days</th>
            <th className={th}>Both</th>
            <th className={th}>Overshoot if broken</th>
          </tr>
        </thead>
        <tbody>
          {d.bands.map((b) => (
            <tr key={b.band} className={b.band === 1 ? "bg-term-panel2/60" : ""}>
              <td className={`${td} font-semibold`}>±{b.band}%</td>
              <td className={`${td} num`}>{cell(b.all)}</td>
              <td className={`${td} num`}>{cell(b.weekday)}</td>
              <td className={`${td} num`}>{cell(b.gap)}</td>
              <td className={`${td} num`}>{cell(b.both)}</td>
              <td className={`${td} num text-term-dim`}>{b.all ? `${nf(b.all.overshoot, 2)}%` : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-1.5 text-[11px] leading-snug text-term-dim">
        % of days the index never moved more than that far from its open, in either direction, until the close.
        Based on {d.days} days since {d.from}; average day range {nf(d.avgRangePct, 2)}%, worst close-to-close day {nf(d.worstCloseMovePct, 1)}%.
        Price only: it does not include the premium you collect or the loss on a broken day. Opening gaps of 0.5%+ have meant worse odds for a seller. Not advice.
      </div>
    </div>
  );
}
