import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf } from "../lib/format";
import type { ScreenerRow } from "../types";

const BUILDUP_LABEL: Record<string, string> = {
  LONG_BUILDUP: "Long buildup",
  SHORT_BUILDUP: "Short buildup",
  SHORT_COVERING: "Short covering",
  LONG_UNWINDING: "Long unwinding",
  NEUTRAL: "—",
};

/** Top gainers / losers for the day, ranked by session % move across the
 *  F&O universe (data from the running option screener). */
export function Movers() {
  const selectSymbol = useStore((s) => s.selectSymbol);
  const setView = useStore((s) => s.setView);
  const symClassOk = useStore((s) => s.symClassOk);
  const symClass = useStore((s) => s.symClass);

  const [rows, setRows] = useState<ScreenerRow[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [n, setN] = useState(15);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.screener().then((d) => {
        if (!alive) return;
        setRows(d.rows);
        setProgress(d.progress as any);
      }, () => {});
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const { gainers, losers } = useMemo(() => {
    const rk = rows
      .filter((r) => r.spot > 0 && symClassOk(r.symbol))
      .slice()
      .sort((a, b) => b.sessionMovePct - a.sessionMovePct);
    return {
      gainers: rk.filter((r) => r.sessionMovePct > 0).slice(0, n),
      losers: rk
        .filter((r) => r.sessionMovePct < 0)
        .slice(-n)
        .reverse(),
    };
  }, [rows, n, symClass, symClassOk]);

  const go = (sym: string) => {
    selectSymbol(sym, true);
    setView("chart");
  };

  const Col = ({ title, list, up }: { title: string; list: ScreenerRow[]; up: boolean }) => (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={`flex items-center justify-between border-b border-term-border px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide ${
          up ? "text-up" : "text-down"
        }`}
      >
        <span>{title}</span>
        <span className="text-term-dim">{list.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <div className="p-4 text-center text-2xs text-term-dim">
            {rows.length === 0 ? "waiting for screener…" : "none"}
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-2xs">
            <tbody>
              {list.map((r, i) => (
                <tr key={r.symbol}>
                  <td className="border-b border-term-border/40 px-2 py-1 text-right text-term-dim">
                    {i + 1}
                  </td>
                  <td className="border-b border-term-border/40 px-2 py-1">
                    <button
                      className="font-semibold text-term-accent hover:underline"
                      onClick={() => go(r.symbol)}
                    >
                      {r.symbol}
                    </button>
                  </td>
                  <td className="num border-b border-term-border/40 px-2 py-1 text-right">
                    {nf(r.spot, 1)}
                  </td>
                  <td
                    className={`num border-b border-term-border/40 px-2 py-1 text-right font-semibold ${
                      r.sessionMovePct >= 0 ? "text-up" : "text-down"
                    }`}
                  >
                    {r.sessionMovePct >= 0 ? "+" : ""}
                    {nf(r.sessionMovePct, 2)}%
                  </td>
                  <td className="border-b border-term-border/40 px-2 py-1 text-[10px] text-term-dim">
                    {BUILDUP_LABEL[r.oiBuildup] ?? r.oiBuildup}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
        <span className="font-semibold uppercase tracking-wide">Top movers · today</span>
        <label className="flex items-center gap-1">
          show
          <select
            value={n}
            onChange={(e) => setN(Number(e.target.value))}
            className="rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text"
          >
            {[10, 15, 20, 30].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          each
        </label>
        {progress && progress.total > 0 && progress.done < progress.total && (
          <span>
            scanning {progress.done}/{progress.total}
          </span>
        )}
        <span className="ml-auto">ranked by session % move · F&amp;O universe</span>
      </div>
      <div className="flex min-h-0 flex-1 divide-x divide-term-border">
        <Col title="Top gainers" list={gainers} up />
        <Col title="Top losers" list={losers} up={false} />
      </div>
    </div>
  );
}
