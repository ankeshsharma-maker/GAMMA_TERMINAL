import { Fragment, useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { lakhs, nf } from "../lib/format";

const iso = (d: Date) => d.toISOString().slice(0, 10);
type Row = Awaited<ReturnType<typeof api.upstoxScanHistory>>["rows"][number];

const STATE_CLS: Record<string, string> = {
  "LONG BUILDUP": "bg-up/20 text-up",
  "SHORT BUILDUP": "bg-down/20 text-down",
  "LONG UNWINDING": "bg-amber-500/20 text-amber-400",
  "SHORT COVERING": "bg-sky-500/20 text-sky-400",
};
const STATE_DOT: Record<string, string> = {
  "LONG BUILDUP": "#4ade80",
  "SHORT BUILDUP": "#f87171",
  "LONG UNWINDING": "#fbbf24",
  "SHORT COVERING": "#38bdf8",
};
const BIAS_CLS: Record<string, string> = {
  BULLISH: "bg-up/20 text-up",
  BEARISH: "bg-down/20 text-down",
  NEUTRAL: "bg-term-border text-term-dim",
};
const STATES = ["LONG BUILDUP", "SHORT BUILDUP", "LONG UNWINDING", "SHORT COVERING"];
const BIASES = ["BULLISH", "BEARISH", "NEUTRAL"];

/** Historical OI-state + smart-money scan of a curated list (the active
 *  watchlist's index/stock symbols) over a date range. Upstox connected. */
export function HistoricalScan() {
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
      ].slice(0, 25),
    [watch, symClass, symClassOk]
  );

  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    return iso(d);
  });
  const [to, setTo] = useState(() => iso(new Date()));
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stateF, setStateF] = useState<Set<string>>(new Set());
  const [biasF, setBiasF] = useState<Set<string>>(new Set());
  const [openSig, setOpenSig] = useState<string | null>(null);

  const run = () => {
    if (symbols.length === 0) {
      setErr("add index/stock symbols to your watchlist first");
      return;
    }
    setBusy(true);
    setErr(null);
    api.upstoxScanHistory(symbols, from, to).then(
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

  const shown = rows.filter(
    (r) =>
      (!stateF.size || (r.state && stateF.has(r.state))) &&
      (!biasF.size || biasF.has(r.smartBias))
  );

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, v: string) => {
    const n = new Set(set);
    n.has(v) ? n.delete(v) : n.add(v);
    setter(n);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
        <span className="font-semibold uppercase tracking-wide">History scan</span>
        <label className="flex items-center gap-1">
          from
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text"
          />
        </label>
        <label className="flex items-center gap-1">
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
          {busy ? "scanning…" : `Scan ${symbols.length}`}
        </button>
        <span className="text-term-dim">watchlist · max 25</span>
      </div>

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-term-border bg-term-panel px-3 py-1 text-[10px]">
          <span className="text-term-dim">State:</span>
          {STATES.map((s) => (
            <button
              key={s}
              onClick={() => toggle(stateF, setStateF, s)}
              className={`rounded px-1.5 py-0.5 ${stateF.has(s) ? STATE_CLS[s] : "bg-term-panel2 text-term-dim"}`}
            >
              {s.replace("LONG ", "L ").replace("SHORT ", "S ").replace(" BUILDUP", " B")}
            </button>
          ))}
          <span className="ml-2 text-term-dim">Bias:</span>
          {BIASES.map((b) => (
            <button
              key={b}
              onClick={() => toggle(biasF, setBiasF, b)}
              className={`rounded px-1.5 py-0.5 ${biasF.has(b) ? BIAS_CLS[b] : "bg-term-panel2 text-term-dim"}`}
            >
              {b}
            </button>
          ))}
        </div>
      )}

      {err && <div className="border-b border-term-border px-3 py-1.5 text-2xs text-down">{err}</div>}

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="p-6 text-center text-xs text-term-dim">
            {busy ? "pulling history from Upstox…" : "Pick a date range and Scan your watchlist."}
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-2xs">
            <thead className="sticky top-0 bg-term-panel text-[10px] uppercase text-term-dim">
              <tr>
                {["Symbol", "Spot", "Range move", "Net OI", "PCR", "Max Pain", "OI trail", "State", "Smart"].map(
                  (h) => (
                    <th key={h} className="border-b border-term-border px-3 py-1.5 text-left font-medium">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {shown
                .slice()
                .sort((a, b) => a.smartScore - b.smartScore)
                .map((r) => (
                  <Fragment key={r.symbol}>
                    <tr>
                      <td className="border-b border-term-border/40 px-3 py-1">
                        <button
                          className="font-semibold text-term-accent hover:underline"
                          onClick={() => {
                            selectSymbol(r.symbol, true);
                            setView("scrip");
                          }}
                        >
                          {r.symbol}
                        </button>
                      </td>
                      <td className="num border-b border-term-border/40 px-3 py-1">
                        {r.spot != null ? nf(r.spot, 0) : "–"}
                      </td>
                      <td
                        className={`num border-b border-term-border/40 px-3 py-1 ${
                          r.spotMove >= 0 ? "text-up" : "text-down"
                        }`}
                      >
                        {r.spotMove >= 0 ? "+" : ""}
                        {nf(r.spotMove, 0)}
                      </td>
                      <td
                        className={`num border-b border-term-border/40 px-3 py-1 ${
                          r.netOI >= 0 ? "text-term-text" : "text-amber-400"
                        }`}
                      >
                        {lakhs(r.netOI)}
                      </td>
                      <td className="num border-b border-term-border/40 px-3 py-1">
                        {r.pcr != null ? nf(r.pcr, 2) : "–"}
                      </td>
                      <td className="num border-b border-term-border/40 px-3 py-1">
                        {r.maxPain != null ? nf(r.maxPain, 0) : "–"}
                      </td>
                      <td className="border-b border-term-border/40 px-3 py-1">
                        <span className="flex gap-0.5">
                          {r.states.map((s, i) => (
                            <span
                              key={i}
                              title={s ?? ""}
                              className="h-2 w-2 rounded-full"
                              style={{ background: s ? STATE_DOT[s] : "#3f3f46" }}
                            />
                          ))}
                        </span>
                      </td>
                      <td className="border-b border-term-border/40 px-3 py-1">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                            STATE_CLS[r.state ?? ""] ?? "text-term-dim"
                          }`}
                        >
                          {r.state ?? "–"}
                        </span>
                      </td>
                      <td className="border-b border-term-border/40 px-3 py-1">
                        <button
                          onClick={() => setOpenSig(openSig === r.symbol ? null : r.symbol)}
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${BIAS_CLS[r.smartBias]}`}
                          title="show signals"
                        >
                          {r.smartBias} {r.smartScore > 0 ? `+${r.smartScore}` : r.smartScore}
                        </button>
                      </td>
                    </tr>
                    {openSig === r.symbol && (
                      <tr>
                        <td colSpan={9} className="border-b border-term-border/40 bg-term-bg/40 px-3 py-1.5 text-[10px] text-term-dim">
                          {r.smartSignals.length ? r.smartSignals.join("  ·  ") : "no notable signals"}
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
