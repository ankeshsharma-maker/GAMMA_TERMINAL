import { useState } from "react";
import { RangePresets } from "./RangePresets";
import { FigureBoard, TONE_TEXT, money, tone, tradeTicks } from "./Figures";
import { LineChart } from "./LineChart";
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
const _GREEK_KINDS = new Set(["gamma_flip", "net_gex", "delta_change", "gamma_change", "gamma_vs_delta"]);
const usesGreeks = (rule: AutoRule) =>
  [...(rule.entry ?? []), ...(rule.exit ?? [])].some((c) => _GREEK_KINDS.has((c as { kind?: string }).kind ?? ""));

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
  const [costsOn, setCostsOn] = useState(true); // brokerage / STT / exchange / GST + slippage
  const [slip, setSlip] = useState("0.5"); // % of premium lost to the spread on each fill
  const [res, setRes] = useState<Res | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // gamma_flip / net_gex / delta_change / gamma_change / gamma_vs_delta only have historical
  // data reconstructed for the daily-bar path -- intraday backtests can never
  // fire these, so warn (but don't block) when this rule is off 1D.
  const dailyOnly = usesGreeks(rule);

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
    const costs = { enabled: costsOn, slippagePct: slip === "" ? 0.5 : Number(slip) };
    api
      .autobotBacktest(
        tf >= 86400
          ? { rule: merged, from, to, costs }
          : { rule: merged, from, to, interval: tf, bars: Number(nBars) || 0, costs }
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

  const s = res?.summary;
  const eq = res?.equity ?? [];

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
        {dailyOnly && tf < 86400 && (
          <span
            className="text-[9px] text-amber-400"
            title="gamma_flip / net_gex / delta_change / gamma_change / gamma_vs_delta only have historical data on daily bars — this timeframe will show 0 trades for this rule regardless of range"
          >
            heads up: this rule's gamma/delta conditions won't fire outside 1D
          </span>
        )}
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
          <span
            className="text-[9px] text-amber-400"
            title="Each bar is walked open → the extreme nearer the open → the farther extreme → close, so a stop or target touched inside a bar fills at its own price rather than at the close, and a gap through a stop fills at the open."
          >
            intraday · indicator-only, synthetic premiums · stops &amp; targets tested inside each bar
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

      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-term-dim">
        <span className="uppercase tracking-wide">Costs</span>
        <div className="seg">
          <button className={costsOn ? "on" : ""} onClick={() => setCostsOn(true)} title="Deduct brokerage, STT, exchange charges, GST and slippage from every trade">
            On
          </button>
          <button className={!costsOn ? "on" : ""} onClick={() => setCostsOn(false)} title="Gross results, as if trading were free">
            Off
          </button>
        </div>
        {costsOn && (
          <label className="flex items-center gap-1" title="How much of the premium you give up to the bid-ask spread on each fill (entry and exit)">
            slippage %
            <input
              value={slip}
              onChange={(e) => setSlip(e.target.value.replace(/[^\d.]/g, ""))}
              className="num w-10 rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text"
            />
          </label>
        )}
        <span className="text-[9px]">
          {costsOn ? "₹20/order brokerage + STT + exchange + GST (estimates), so the result is what you'd keep" : "gross — flatters frequent, small-premium trades"}
        </span>
      </div>

      {err && <div className="text-down">{err}</div>}

      {res && s && (
        <div className="mt-2 space-y-2 text-2xs">
          <FigureBoard
            s={s}
            gross={res.costs?.enabled && s.grossTotal != null ? s.grossTotal : null}
            costs={res.costs?.enabled && s.chargesTotal != null ? (s.chargesTotal ?? 0) + (s.slippageTotal ?? 0) : null}
          />
          {s.byReason && Object.keys(s.byReason).length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-term-dim">
              <span className="uppercase tracking-wide">Exits</span>
              {Object.entries(s.byReason)
                .sort((a, b) => b[1].n - a[1].n)
                .map(([k, v]) => (
                  <span key={k} className="rounded border border-term-border px-1.5 py-0.5" title={`${v.n} trade(s), ${money(v.pnl)} net`}>
                    {k} {v.n} · <span className={TONE_TEXT[tone(v.pnl)]}>{money(v.pnl, { sign: true })}</span>
                  </span>
                ))}
            </div>
          )}
          {(res.notSimulated?.length ?? 0) > 0 && (
            <div className="rounded bg-amber-500/10 px-2 py-1 text-amber-400">
              Not simulated in a backtest: {res.notSimulated!.join("; ")}. The live rule is stricter than this result.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-term-dim">
            <span>
              {res.symbol} {res.expiry ?? "—"} · {res.instrument}
              {String(res.instrument).includes("_") && !/_(CE|PE)$/.test(String(res.instrument)) ? "" : ` ${res.side}`} ·{" "}
              {res.candles != null
                ? `${res.candles} × ${(res.interval ?? 300) / 60}m (${res.days}d)`
                : `${res.days} days`}
            </span>
            <span
              className={`rounded px-1.5 py-0.5 font-semibold ${
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
              <span className="rounded bg-term-border px-1.5 py-0.5 text-term-dim" title="no daily OI/PCR/max-pain history for this range — OI-based conditions were inert">
                indicators only
              </span>
            )}
            {usesGreeks(rule) && !res.hasGreeksHistory && (
              <span
                className="rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-400"
                title="couldn't reconstruct historical gamma/delta/GEX for this range (fetch failed or too few days) — gamma_flip / net_gex / delta_change / gamma_change / gamma_vs_delta conditions never fired, so this result is not a real 'no signal' — re-run to retry the fetch"
              >
                no Greeks history — signal conditions inert
              </span>
            )}
            {res.interval == null && (rule.holdType ?? "intraday") !== "positional" && (
              <span
                className="rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-400"
                title="Daily bars only see one price per day, so entries here are force-closed same-day at ~0% P&L instead of carrying over — there's no way to simulate hitting SL/target/square-off intraday from one price a day. Good for checking WHEN entries fire, not for P&L. Switch the timeframe above off 1D for a realistic Intraday P&L simulation."
              >
                daily bars: entries only, no intraday P&L
              </span>
            )}
          </div>
          {eq.length >= 2 && (
            <div className="rounded border border-term-border bg-term-bg/30 p-2">
              <div className="mb-1 font-medium uppercase tracking-wide text-term-dim">
                Equity curve <span className="font-normal normal-case">· running P&amp;L, one point per trade</span>
              </div>
              <LineChart
                height={150}
                series={[
                  {
                    key: "eq",
                    label: "P&L",
                    color: eq[eq.length - 1] >= 0 ? "#22c55e" : "#f87171",
                    width: 1.6,
                    points: [{ x: 0, y: 0 }, ...eq.map((v, i) => ({ x: i + 1, y: v }))],
                  },
                ]}
                xFormat={(x) => (x === 0 ? "start" : `trade ${x}`)}
                xTicks={tradeTicks(eq.length)}
                yFormat={(y) => money(y, { sign: true })}
                hlines={[{ value: 0, color: "#94a3b8", dashed: true }]}
              />
            </div>
          )}
          {res.trades.length > 0 && (
            <div className="max-h-72 overflow-auto rounded border border-term-border">
              <table className="w-full border-separate border-spacing-0 text-2xs">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-term-dim">
                    {(
                      [
                        ["Date", "text-left"],
                        ["Entry time", "text-left"],
                        ["Exit time", "text-left"],
                        ["Strike", "text-left"],
                        ["Entry", "text-right"],
                        ["Exit", "text-right"],
                        ["P&L", "text-right"],
                        ["Why", "text-left"],
                      ] as const
                    ).map(([h, al]) => (
                      <th key={h} className={`sticky top-0 z-10 border-b border-term-border bg-term-panel2 px-2 py-1.5 font-medium ${al}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="num">
                  {res.trades.map((t, i) => (
                    <tr key={i} className="hover:bg-term-border/30">
                      <td className="whitespace-nowrap border-b border-term-border/50 px-2 py-1.5 text-term-dim">
                        {ddmmyy(t.entryDate)}
                        {t.exitDate !== t.entryDate ? `→${ddmmyy(t.exitDate)}` : ""}
                      </td>
                      <td className="whitespace-nowrap border-b border-term-border/50 px-2 py-1.5 text-term-dim">
                        {t.entryTime ? hhmmss(t.entryTime) : "—"}
                      </td>
                      <td className="whitespace-nowrap border-b border-term-border/50 px-2 py-1.5 text-term-dim">
                        {t.exitTime ? hhmmss(t.exitTime) : "—"}
                      </td>
                      <td className="border-b border-term-border/50 px-2 py-1.5" title={t.legs?.map((l) => `${l.side} ${l.strike}${l.ot}`).join(" · ")}>
                        {t.label ?? `${t.strike}${t.ot}`}
                      </td>
                      <td className="border-b border-term-border/50 px-2 py-1.5 text-right">{nf(t.entryPx)}</td>
                      <td className="border-b border-term-border/50 px-2 py-1.5 text-right">{nf(t.exitPx)}</td>
                      <td
                        className="whitespace-nowrap border-b border-term-border/50 px-2 py-1.5 text-right"
                        title={
                          t.grossRs != null
                            ? `gross ${money(t.grossRs)} − charges ${money(t.chargesRs ?? 0)} − slippage ${money(t.slippageRs ?? 0)} = net ${money(t.pnlRs)}`
                            : undefined
                        }
                      >
                        <span className={`font-semibold ${TONE_TEXT[tone(t.pnlRs)]}`}>{money(t.pnlRs, { sign: true })}</span>{" "}
                        <span className="text-term-dim">
                          {t.pnlPct > 0 ? "+" : t.pnlPct < 0 ? "−" : ""}
                          {Math.abs(t.pnlPct)}%
                        </span>
                      </td>
                      <td className="border-b border-term-border/50 px-2 py-1.5 font-sans text-term-dim">
                        {t.reason}
                        {t.scaled ? " · scaled out" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {res.trades.length === 0 && <div className="text-term-dim">No entries triggered in this window.</div>}
        </div>
      )}
    </div>
  );
}
