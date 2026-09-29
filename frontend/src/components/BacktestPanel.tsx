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

  // equity curve: P&L each day, green above zero / red below, best + worst day marked, dated axis
  const chart = useMemo(() => {
    const s = res?.series ?? [];
    if (s.length < 2) return null;
    const W = 720;
    const H = 230;
    const pad = { l: 58, r: 12, t: 16, b: 26 };
    const vs = s.map((p) => p.pnl);
    let lo = Math.min(0, ...vs);
    let hi = Math.max(0, ...vs);
    const gap = (hi - lo) * 0.12 || 1;
    lo -= gap;
    hi += gap;
    const x = (i: number) => pad.l + (i / (s.length - 1)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
    const path = s.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.pnl).toFixed(1)}`).join(" ");
    const zero = y(0);
    const area = `${path} L${x(s.length - 1)},${zero} L${x(0)},${zero} Z`;
    let bi = 0;
    let wi = 0;
    vs.forEach((v, i) => {
      if (v > vs[bi]) bi = i;
      if (v < vs[wi]) wi = i;
    });
    const ticks = [hi - gap, (hi - gap + lo + gap) / 2, lo + gap];
    const dIdx = Array.from(new Set([0, Math.floor((s.length - 1) / 2), s.length - 1]));
    const last = s[s.length - 1].pnl;
    // a label near either end is anchored inward so it isn't cut off
    const edge = (i: number) => (i < s.length * 0.15 ? "start" : i > s.length * 0.85 ? "end" : "middle");
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Backtest P&L by day">
        <defs>
          <clipPath id="bt-above">
            <rect x={0} y={0} width={W} height={zero} />
          </clipPath>
          <clipPath id="bt-below">
            <rect x={0} y={zero} width={W} height={H - zero} />
          </clipPath>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#1e2733" />
            <text x={pad.l - 6} y={y(t) + 3} fontSize={10} textAnchor="end" className="fill-term-dim">
              {t >= 0 ? "" : "−"}₹{nf(Math.abs(t), 0)}
            </text>
          </g>
        ))}
        <line x1={pad.l} x2={W - pad.r} y1={zero} y2={zero} stroke="#64748b" strokeDasharray="3 3" />
        <path d={area} fill="rgba(34,197,94,0.18)" clipPath="url(#bt-above)" />
        <path d={area} fill="rgba(239,68,68,0.18)" clipPath="url(#bt-below)" />
        <path d={path} fill="none" stroke={last >= 0 ? "#22c55e" : "#ef4444"} strokeWidth={2} />
        {bi !== wi && (
          <>
            <circle cx={x(bi)} cy={y(vs[bi])} r={3.5} fill="#22c55e" />
            <text x={x(bi)} y={y(vs[bi]) - 7} fontSize={10} textAnchor={edge(bi)} className="fill-up">
              best +₹{nf(vs[bi], 0)}
            </text>
            <circle cx={x(wi)} cy={y(vs[wi])} r={3.5} fill="#ef4444" />
            <text x={x(wi)} y={y(vs[wi]) + 14} fontSize={10} textAnchor={edge(wi)} className="fill-down">
              worst {vs[wi] >= 0 ? "+" : "−"}₹{nf(Math.abs(vs[wi]), 0)}
            </text>
          </>
        )}
        {dIdx.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 8}
            fontSize={10}
            textAnchor={i === 0 ? "start" : i === s.length - 1 ? "end" : "middle"}
            className="fill-term-dim"
          >
            {s[i].date.slice(5)}
          </text>
        ))}
      </svg>
    );
  }, [res]);

  const sm = res?.summary;
  const days = res?.series ?? [];
  const upDays = days.filter((p, i) => i > 0 && p.pnl > days[i - 1].pnl).length;

  return (
    <div className="space-y-3 text-2xs">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 rounded-lg border border-term-border bg-term-panel2/40 px-3 py-2">
        <div>
          <div className="text-[13px] font-semibold text-term-text">
            Backtest <span className="font-normal text-term-dim">· {symbol} {expiry} · {legs.length} leg{legs.length === 1 ? "" : "s"}</span>
          </div>
          <div className="text-[10.5px] text-term-dim">Replays these legs on past daily prices, entered on the first day.</div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-0.5 text-[9px] font-semibold uppercase tracking-wider text-term-dim">
            From
            <input
              type="date"
              style={{ colorScheme: "dark" }}
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded border border-term-border bg-term-bg px-1.5 py-1 text-[11px] font-normal normal-case tracking-normal text-term-text"
            />
          </label>
          <label className="flex flex-col gap-0.5 text-[9px] font-semibold uppercase tracking-wider text-term-dim">
            To
            <input
              type="date"
              style={{ colorScheme: "dark" }}
              value={to}
              min={from}
              max={iso(new Date())}
              onChange={(e) => setTo(e.target.value)}
              className="rounded border border-term-border bg-term-bg px-1.5 py-1 text-[11px] font-normal normal-case tracking-normal text-term-text"
            />
          </label>
          <RangePresets set={(f, t) => (setFrom(f), setTo(t))} active={from} />
          <button
            onClick={run}
            disabled={busy || legs.length === 0}
            className="rounded-md bg-term-accent px-4 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
          >
            {busy ? "Running…" : "Run backtest"}
          </button>
          <button onClick={onClose} className="px-1 py-1.5 text-term-dim hover:text-term-text" title="back to Payoff">
            ✕
          </button>
        </div>
      </div>

      {err && <div className="rounded-md border border-down/50 bg-down/10 px-3 py-2 text-[12px] text-down">{err}</div>}
      {!res && !err && !busy && (
        <div className="rounded-lg border border-dashed border-term-border px-4 py-8 text-center text-[12px] text-term-dim">
          Pick a date range and press <span className="text-term-text">Run backtest</span> to see how these legs would have done.
        </div>
      )}

      {res && sm && (
        <>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Final P&L" v={sm.finalPnl} />
            <Stat label="Max profit" v={sm.maxProfit} />
            <Stat label="Max loss" v={sm.maxLoss} />
            <Stat label="Max drawdown" v={sm.maxDrawdown} />
            <Info label="Days" v={String(days.length)} />
            <Info label="Up days" v={days.length > 1 ? `${upDays} of ${days.length - 1}` : "–"} />
          </div>
          <div className="flex flex-wrap gap-1.5 text-[10.5px]">
            <span className="text-term-dim">Entered {res.entryDate} · lot {res.lot}:</span>
            {res.legs.map((l, i) => (
              <span
                key={i}
                className={`rounded border px-1.5 py-0.5 num ${l.side === "BUY" ? "border-up/50 text-up" : "border-down/50 text-down"}`}
              >
                {l.side} {l.strike} {l.optionType} @ {nf(l.entryPx)}
              </span>
            ))}
          </div>
          <div className="rounded-lg border border-term-border bg-term-bg/20 p-2">{chart}</div>
          <div className="max-h-64 overflow-auto rounded-lg border border-term-border">
            <table className="w-full border-separate border-spacing-0 text-[11.5px]">
              <thead className="sticky top-0 bg-term-panel2 text-[10px] uppercase text-term-dim">
                <tr>
                  <th className="border-b border-term-border px-3 py-1.5 text-left font-semibold">Date</th>
                  <th className="border-b border-term-border px-3 py-1.5 text-right font-semibold">Spot</th>
                  <th className="border-b border-term-border px-3 py-1.5 text-right font-semibold">Day change</th>
                  <th className="border-b border-term-border px-3 py-1.5 text-right font-semibold">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {[...days]
                  .map((p, i) => ({ ...p, chg: i > 0 ? p.pnl - days[i - 1].pnl : null }))
                  .reverse()
                  .map((p, i) => (
                    <tr key={p.date} className={i % 2 ? "bg-term-panel2/30" : ""}>
                      <td className="num border-b border-term-border/40 px-3 py-1 text-term-dim">{p.date}</td>
                      <td className="num border-b border-term-border/40 px-3 py-1 text-right">{p.spot != null ? nf(p.spot, 0) : "–"}</td>
                      <td className={`num border-b border-term-border/40 px-3 py-1 text-right ${p.chg == null ? "text-term-dim" : p.chg >= 0 ? "text-up" : "text-down"}`}>
                        {p.chg == null ? "entry" : `${p.chg >= 0 ? "+" : ""}${nf(p.chg, 0)}`}
                      </td>
                      <td className={`num border-b border-term-border/40 px-3 py-1 text-right font-semibold ${p.pnl >= 0 ? "text-up" : "text-down"}`}>
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
    <div className="rounded-md border border-term-border bg-term-panel2/70 px-2.5 py-1.5">
      <div className="text-[9.5px] font-semibold uppercase tracking-wide text-term-dim">{label}</div>
      <div className={`num text-[15px] font-bold ${v >= 0 ? "text-up" : "text-down"}`}>
        {v >= 0 ? "+" : "−"}₹{nf(Math.abs(v), 0)}
      </div>
    </div>
  );
}

function Info({ label, v }: { label: string; v: string }) {
  return (
    <div className="rounded-md border border-term-border bg-term-panel2/70 px-2.5 py-1.5">
      <div className="text-[9.5px] font-semibold uppercase tracking-wide text-term-dim">{label}</div>
      <div className="num text-[15px] font-bold text-term-text">{v}</div>
    </div>
  );
}
