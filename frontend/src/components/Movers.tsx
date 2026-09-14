import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { ago, nf } from "../lib/format";
import { SelectMenu } from "./SelectMenu";

const BUILDUP_LABEL: Record<string, string> = {
  LONG_BUILDUP: "Long buildup",
  SHORT_BUILDUP: "Short buildup",
  SHORT_COVERING: "Short covering",
  LONG_UNWINDING: "Long unwinding",
  NEUTRAL: "—",
};

type Row = { symbol: string; spot: number; movePct: number; buildup?: string };
type CompareRow = {
  symbol: string;
  spot: number;
  todayPct: number | null;
  yesterdayPct: number | null;
  sevenDayPct: number | null;
  buildup?: string;
};
type Timeframe = "today" | "yesterday" | "7d" | "compare";
type SortCol = "today" | "yesterday" | "7d";

const TF_LABEL: Record<"today" | "yesterday" | "7d", string> = {
  today: "today's session",
  yesterday: "yesterday's",
  "7d": "last 7 days'",
};

const Pct = ({ v }: { v: number | null }) => (
  <td
    className={`num border-b border-term-border/40 px-2 py-1 text-right font-semibold ${
      v == null ? "text-term-dim" : v >= 0 ? "text-up" : "text-down"
    }`}
  >
    {v == null ? "—" : `${v >= 0 ? "+" : ""}${nf(v, 2)}%`}
  </td>
);

/** Top gainers / losers, ranked by % move — Today from the live option
 *  screener (session move + OI buildup, polled every 15s), Yesterday / 7 Day
 *  from Upstox daily closes across the F&O universe (cached once per
 *  calendar day on the backend — see upstox_data.universe_returns).
 *  Compare merges all three into one sortable table per symbol, so a move
 *  can be read in context (e.g. "up today but down over 7 days") instead of
 *  only ever seeing one ranking at a time. */
export function Movers() {
  const selectSymbol = useStore((s) => s.selectSymbol);
  const setView = useStore((s) => s.setView);
  const symClassOk = useStore((s) => s.symClassOk);
  const symClass = useStore((s) => s.symClass);

  const [tf, setTf] = useState<Timeframe>("today");
  const [rows, setRows] = useState<Row[]>([]);
  const [compareRows, setCompareRows] = useState<CompareRow[]>([]);
  const [sortCol, setSortCol] = useState<SortCol>("today");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [n, setN] = useState(15);
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState<number | null>(null);
  const [asOfDate, setAsOfDate] = useState<string | null>(null);

  const loadToday = () => {
    setBusy(true);
    return api.screener().then(
      (d) => {
        setRows(
          d.rows.map((r) => ({
            symbol: r.symbol,
            spot: r.spot,
            movePct: r.sessionMovePct,
            buildup: r.oiBuildup,
          }))
        );
        setProgress(d.progress as any);
        setUpdated(Date.now() / 1000);
        setAsOfDate(null);
        setBusy(false);
      },
      () => setBusy(false)
    );
  };

  const loadHistory = (which: "yesterday" | "7d") => {
    setBusy(true);
    setProgress(null);
    return api.moversHistory().then(
      (d) => {
        setRows(
          d.rows.map((r) => ({
            symbol: r.symbol,
            spot: r.spot,
            movePct: (which === "yesterday" ? r.changePct1d : r.changePct7d) ?? 0,
          }))
        );
        setUpdated(Date.now() / 1000);
        setAsOfDate(d.date);
        setBusy(false);
      },
      () => setBusy(false)
    );
  };

  const loadCompare = () => {
    setBusy(true);
    setProgress(null);
    return Promise.all([api.screener(), api.moversHistory()]).then(
      ([s, h]) => {
        const hMap = new Map(h.rows.map((r) => [r.symbol, r]));
        setCompareRows(
          s.rows.map((r) => {
            const hr = hMap.get(r.symbol);
            return {
              symbol: r.symbol,
              spot: r.spot,
              todayPct: r.sessionMovePct,
              yesterdayPct: hr?.changePct1d ?? null,
              sevenDayPct: hr?.changePct7d ?? null,
              buildup: r.oiBuildup,
            };
          })
        );
        setUpdated(Date.now() / 1000);
        setAsOfDate(h.date);
        setBusy(false);
      },
      () => setBusy(false)
    );
  };

  const load = () => (tf === "today" ? loadToday() : tf === "compare" ? loadCompare() : loadHistory(tf));

  useEffect(() => {
    if (tf === "compare" || tf === "today") {
      const tick = () => (tf === "compare" ? loadCompare() : loadToday());
      tick();
      const t = setInterval(tick, 15000);
      return () => clearInterval(t);
    }
    loadHistory(tf);
  }, [tf]);

  const { gainers, losers } = useMemo(() => {
    const rk = rows
      .filter((r) => r.spot > 0 && symClassOk(r.symbol))
      .slice()
      .sort((a, b) => b.movePct - a.movePct);
    return {
      gainers: rk.filter((r) => r.movePct > 0).slice(0, n),
      losers: rk
        .filter((r) => r.movePct < 0)
        .slice(-n)
        .reverse(),
    };
  }, [rows, n, symClass, symClassOk]);

  const compareShown = useMemo(() => {
    const key: keyof CompareRow =
      sortCol === "today" ? "todayPct" : sortCol === "yesterday" ? "yesterdayPct" : "sevenDayPct";
    return compareRows
      .filter((r) => r.spot > 0 && symClassOk(r.symbol))
      .slice()
      .sort((a, b) => sortDir * (((a[key] as number) ?? 0) - ((b[key] as number) ?? 0)));
  }, [compareRows, sortCol, sortDir, symClass, symClassOk]);

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir((d) => (d === -1 ? 1 : -1));
    else {
      setSortCol(col);
      setSortDir(-1);
    }
  };

  const go = (sym: string) => {
    selectSymbol(sym, true);
    setView("chart");
  };

  const Col = ({ title, list, up }: { title: string; list: Row[]; up: boolean }) => (
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
            {rows.length === 0 ? (busy ? "loading…" : "waiting for data…") : "none"}
          </div>
        ) : (
          <table className="grid-table text-2xs">
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
                      r.movePct >= 0 ? "text-up" : "text-down"
                    }`}
                  >
                    {r.movePct >= 0 ? "+" : ""}
                    {nf(r.movePct, 2)}%
                  </td>
                  <td className="border-b border-term-border/40 px-2 py-1 text-[10px] text-term-dim">
                    {r.buildup ? BUILDUP_LABEL[r.buildup] ?? r.buildup : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );

  const SortTh = ({ col, label }: { col: SortCol; label: string }) => (
    <th
      onClick={() => toggleSort(col)}
      className="cursor-pointer select-none whitespace-nowrap border-b border-term-border px-2 py-1 text-right text-term-dim hover:text-term-text"
      title={`Sort by ${label}`}
    >
      {label}
      {sortCol === col ? (sortDir === -1 ? " ▼" : " ▲") : ""}
    </th>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
        <span className="font-semibold uppercase tracking-wide">Top movers</span>
        <div className="flex overflow-hidden rounded border border-term-border">
          {(
            [
              ["today", "Today"],
              ["yesterday", "Yesterday"],
              ["7d", "7 Day"],
              ["compare", "Compare"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setTf(v)}
              className={`px-2 py-0.5 font-semibold ${
                tf === v
                  ? "bg-term-accent text-white"
                  : "text-term-dim hover:bg-term-border hover:text-term-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {tf !== "compare" && (
          <label className="flex items-center gap-1">
            show
            <SelectMenu
              value={n}
              options={[10, 15, 20, 30].map((v) => [String(v), v] as [string, number])}
              onChange={setN}
              title="Rows per side"
              width={80}
            />
            each
          </label>
        )}
        {progress && progress.total > 0 && progress.done < progress.total && (
          <span>
            scanning {progress.done}/{progress.total}
          </span>
        )}
        <button
          onClick={load}
          disabled={busy}
          className="btn px-2 py-0.5 text-2xs disabled:opacity-40"
          title="Refresh now"
        >
          {busy ? "…" : "⟳ Refresh"}
        </button>
        {updated && <span>updated {ago(updated)}</span>}
        <span className="ml-auto">
          {tf === "compare"
            ? "click a column to sort · F&amp;O universe"
            : `ranked by ${TF_LABEL[tf]} % move · F&amp;O universe`}
          {asOfDate ? ` · yesterday/7d as of ${asOfDate}` : ""}
        </span>
      </div>
      {tf === "compare" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {compareShown.length === 0 ? (
            <div className="p-4 text-center text-2xs text-term-dim">
              {busy ? "loading…" : "waiting for data…"}
            </div>
          ) : (
            <table className="grid-table w-full text-2xs">
              <thead>
                <tr className="sticky top-0 bg-term-panel2">
                  <th className="border-b border-term-border px-2 py-1 text-right text-term-dim">#</th>
                  <th className="border-b border-term-border px-2 py-1 text-left text-term-dim">Symbol</th>
                  <th className="border-b border-term-border px-2 py-1 text-right text-term-dim">Spot</th>
                  <SortTh col="today" label="Today" />
                  <SortTh col="yesterday" label="Yday" />
                  <SortTh col="7d" label="7D" />
                  <th className="border-b border-term-border px-2 py-1 text-left text-term-dim">Buildup</th>
                </tr>
              </thead>
              <tbody>
                {compareShown.map((r, i) => (
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
                    <Pct v={r.todayPct} />
                    <Pct v={r.yesterdayPct} />
                    <Pct v={r.sevenDayPct} />
                    <td className="border-b border-term-border/40 px-2 py-1 text-[10px] text-term-dim">
                      {r.buildup ? BUILDUP_LABEL[r.buildup] ?? r.buildup : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 divide-x divide-term-border">
          <Col title="Top gainers" list={gainers} up />
          <Col title="Top losers" list={losers} up={false} />
        </div>
      )}
    </div>
  );
}
