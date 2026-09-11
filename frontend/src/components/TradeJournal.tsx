import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { nf, sk, hhmm, signColor } from "../lib/format";
import type { JournalStats, JournalTrade } from "../types";

function Card({
  label,
  value,
  tone = "",
  sub,
}: {
  label: string;
  value: string;
  tone?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-term-border bg-term-panel p-3">
      <div className="text-[10px] uppercase tracking-wide text-term-dim">{label}</div>
      <div className={`num mt-1 text-xl font-semibold ${tone}`}>{value}</div>
      {sub && <div className="mt-0.5 text-2xs text-term-dim">{sub}</div>}
    </div>
  );
}

const rupee = (n: number | null | undefined) =>
  n == null || Number.isNaN(n)
    ? "–"
    : `${n >= 0 ? "+" : "-"}₹${Math.round(Math.abs(n)).toLocaleString("en-IN")}`;

function holdLabel(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  const h = sec / 3600;
  if (h < 24) return `${nf(h, 1)}h`;
  return `${nf(h / 24, 1)}d`;
}

const EQ_W = 900;
const EQ_H = 160;
const EQ_PAD = { l: 8, r: 8, t: 10, b: 10 };

function EquityCurve({ points }: { points: { ts: number; cum: number }[] }) {
  const g = useMemo(() => {
    if (points.length < 2) return null;
    const ys = points.map((p) => p.cum);
    let yMin = Math.min(0, ...ys);
    let yMax = Math.max(0, ...ys);
    const padY = (yMax - yMin) * 0.1 || 1;
    yMin -= padY;
    yMax += padY;
    const px = (i: number) => EQ_PAD.l + (i / (ys.length - 1)) * (EQ_W - EQ_PAD.l - EQ_PAD.r);
    const py = (v: number) =>
      EQ_PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (EQ_H - EQ_PAD.t - EQ_PAD.b);
    const line = ys.map((v, i) => `${px(i)},${py(v)}`).join(" ");
    const zeroY = py(0);
    const area = `${px(0)},${zeroY} ${line} ${px(ys.length - 1)},${zeroY}`;
    return { line, area, zeroY };
  }, [points]);

  if (!g) return <div className="p-4 text-xs text-term-dim">Not enough closed trades yet.</div>;
  const up = points[points.length - 1].cum >= 0;
  return (
    <svg viewBox={`0 0 ${EQ_W} ${EQ_H}`} className="h-40 w-full" preserveAspectRatio="none">
      <line x1={EQ_PAD.l} x2={EQ_W - EQ_PAD.r} y1={g.zeroY} y2={g.zeroY} stroke="#3b4657" strokeWidth={1} />
      <polygon points={g.area} fill={up ? "#16a34a" : "#dc2626"} opacity={0.14} />
      <polyline points={g.line} fill="none" stroke={up ? "#22c55e" : "#ef4444"} strokeWidth={1.8} />
    </svg>
  );
}

function DayBars({ days }: { days: { date: string; pnl: number; trades: number }[] }) {
  if (!days.length) return null;
  const max = Math.max(1, ...days.map((d) => Math.abs(d.pnl)));
  return (
    <div className="flex h-24 items-end gap-0.5 overflow-x-auto">
      {days.map((d) => (
        <div
          key={d.date}
          title={`${d.date} · ${d.trades} trade${d.trades === 1 ? "" : "s"} · ${rupee(d.pnl)}`}
          className="flex h-full w-3 shrink-0 flex-col items-end justify-end"
        >
          <div
            className={`w-full rounded-sm ${d.pnl >= 0 ? "bg-up" : "bg-down"}`}
            style={{ height: `${Math.max(2, (Math.abs(d.pnl) / max) * 88)}px` }}
          />
        </div>
      ))}
    </div>
  );
}

export function TradeJournal() {
  const [stats, setStats] = useState<JournalStats | null>(null);
  const [trades, setTrades] = useState<JournalTrade[]>([]);
  const [busy, setBusy] = useState(true);
  const [symbolFilter, setSymbolFilter] = useState("");

  const load = async () => {
    setBusy(true);
    try {
      const [st, tr] = await Promise.all([api.journalStats(), api.journal({ limit: 300 })]);
      setStats(st);
      setTrades(tr);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  const filtered = symbolFilter ? trades.filter((t) => t.symbol === symbolFilter) : trades;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-base font-semibold">Trade Journal</h2>
        <span className="rounded bg-term-border px-1.5 py-0.5 text-2xs text-term-dim">Paper trades</span>
        <button
          onClick={load}
          disabled={busy}
          className="ml-auto rounded border border-term-border px-2 py-1 text-2xs text-term-dim hover:text-term-text disabled:opacity-50"
        >
          {busy ? "…" : "Refresh"}
        </button>
      </div>

      {busy && !stats ? (
        <div className="p-6 text-center text-sm text-term-dim">Loading…</div>
      ) : !stats || stats.totalTrades === 0 ? (
        <div className="rounded border border-term-border bg-term-panel p-6 text-center text-sm text-term-dim">
          No closed paper trades yet. Trades appear here once a position is closed — manually,
          via the Close button, or via an SL/target hit.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            <Card label="Total P&L" value={rupee(stats.totalPnl)} tone={signColor(stats.totalPnl)} />
            <Card
              label="Win rate"
              value={`${nf(stats.winRate, 1)}%`}
              sub={`${stats.wins}W / ${stats.losses}L`}
            />
            <Card
              label="Profit factor"
              value={stats.profitFactor == null ? (stats.wins ? "∞" : "–") : nf(stats.profitFactor, 2)}
            />
            <Card label="Avg win" value={rupee(stats.avgWin)} tone="text-up" />
            <Card label="Avg loss" value={rupee(stats.avgLoss)} tone="text-down" />
            <Card label="Best trade" value={rupee(stats.bestTrade)} tone="text-up" />
            <Card label="Worst trade" value={rupee(stats.worstTrade)} tone="text-down" />
            <Card
              label="Avg hold"
              value={stats.avgHoldMin >= 60 ? `${nf(stats.avgHoldMin / 60, 1)}h` : `${nf(stats.avgHoldMin, 0)}m`}
            />
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="rounded border border-term-border bg-term-panel p-3">
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-term-dim">
                Equity curve (cumulative realized P&amp;L)
              </div>
              <EquityCurve points={stats.equityCurve} />
            </div>
            <div className="rounded border border-term-border bg-term-panel p-3">
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-term-dim">
                Daily P&amp;L — {stats.byDay.length} day{stats.byDay.length === 1 ? "" : "s"}
              </div>
              <DayBars days={stats.byDay} />
            </div>
          </div>

          <div className="mt-3 rounded border border-term-border bg-term-panel p-3">
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-term-dim">
              By symbol
            </div>
            <div className="flex flex-wrap gap-2">
              {stats.bySymbol.map((s) => (
                <button
                  key={s.symbol}
                  onClick={() => setSymbolFilter((v) => (v === s.symbol ? "" : s.symbol))}
                  className={`rounded border px-2 py-1 text-2xs ${
                    symbolFilter === s.symbol
                      ? "border-term-accent bg-term-accent text-white"
                      : "border-term-border text-term-dim hover:text-term-text"
                  }`}
                >
                  {s.symbol} · {s.trades} · <span className={signColor(s.pnl)}>{rupee(s.pnl)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 rounded border border-term-border bg-term-panel p-3">
            <div className="mb-1 flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-term-dim">
              <span>
                Trades ({filtered.length}){symbolFilter && ` · ${symbolFilter}`}
              </span>
              {symbolFilter && (
                <button
                  onClick={() => setSymbolFilter("")}
                  className="normal-case text-term-accent"
                >
                  clear filter
                </button>
              )}
            </div>
            <table className="block w-full overflow-x-auto whitespace-nowrap border-separate border-spacing-0 border border-term-border text-2xs [&_td:last-child]:border-r-0 [&_td]:border-b [&_td]:border-r [&_td]:border-term-border/60 [&_th:last-child]:border-r-0 [&_th]:border-b [&_th]:border-r [&_th]:border-term-border">
              <thead className="text-[10px] uppercase text-term-dim">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">Closed</th>
                  <th className="px-2 py-1 text-left font-medium">Symbol</th>
                  <th className="px-2 py-1 text-left font-medium">Leg</th>
                  <th className="px-2 py-1 text-right font-medium">Qty</th>
                  <th className="px-2 py-1 text-right font-medium">Entry</th>
                  <th className="px-2 py-1 text-right font-medium">Exit</th>
                  <th className="px-2 py-1 text-right font-medium">P&amp;L</th>
                  <th className="px-2 py-1 text-right font-medium">Held</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr key={t.id}>
                    <td className="px-2 py-1 text-term-dim">
                      {new Date(t.closedTs * 1000).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                      })}{" "}
                      {hhmm(t.closedTs)}
                    </td>
                    <td className="px-2 py-1 font-medium text-term-text">{t.symbol}</td>
                    <td className="px-2 py-1">
                      {t.side === "BUY" ? "B" : "S"} {sk(t.strike)}
                      {t.optionType}
                    </td>
                    <td className="num px-2 py-1 text-right">{t.qty}</td>
                    <td className="num px-2 py-1 text-right">{nf(t.entryPrice)}</td>
                    <td className="num px-2 py-1 text-right">{nf(t.exitPrice)}</td>
                    <td className={`num px-2 py-1 text-right font-medium ${signColor(t.pnl)}`}>
                      {rupee(t.pnl)}
                    </td>
                    <td className="num px-2 py-1 text-right text-term-dim">
                      {t.openedTs ? holdLabel(t.closedTs - t.openedTs) : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
