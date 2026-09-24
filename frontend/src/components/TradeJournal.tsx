import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { nf, sk, hhmm, signColor } from "../lib/format";
import type { JournalReview, JournalStats, JournalTrade } from "../types";

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

type Mode = "all" | "paper" | "live";
const MODE_LS = "journal.mode";

const istDay = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD

/** Same figures as the backend's journal_stats, over whichever trades are
 *  shown -- so the cards, curve and daily bars follow the Paper / Live filter. */
function computeStats(trades: JournalTrade[]): JournalStats {
  const chrono = [...trades].sort((a, b) => a.closedTs - b.closedTs);
  const wins = chrono.filter((t) => t.pnl > 0);
  const losses = chrono.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnl, 0);
  let cum = 0;
  const equityCurve = chrono.map((t) => ({ ts: t.closedTs, cum: (cum += t.pnl) }));
  const days = new Map<string, { date: string; pnl: number; trades: number }>();
  const syms = new Map<string, { symbol: string; pnl: number; trades: number; wins: number }>();
  for (const t of chrono) {
    const d = days.get(istDay(t.closedTs)) ?? { date: istDay(t.closedTs), pnl: 0, trades: 0 };
    d.pnl += t.pnl;
    d.trades += 1;
    days.set(d.date, d);
    const s = syms.get(t.symbol) ?? { symbol: t.symbol, pnl: 0, trades: 0, wins: 0 };
    s.pnl += t.pnl;
    s.trades += 1;
    if (t.pnl > 0) s.wins += 1;
    syms.set(t.symbol, s);
  }
  const holds = chrono.filter((t) => t.openedTs).map((t) => t.closedTs - (t.openedTs as number));
  const n = chrono.length;
  return {
    totalTrades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? (100 * wins.length) / n : 0,
    totalPnl: grossWin + grossLoss,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    bestTrade: n ? Math.max(...chrono.map((t) => t.pnl)) : 0,
    worstTrade: n ? Math.min(...chrono.map((t) => t.pnl)) : 0,
    profitFactor: grossLoss < 0 ? grossWin / Math.abs(grossLoss) : null,
    avgHoldMin: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length / 60 : 0,
    equityCurve,
    byDay: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    bySymbol: [...syms.values()]
      .map(({ wins: w, ...s }) => ({ ...s, winRate: s.trades ? (100 * w) / s.trades : 0 }))
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)),
  };
}

const FLAG_ICON: Record<JournalReview["flags"][number]["kind"], string> = {
  reentry: "↺",
  flip: "⇄",
  churn: "₹",
  rejected: "⛔",
};

/** One day's live trading in plain words: result, costs, and the patterns
 *  that cost money (re-entering after a loss, flipping sides, churn, rejections). */
function DayReview({ refresh }: { refresh: number }) {
  const [day, setDay] = useState<string | undefined>(undefined);
  const [rv, setRv] = useState<JournalReview | null>(null);
  useEffect(() => {
    let alive = true;
    api.journalReview(day).then((d) => alive && setRv(d), () => {});
    return () => {
      alive = false;
    };
  }, [day, refresh]);
  if (!rv || !rv.days.length) return null;
  return (
    <div className="mb-3 rounded border border-term-border bg-term-panel p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-2xs">
        <span className="font-semibold uppercase tracking-wide text-term-dim">Live day review</span>
        <select
          value={rv.day}
          onChange={(e) => setDay(e.target.value)}
          className="rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs text-term-text"
        >
          {rv.days.map((d) => (
            <option key={d} value={d}>
              {new Date(`${d}T12:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" })}
            </option>
          ))}
        </select>
        <span className="num text-term-dim">
          {rv.filled} filled · {rv.rejected} rejected
        </span>
        <span className="num ml-auto">
          gross <span className={signColor(rv.gross)}>{rupee(rv.gross)}</span>
          {rv.charges != null && (
            <>
              {" "}
              · charges <span className="text-term-dim">₹{nf(rv.charges, 0)}</span> · net{" "}
              <span className={`font-semibold ${signColor(rv.net ?? 0)}`}>{rupee(rv.net)}</span>
            </>
          )}
        </span>
      </div>
      {rv.flags.length ? (
        <ul className="space-y-1 text-xs">
          {rv.flags.map((f, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-4 shrink-0 text-center text-amber-400">{FLAG_ICON[f.kind]}</span>
              <span className="text-term-text">{f.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-xs text-term-dim">Nothing flagged — no re-entries after a loss, flips, churn or rejections.</div>
      )}
      {rv.byContract.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
          {rv.byContract.map((c) => (
            <span key={c.name} className="num rounded border border-term-border px-1.5 py-0.5">
              {c.name} <span className={signColor(c.pnl)}>{rupee(c.pnl)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function TradeJournal() {
  const [allTrades, setAllTrades] = useState<JournalTrade[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [symbolFilter, setSymbolFilter] = useState("");
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [mode, setModeState] = useState<Mode>(() => {
    try {
      const v = localStorage.getItem(MODE_LS);
      return v === "paper" || v === "live" ? v : "all";
    } catch {
      return "all";
    }
  });
  const setMode = (m: Mode) => {
    setModeState(m);
    setSymbolFilter("");
    try {
      localStorage.setItem(MODE_LS, m);
    } catch {
      /* private mode */
    }
  };

  const load = async () => {
    setBusy(true);
    try {
      setAllTrades(await api.journal({ limit: 5000 }));
      setRefresh((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const syncLive = async () => {
    setSyncNote("syncing…");
    try {
      const r = await api.journalSyncLive();
      setSyncNote(r.ok ? `synced · ${r.new ?? 0} new order${r.new === 1 ? "" : "s"}` : r.reason ?? "sync failed");
      await load();
    } catch (e: any) {
      setSyncNote(String(e?.message || e));
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  const trades = useMemo(
    () => (allTrades ?? []).filter((t) => mode === "all" || t.mode === mode),
    [allTrades, mode]
  );
  const stats = useMemo(() => (allTrades ? computeStats(trades) : null), [allTrades, trades]);
  const counts = useMemo(
    () => ({
      all: allTrades?.length ?? 0,
      paper: allTrades?.filter((t) => t.mode === "paper").length ?? 0,
      live: allTrades?.filter((t) => t.mode === "live").length ?? 0,
    }),
    [allTrades]
  );
  const filtered = symbolFilter ? trades.filter((t) => t.symbol === symbolFilter) : trades;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">Trade Journal</h2>
        <div className="seg" title="Show paper trades, live Flattrade trades, or both — every figure below follows it">
          {(
            [
              ["all", "All"],
              ["paper", "Paper"],
              ["live", "Live"],
            ] as const
          ).map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)} className={mode === m ? "on" : ""}>
              {label} <span className="num opacity-70">{counts[m]}</span>
            </button>
          ))}
        </div>
        {syncNote && <span className="text-2xs text-term-dim">{syncNote}</span>}
        <button
          onClick={syncLive}
          title="Copy today's Flattrade order book into the journal now (it also syncs by itself every 5 min while connected)"
          className="ml-auto rounded border border-term-dim/70 px-2 py-1 text-2xs text-term-dim hover:text-term-text"
        >
          ⟳ Sync live
        </button>
        <button
          onClick={load}
          disabled={busy}
          className="rounded border border-term-dim/70 px-2 py-1 text-2xs text-term-dim hover:text-term-text disabled:opacity-50"
        >
          {busy ? "…" : "Refresh"}
        </button>
      </div>

      {mode !== "paper" && <DayReview refresh={refresh} />}

      {busy && !stats ? (
        <div className="p-6 text-center text-sm text-term-dim">Loading…</div>
      ) : !stats || stats.totalTrades === 0 ? (
        <div className="rounded border border-term-border bg-term-panel p-6 text-center text-sm text-term-dim">
          {mode === "paper"
            ? "No closed paper trades yet. They appear once a paper position is closed — manually, via the Close button, or via an SL/target hit."
            : mode === "live"
            ? "No live Flattrade trades yet. They're copied in every 5 minutes while the broker is connected (or tap ⟳ Sync live)."
            : "No closed trades yet. Paper trades appear once a position is closed; live Flattrade trades are copied in every 5 minutes while the broker is connected (or tap ⟳ Sync live)."}
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
                      : "border-term-dim/70 text-term-dim hover:text-term-text"
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
                    <td className="px-2 py-1 font-medium text-term-text">
                      {t.symbol}
                      <span
                        className={`ml-1 rounded px-1 text-[8px] font-bold ${
                          t.mode === "live" ? "bg-down/20 text-down" : "bg-term-border text-term-dim"
                        }`}
                      >
                        {t.mode === "live" ? "LIVE" : "PAPER"}
                      </span>
                    </td>
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
