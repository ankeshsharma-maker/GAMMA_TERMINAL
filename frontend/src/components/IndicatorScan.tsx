import { Fragment, useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf } from "../lib/format";

const iso = (d: Date) => d.toISOString().slice(0, 10);
type Row = Awaited<ReturnType<typeof api.upstoxIndicatorScan>>["rows"][number];

const TREND_CLS: Record<string, string> = {
  BULLISH: "bg-up/20 text-up",
  BEARISH: "bg-down/20 text-down",
  NEUTRAL: "bg-term-border text-term-dim",
};
const TRENDS = ["BULLISH", "BEARISH", "NEUTRAL"];

/** Daily technical-indicator scan of a curated list (the active watchlist's
 *  index/stock symbols) as of a chosen date — RSI(14), EMA 9/21/50, MACD
 *  histogram and the active signals. One Upstox candle call per symbol.
 *  Needs Upstox connected. */
export function IndicatorScan() {
  const watch = useStore((s) => s.watch);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const setView = useStore((s) => s.setView);
  const symClass = useStore((s) => s.symClass);
  const symClassOk = useStore((s) => s.symClassOk);

  const symbols = useMemo(
    () =>
      [
        ...new Set(
          watch
            .filter((w) => w.kind !== "option" && symClassOk(w.symbol))
            .map((w) => w.symbol)
        ),
      ].slice(0, 40),
    [watch, symClass, symClassOk]
  );

  const [date, setDate] = useState(() => iso(new Date()));
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [trendF, setTrendF] = useState<Set<string>>(new Set());
  const [openSig, setOpenSig] = useState<string | null>(null);

  const run = () => {
    if (symbols.length === 0) {
      setErr("add index/stock symbols to your watchlist first");
      return;
    }
    setBusy(true);
    setErr(null);
    api.upstoxIndicatorScan(symbols, date).then(
      (d) => {
        setRows(d.rows);
        setBusy(false);
      },
      (e) => {
        setErr(e?.message || "failed");
        setBusy(false);
      }
    );
  };

  const shown = rows.filter((r) => !trendF.size || trendF.has(r.trend));

  const toggle = (v: string) => {
    const n = new Set(trendF);
    n.has(v) ? n.delete(v) : n.add(v);
    setTrendF(n);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
        <span className="font-semibold uppercase tracking-wide">Indicator scan</span>
        <label className="flex items-center gap-1">
          as of
          <input
            type="date"
            value={date}
            max={iso(new Date())}
            onChange={(e) => setDate(e.target.value)}
            className="rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text"
          />
        </label>
        <button
          onClick={run}
          disabled={busy}
          className="rounded bg-term-accent px-2 py-0.5 font-semibold text-white disabled:opacity-40"
        >
          {busy ? "scanning…" : `Scan ${symbols.length}`}
        </button>
        <span className="text-term-dim">watchlist · RSI · EMA 9/21/50 · MACD</span>
      </div>

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-term-border bg-term-panel px-3 py-1 text-[10px]">
          <span className="text-term-dim">Trend:</span>
          {TRENDS.map((t) => (
            <button
              key={t}
              onClick={() => toggle(t)}
              className={`rounded px-1.5 py-0.5 ${trendF.has(t) ? TREND_CLS[t] : "bg-term-panel2 text-term-dim"}`}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {err && <div className="border-b border-term-border px-3 py-1.5 text-2xs text-down">{err}</div>}

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="p-6 text-center text-xs text-term-dim">
            {busy ? "computing indicators from Upstox candles…" : "Pick a date and Scan your watchlist."}
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-2xs">
            <thead className="sticky top-0 bg-term-panel text-[10px] uppercase text-term-dim">
              <tr>
                {["Symbol", "Spot", "RSI", "EMA9", "EMA21", "EMA50", "MACD h", "Signals", "Trend"].map((h) => (
                  <th key={h} className="border-b border-term-border px-3 py-1.5 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown
                .slice()
                .sort((a, b) => b.score - a.score)
                .map((r) => (
                  <Fragment key={r.symbol}>
                    <tr>
                      <td className="border-b border-term-border/40 px-3 py-1">
                        <button
                          className="font-semibold text-term-accent hover:underline"
                          onClick={() => {
                            selectSymbol(r.symbol, true);
                            setView("chart");
                          }}
                        >
                          {r.symbol}
                        </button>
                      </td>
                      <td className="num border-b border-term-border/40 px-3 py-1">{nf(r.spot, 0)}</td>
                      <td
                        className={`num border-b border-term-border/40 px-3 py-1 ${
                          r.rsi == null
                            ? "text-term-dim"
                            : r.rsi < 30
                            ? "text-up"
                            : r.rsi > 70
                            ? "text-down"
                            : ""
                        }`}
                      >
                        {r.rsi != null ? nf(r.rsi, 1) : "–"}
                      </td>
                      <td className="num border-b border-term-border/40 px-3 py-1">
                        {r.ema9 != null ? nf(r.ema9, 0) : "–"}
                      </td>
                      <td className="num border-b border-term-border/40 px-3 py-1">
                        {r.ema21 != null ? nf(r.ema21, 0) : "–"}
                      </td>
                      <td className="num border-b border-term-border/40 px-3 py-1">
                        {r.ema50 != null ? nf(r.ema50, 0) : "–"}
                      </td>
                      <td
                        className={`num border-b border-term-border/40 px-3 py-1 ${
                          r.macdHist == null ? "text-term-dim" : r.macdHist >= 0 ? "text-up" : "text-down"
                        }`}
                      >
                        {r.macdHist != null ? nf(r.macdHist, 2) : "–"}
                      </td>
                      <td className="border-b border-term-border/40 px-3 py-1">
                        {r.signals.length ? (
                          <button
                            onClick={() => setOpenSig(openSig === r.symbol ? null : r.symbol)}
                            className="rounded bg-term-panel2 px-1.5 py-0.5 text-[10px] text-term-text"
                          >
                            {r.signals.length} signal{r.signals.length === 1 ? "" : "s"}
                          </button>
                        ) : (
                          <span className="text-term-dim">–</span>
                        )}
                      </td>
                      <td className="border-b border-term-border/40 px-3 py-1">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${TREND_CLS[r.trend]}`}
                        >
                          {r.trend} {r.score > 0 ? `+${r.score}` : r.score}
                        </span>
                      </td>
                    </tr>
                    {openSig === r.symbol && (
                      <tr>
                        <td
                          colSpan={9}
                          className="border-b border-term-border/40 bg-term-bg/40 px-3 py-1.5 text-[10px] text-term-dim"
                        >
                          {r.signals.join("  ·  ")}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
