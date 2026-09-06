import { useMemo, useState } from "react";
import { RangePresets } from "./RangePresets";
import { api } from "../lib/api";
import { nf } from "../lib/format";
import type { StrategyLeg } from "../types";

const iso = (d: Date) => d.toISOString().slice(0, 10);

type Result = Awaited<ReturnType<typeof api.upstoxBacktest>>;

/** Replay the current builder legs against Upstox daily history over a chosen
 *  date range. Index or F&O stock, Upstox connected. */
export function BacktestPanel({
  symbol,
  expiry,
  legs,
  onClose,
}: {
  symbol: string;
  expiry: string;
  legs: StrategyLeg[];
  onClose: () => void;
}) {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 20);
    return iso(d);
  });
  const [to, setTo] = useState(() => iso(new Date()));
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = () => {
    setBusy(true);
    setErr(null);
    api
      .upstoxBacktest({
        symbol,
        expiry,
        from,
        to,
        legs: legs.map((l) => ({
          strike: l.strike,
          optionType: l.optionType,
          side: l.side,
          lots: l.lots,
        })),
      })
      .then(
        (d) => {
          setRes(d);
          setBusy(false);
        },
        (e) => {
          setErr(e?.message || "backtest failed");
          setBusy(false);
        }
      );
  };

  const chart = useMemo(() => {
    const s = res?.series ?? [];
    if (s.length < 2) return null;
    const W = 640;
    const H = 160;
    const pad = { l: 44, r: 8, t: 8, b: 16 };
    const vs = s.map((p) => p.pnl);
    let lo = Math.min(0, ...vs);
    let hi = Math.max(0, ...vs);
    const gap = (hi - lo) * 0.1 || 1;
    lo -= gap;
    hi += gap;
    const x = (i: number) => pad.l + (i / (s.length - 1)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
    const path = s.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.pnl).toFixed(1)}`).join(" ");
    const zero = y(0);
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" height={140}>
        <line x1={pad.l} x2={W - pad.r} y1={zero} y2={zero} stroke="currentColor" strokeOpacity={0.4} className="text-term-dim" />
        <text x={2} y={y(hi) + 8} fontSize={9} className="fill-term-dim">
          ₹{nf(hi, 0)}
        </text>
        <text x={2} y={y(lo)} fontSize={9} className="fill-term-dim">
          ₹{nf(lo, 0)}
        </text>
        <path
          d={`${path} L${x(s.length - 1)},${zero} L${x(0)},${zero} Z`}
          fill={s[s.length - 1].pnl >= 0 ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)"}
        />
        <path d={path} fill="none" stroke={s[s.length - 1].pnl >= 0 ? "#22c55e" : "#ef4444"} strokeWidth={1.5} />
      </svg>
    );
  }, [res]);

  const sm = res?.summary;

  return (
    <div className="rounded-lg border border-term-accent/50 bg-term-panel p-3 text-2xs">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold uppercase tracking-wide text-term-dim">Backtest</span>
        <span className="num text-term-text">
          {symbol} {expiry} · {legs.length} leg{legs.length === 1 ? "" : "s"}
        </span>
        <button onClick={onClose} className="ml-auto text-term-dim hover:text-down">
          ✕
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-term-dim">
          from
          <input
            type="date"
            style={{ colorScheme: "dark" }}
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
            style={{ colorScheme: "dark" }}
            value={to}
            min={from}
            max={iso(new Date())}
            onChange={(e) => setTo(e.target.value)}
            className="rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text"
          />
        </label>
        <RangePresets set={(f, t) => (setFrom(f), setTo(t))} active={from} />
        <button
          onClick={run}
          disabled={busy || legs.length === 0}
          className="rounded bg-term-accent px-2 py-0.5 font-semibold text-white disabled:opacity-40"
        >
          {busy ? "running…" : "Run"}
        </button>
      </div>

      {err && <div className="mt-2 text-down">{err}</div>}

      {res && sm && (
        <>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
            <Stat label="Final P&L" v={sm.finalPnl} />
            <Stat label="Max profit" v={sm.maxProfit} />
            <Stat label="Max loss" v={sm.maxLoss} />
            <Stat label="Max drawdown" v={sm.maxDrawdown} />
          </div>
          <div className="mt-1 text-[10px] text-term-dim">
            entry {res.entryDate} · lot {res.lot} ·{" "}
            {res.legs.map((l) => `${l.side} ${l.strike}${l.optionType}@${nf(l.entryPx)}`).join("  ")}
          </div>
          <div className="mt-2">{chart}</div>
          <div className="mt-1 max-h-40 overflow-y-auto">
            <table className="w-full text-[10px]">
              <thead className="text-term-dim">
                <tr>
                  <th className="py-0.5 text-left font-medium">Date</th>
                  <th className="py-0.5 text-right font-medium">Spot</th>
                  <th className="py-0.5 text-right font-medium">P&L</th>
                </tr>
              </thead>
              <tbody>
                {[...res.series].reverse().map((p) => (
                  <tr key={p.date}>
                    <td className="num py-0.5 text-term-dim">{p.date}</td>
                    <td className="num py-0.5 text-right">{p.spot != null ? nf(p.spot, 0) : "–"}</td>
                    <td className={`num py-0.5 text-right ${p.pnl >= 0 ? "text-up" : "text-down"}`}>
                      {p.pnl >= 0 ? "+" : ""}
                      {nf(p.pnl, 0)}
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

function Stat({ label, v }: { label: string; v: number }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[9px] uppercase text-term-dim">{label}</span>
      <span className={`num text-sm font-semibold ${v >= 0 ? "text-up" : "text-down"}`}>
        {v >= 0 ? "+" : ""}₹{nf(v, 0)}
      </span>
    </div>
  );
}
