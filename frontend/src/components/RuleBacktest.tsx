import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { nf } from "../lib/format";
import type { AutoRule } from "../types";

const iso = (d: Date) => d.toISOString().slice(0, 10);
type Res = Awaited<ReturnType<typeof api.autobotBacktest>>;

/** Backtest one AutoBot rule against Upstox daily history. Index symbols only;
 *  range must sit inside the life of the expiry's contracts (a few weeks for
 *  weeklies), so it defaults to the last ~15 days. */
export function RuleBacktest({ rule, onClose }: { rule: AutoRule; onClose: () => void }) {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 15);
    return iso(d);
  });
  const [to, setTo] = useState(() => iso(new Date()));
  const [res, setRes] = useState<Res | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = () => {
    setBusy(true);
    setErr(null);
    api.autobotBacktest({ rule, from, to }).then(
      (d) => {
        setRes(d);
        setBusy(false);
      },
      (e) => {
        setErr(e?.message || "failed");
        setBusy(false);
      }
    );
  };

  const curve = useMemo(() => {
    const eq = res?.equity ?? [];
    if (eq.length < 2) return null;
    const W = 520;
    const H = 120;
    const pad = { l: 40, r: 6, t: 6, b: 6 };
    let lo = Math.min(0, ...eq);
    let hi = Math.max(0, ...eq);
    const g = (hi - lo) * 0.1 || 1;
    lo -= g;
    hi += g;
    const x = (i: number) => pad.l + (i / (eq.length - 1)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
    const path = eq.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const z = y(0);
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" height={110} preserveAspectRatio="none">
        <line x1={pad.l} x2={W - pad.r} y1={z} y2={z} stroke="currentColor" strokeOpacity={0.35} className="text-term-dim" />
        <text x={2} y={y(hi) + 8} fontSize={9} className="fill-term-dim">₹{nf(hi, 0)}</text>
        <text x={2} y={y(lo)} fontSize={9} className="fill-term-dim">₹{nf(lo, 0)}</text>
        <path d={path} fill="none" stroke={eq[eq.length - 1] >= 0 ? "#22c55e" : "#ef4444"} strokeWidth={1.5} />
      </svg>
    );
  }, [res]);

  const s = res?.summary;

  return (
    <div className="mt-2 rounded border border-term-accent/50 bg-term-bg/50 p-2 text-[10px]">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-semibold uppercase tracking-wide text-term-dim">Backtest</span>
        <label className="flex items-center gap-1 text-term-dim">
          from
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text"
          />
        </label>
        <label className="flex items-center gap-1 text-term-dim">
          to
          <input
            type="date"
            value={to}
            min={from}
            max={iso(new Date())}
            onChange={(e) => setTo(e.target.value)}
            className="rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text"
          />
        </label>
        <button
          onClick={run}
          disabled={busy}
          className="rounded bg-term-accent px-2 py-0.5 font-semibold text-white disabled:opacity-40"
        >
          {busy ? "running…" : "Run"}
        </button>
        <button onClick={onClose} className="ml-auto text-term-dim hover:text-down">
          ✕
        </button>
      </div>

      {err && <div className="text-down">{err}</div>}

      {res && s && (
        <>
          <div className="grid grid-cols-3 gap-x-3 gap-y-1 sm:grid-cols-6">
            <K l="Total" v={`₹${nf(s.total, 0)}`} up={s.total >= 0} />
            <K l="Trades" v={`${s.count}`} />
            <K l="Win rate" v={`${s.winRate}%`} up={s.winRate >= 50} />
            <K l="Avg win" v={`₹${nf(s.avgWin, 0)}`} up />
            <K l="Avg loss" v={`₹${nf(s.avgLoss, 0)}`} up={false} />
            <K l="Max DD" v={`₹${nf(s.maxDrawdown, 0)}`} up={false} />
          </div>
          <div className="mt-1 text-term-dim">
            {res.symbol} {res.expiry} · {res.instrument} {res.side} · {res.days} days ·{" "}
            {s.profitFactor != null ? `PF ${s.profitFactor}` : "PF –"}
          </div>
          <div className="mt-1.5">{curve}</div>
          {res.trades.length > 0 && (
            <div className="mt-1.5 max-h-40 overflow-y-auto">
              <table className="w-full">
                <thead className="text-term-dim">
                  <tr>
                    <th className="py-0.5 text-left font-medium">In → Out</th>
                    <th className="py-0.5 text-left font-medium">Strike</th>
                    <th className="py-0.5 text-right font-medium">Entry</th>
                    <th className="py-0.5 text-right font-medium">Exit</th>
                    <th className="py-0.5 text-right font-medium">P&L</th>
                    <th className="py-0.5 text-left font-medium">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {res.trades.map((t, i) => (
                    <tr key={i}>
                      <td className="num py-0.5 text-term-dim">
                        {t.entryDate.slice(5)}→{t.exitDate.slice(5)}
                      </td>
                      <td className="num py-0.5">
                        {t.strike}
                        {t.ot}
                      </td>
                      <td className="num py-0.5 text-right">{nf(t.entryPx)}</td>
                      <td className="num py-0.5 text-right">{nf(t.exitPx)}</td>
                      <td className={`num py-0.5 text-right ${t.pnlRs >= 0 ? "text-up" : "text-down"}`}>
                        {t.pnlRs >= 0 ? "+" : ""}
                        {nf(t.pnlRs, 0)} ({t.pnlPct}%)
                      </td>
                      <td className="py-0.5 text-term-dim">{t.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {res.trades.length === 0 && (
            <div className="mt-1 text-term-dim">No entries triggered in this window.</div>
          )}
        </>
      )}
    </div>
  );
}

function K({ l, v, up }: { l: string; v: string; up?: boolean }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[8px] uppercase text-term-dim">{l}</span>
      <span
        className={`num font-semibold ${
          up === undefined ? "text-term-text" : up ? "text-up" : "text-down"
        }`}
      >
        {v}
      </span>
    </div>
  );
}
