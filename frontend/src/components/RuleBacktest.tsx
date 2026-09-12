import { useMemo, useState } from "react";
import { RangePresets } from "./RangePresets";
import { api } from "../lib/api";
import { nf } from "../lib/format";
import type { AutoRule } from "../types";

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** "YYYY-MM-DD" -> "DD-MM-YY" for display; the API/date-math everywhere else
 *  in this file keeps using ISO so string comparisons still sort right. */
const ddmmyy = (d: string) => {
  const [y, m, day] = d.split("-");
  return `${day}-${m}-${y.slice(2)}`;
};
/** "HH:MM:SS" -> "HH-MM-SS" for display. */
const hhmmss = (t: string) => t.replace(/:/g, "-");
type Res = Awaited<ReturnType<typeof api.autobotBacktest>>;

/** Backtest one AutoBot rule against Upstox daily history.
 *
 *  Indicator conditions (RSI, EMA cross, price vs EMA, MACD, spot move) run
 *  off the underlying's daily closes, so they work over any range. OI / PCR /
 *  max-pain conditions need a live option expiry and only resolve for recent
 *  ranges. Option premiums use real historical option candles when available,
 *  otherwise a Black-Scholes model (set DTE / IV below). */
export function RuleBacktest({ rule, onClose }: { rule: AutoRule; onClose: () => void }) {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return iso(d);
  });
  const [to, setTo] = useState(() => iso(new Date()));
  const [dte, setDte] = useState("30");
  const [ivPct, setIvPct] = useState("15");
  const [tf, setTf] = useState(86400); // candle interval, seconds; 86400 = daily
  const [nBars, setNBars] = useState("300"); // # candles to replay (intraday)
  const [res, setRes] = useState<Res | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = () => {
    setBusy(true);
    setErr(null);
    const merged = {
      ...rule,
      _btDTE: Number(dte) || 30,
      _btIV: (Number(ivPct) || 15) / 100,
      // intraday run with no explicit entry timeframe -> evaluate the
      // indicators on the backtest's own candles
      entryTf: rule.entryTf || (tf < 86400 ? tf : 0),
    };
    api
      .autobotBacktest(
        tf >= 86400
          ? { rule: merged, from, to }
          : { rule: merged, from, to, interval: tf, bars: Number(nBars) || 0 }
      )
      .then(
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
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="font-semibold uppercase tracking-wide text-term-dim">Backtest</span>
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
          disabled={busy}
          className="rounded bg-term-accent px-2 py-0.5 font-semibold text-white disabled:opacity-40"
        >
          {busy ? "running…" : "Run"}
        </button>
        <button onClick={onClose} className="ml-auto text-term-dim hover:text-down">
          ✕
        </button>
      </div>

      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-term-dim">
        <span className="uppercase tracking-wide">Timeframe</span>
        <div className="seg">
          {(
            [
              ["1m", 60],
              ["5m", 300],
              ["15m", 900],
              ["30m", 1800],
              ["1h", 3600],
              ["1D", 86400],
            ] as const
          ).map(([lbl, v]) => (
            <button key={v} onClick={() => setTf(v)} className={tf === v ? "on" : ""}>
              {lbl}
            </button>
          ))}
        </div>
        {tf < 86400 && (
          <label className="flex items-center gap-1" title="How many recent candles to replay (Upstox intraday history is ~25 days)">
            candles
            <input
              value={nBars}
              onChange={(e) => setNBars(e.target.value.replace(/[^\d]/g, ""))}
              className="num w-14 rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text"
            />
          </label>
        )}
        {tf < 86400 && (
          <span className="text-[9px] text-amber-400">
            intraday · indicator-only, synthetic premiums
          </span>
        )}
      </div>

      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-term-dim">
        <span className="uppercase tracking-wide">B-S model</span>
        <label className="flex items-center gap-1" title="Days-to-expiry the synthetic option starts with (used when historical option prices aren't available)">
          DTE
          <input
            value={dte}
            onChange={(e) => setDte(e.target.value.replace(/[^\d]/g, ""))}
            className="num w-10 rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text"
          />
        </label>
        <label className="flex items-center gap-1" title="Implied volatility for the synthetic option, in %">
          IV %
          <input
            value={ivPct}
            onChange={(e) => setIvPct(e.target.value.replace(/[^\d.]/g, ""))}
            className="num w-12 rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text"
          />
        </label>
        <span className="text-[9px]">only used to price legs when real option history is missing</span>
      </div>

      {err && <div className="text-down">{err}</div>}

      {res && s && (
        <>
          <div className="grid grid-cols-4 gap-x-3 gap-y-1 sm:grid-cols-8">
            <K l="Total" v={`₹${nf(s.total, 0)}`} up={s.total >= 0} />
            <K l="Trades" v={`${s.count}`} />
            <K l="Win rate" v={`${s.winRate}%`} up={s.winRate >= 50} />
            <K l="Total win" v={`₹${nf(s.totalWin, 0)}`} up />
            <K l="Total loss" v={`₹${nf(s.totalLoss, 0)}`} up={false} />
            <K l="Avg win" v={`₹${nf(s.avgWin, 0)}`} up />
            <K l="Avg loss" v={`₹${nf(s.avgLoss, 0)}`} up={false} />
            <K l="Max DD" v={`₹${nf(s.maxDrawdown, 0)}`} up={false} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-term-dim">
            <span>
              {res.symbol} {res.expiry ?? "—"} · {res.instrument} {res.side} ·{" "}
              {res.candles != null
                ? `${res.candles} × ${(res.interval ?? 300) / 60}m (${res.days}d)`
                : `${res.days} days`}{" "}
              · {s.profitFactor != null ? `PF ${s.profitFactor}` : "PF –"}
            </span>
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                res.pricing === "historical"
                  ? "bg-up/20 text-up"
                  : res.pricing === "mixed"
                  ? "bg-amber-500/20 text-amber-400"
                  : "bg-term-border text-term-dim"
              }`}
              title={
                res.pricing === "historical"
                  ? "every leg priced from real historical option candles"
                  : res.pricing === "mixed"
                  ? "some legs from real option history, some Black-Scholes"
                  : `all legs Black-Scholes (IV ${(res.synIV * 100).toFixed(0)}%, ${res.synDTE} DTE)`
              }
            >
              {res.pricing} pricing
            </span>
            {!res.hasChain && (
              <span className="rounded bg-term-border px-1.5 py-0.5 text-[9px] text-term-dim" title="no daily OI/PCR/max-pain history for this range — OI-based conditions were inert">
                indicators only
              </span>
            )}
          </div>
          <div className="mt-1.5">{curve}</div>
          {res.trades.length > 0 && (
            <div className="mt-1.5 max-h-40 overflow-x-auto overflow-y-auto">
              <table className="grid-table">
                <thead className="text-term-dim">
                  <tr>
                    <th className="py-0.5 text-left font-medium">Date</th>
                    <th className="py-0.5 text-left font-medium">Entry time</th>
                    <th className="py-0.5 text-left font-medium">Exit time</th>
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
                      <td className="num whitespace-nowrap py-0.5 text-term-dim">
                        {ddmmyy(t.entryDate)}
                        {t.exitDate !== t.entryDate ? `→${ddmmyy(t.exitDate)}` : ""}
                      </td>
                      <td className="num whitespace-nowrap py-0.5 text-term-dim">
                        {t.entryTime ? hhmmss(t.entryTime) : "—"}
                      </td>
                      <td className="num whitespace-nowrap py-0.5 text-term-dim">
                        {t.exitTime ? hhmmss(t.exitTime) : "—"}
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
