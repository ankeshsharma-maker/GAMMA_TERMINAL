import { useMemo, useState } from "react";
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
const STATES = ["LONG BUILDUP", "SHORT BUILDUP", "LONG UNWINDING", "SHORT COVERING"];

/** Historical OI-state scan of a curated list (the active watchlist's
 *  index/stock symbols) as of a chosen date. Upstox connected. */
export function HistoricalScan() {
  const watch = useStore((s) => s.watch);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const setView = useStore((s) => s.setView);

  const symbols = useMemo(
    () => [...new Set(watch.filter((w) => w.kind !== "option").map((w) => w.symbol))].slice(0, 25),
    [watch]
  );

  const [date, setDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return iso(d);
  });
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Set<string>>(new Set());

  const run = () => {
    if (symbols.length === 0) {
      setErr("add index/stock symbols to your watchlist first");
      return;
    }
    setBusy(true);
    setErr(null);
    api.upstoxScanHistory(symbols, date).then(
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

  const shown = filter.size ? rows.filter((r) => r.state && filter.has(r.state)) : rows;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
        <span className="font-semibold uppercase tracking-wide">History scan</span>
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
        <span className="text-term-dim">watchlist symbols · max 25</span>
        {STATES.map((s) => (
          <button
            key={s}
            onClick={() =>
              setFilter((f) => {
                const n = new Set(f);
                n.has(s) ? n.delete(s) : n.add(s);
                return n;
              })
            }
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              filter.has(s) ? STATE_CLS[s] : "bg-term-panel text-term-dim"
            }`}
          >
            {s.replace(" BUILDUP", " B").replace("LONG ", "L ").replace("SHORT ", "S ")}
          </button>
        ))}
      </div>

      {err && <div className="border-b border-term-border px-3 py-1.5 text-2xs text-down">{err}</div>}

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="p-6 text-center text-xs text-term-dim">
            {busy ? "pulling history from Upstox…" : "Pick a date and Scan your watchlist."}
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-2xs">
            <thead className="sticky top-0 bg-term-panel text-[10px] uppercase text-term-dim">
              <tr>
                {["Symbol", "Spot", "ΔSpot", "Call OI", "Put OI", "PCR", "Max Pain", "OI State"].map((h) => (
                  <th key={h} className="border-b border-term-border px-3 py-1.5 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown
                .slice()
                .sort((a, b) => (a.state ?? "").localeCompare(b.state ?? ""))
                .map((r) => (
                  <tr key={r.symbol}>
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
                        r.dSpot >= 0 ? "text-up" : "text-down"
                      }`}
                    >
                      {r.dSpot >= 0 ? "+" : ""}
                      {nf(r.dSpot, 0)}
                    </td>
                    <td className="num border-b border-term-border/40 px-3 py-1" style={{ color: "#f87171" }}>
                      {lakhs(r.ceOI)}
                    </td>
                    <td className="num border-b border-term-border/40 px-3 py-1" style={{ color: "#4ade80" }}>
                      {lakhs(r.peOI)}
                    </td>
                    <td className="num border-b border-term-border/40 px-3 py-1">
                      {r.pcr != null ? nf(r.pcr, 2) : "–"}
                    </td>
                    <td className="num border-b border-term-border/40 px-3 py-1">
                      {r.maxPain != null ? nf(r.maxPain, 0) : "–"}
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
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
