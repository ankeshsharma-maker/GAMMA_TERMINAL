import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { api, type VolRow, type VolSnapshot } from "../lib/api";
import { nf } from "../lib/format";

/** 1,33,45,678 shares -> "1.33 Cr", 12,40,000 -> "12.4 L" */
export const qty = (v: number) => (v >= 1e7 ? `${(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(1)} L` : nf(v, 0));
/** rupees -> "1.6K Cr" / "151 Cr" / "4.2 Cr" / "85 L" (short enough for a phone column) */
export const cr = (v: number) =>
  v >= 1e10
    ? `${(v / 1e10).toFixed(1)}K Cr`
    : v >= 1e9
    ? `${nf(v / 1e7, 0)} Cr`
    : v >= 1e7
    ? `${(v / 1e7).toFixed(1)} Cr`
    : `${nf(v / 1e5, 0)} L`;

/** the Volume and 52W / Gaps tabs' data: F&O or all NSE, refreshed every 20 s */
export function useStockScan(universe: "fo" | "all") {
  const [data, setData] = useState<VolSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    const load = () =>
      api.volumeScreener(universe).then(
        (d) => alive && (setData(d), setErr(null)),
        (e) => alive && setErr(String(e?.message || e))
      );
    load();
    const t = window.setInterval(() => !document.hidden && load(), 20_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [universe]);
  return { data, setData, err };
}

const segCls = (on: boolean) =>
  `whitespace-nowrap px-2.5 py-1 text-[12px] font-semibold ${on ? "bg-term-accent/20 text-term-accent" : "text-term-dim"}`;

/** Title + F&O / All NSE switch + live / closed status: the top line of both tabs */
export function ScanHeader({
  title,
  universe,
  setUniverse,
  data,
}: {
  title: string;
  universe: "fo" | "all";
  setUniverse: (u: "fo" | "all") => void;
  data: VolSnapshot | null;
}) {
  const asOf = data?.asOf ? new Date(data.asOf * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[13px] font-bold uppercase tracking-wide text-term-text">{title}</span>
      <div className="flex overflow-hidden rounded border border-term-border">
        <button onClick={() => setUniverse("fo")} className={segCls(universe === "fo")}>
          F&amp;O stocks
        </button>
        <button onClick={() => setUniverse("all")} className={segCls(universe === "all")}>
          All NSE
        </button>
      </div>
      <span className="ml-auto text-[11px] text-term-dim">
        {data?.market === "open" ? (asOf ? `live · ${asOf}` : "loading…") : asOf ? "market closed · last session" : ""}
      </span>
    </div>
  );
}

/** a row of pill buttons */
export function Chips<T extends string | number>({
  items,
  value,
  onChange,
}: {
  items: [T, string][];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="no-scrollbar flex gap-1 overflow-x-auto">
      {items.map(([v, label]) => (
        <button
          key={String(v)}
          onClick={() => onChange(v)}
          className={`whitespace-nowrap rounded-full border px-3 py-1 text-[12px] font-semibold ${
            value === v ? "border-term-accent bg-term-accent/20 text-term-accent" : "border-term-border text-term-dim"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** "Min traded: any / ₹1 / ₹5 / ₹25 Cr" */
export function MinTraded({ value, onChange, children }: { value: number; onChange: (v: number) => void; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-term-dim">
      <span>Min traded</span>
      <div className="flex overflow-hidden rounded border border-term-border">
        {[0, 1, 5, 25].map((v) => (
          <button key={v} onClick={() => onChange(v)} className={segCls(value === v)}>
            {v ? `₹${v} Cr` : "any"}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}

export type Metric = {
  /** column header, e.g. "X USUAL", "GAP" */
  label: string;
  /** the cell */
  cell: (r: VolRow) => ReactNode;
  /** what the column sorts by */
  sort: (r: VolRow) => number | null;
};

type SortKey = "symbol" | "ltp" | "chg" | "metric" | "value";

/** One line per stock: SYMBOL | LTP | %CHG | the scan's own number | VALUE | ☆.
 *  Tap a header to sort (again to flip); tap a row for its chart. */
export function ScanTable({
  rows,
  metric,
  sort: initial,
  tag,
  empty,
}: {
  rows: VolRow[];
  metric: Metric;
  sort: { key: SortKey; dir: 1 | -1 };
  /** a small marker after the symbol (e.g. ▲ PDH) */
  tag?: (r: VolRow) => ReactNode;
  empty: string;
}) {
  const selectSymbol = useStore((s) => s.selectSymbol);
  const setView = useStore((s) => s.setView);
  const addWatch = useStore((s) => s.addWatch);
  const watch = useStore((s) => s.watch);
  const [sort, setSort] = useState(initial);
  const [added, setAdded] = useState<Set<string>>(new Set());
  useEffect(() => setSort(initial), [initial.key, initial.dir, metric.label]); // eslint-disable-line react-hooks/exhaustive-deps
  const inWatch = useMemo(() => new Set(watch.map((w) => w.key)), [watch]);

  const sorted = useMemo(() => {
    const v = (r: VolRow): number | string | null =>
      sort.key === "symbol" ? r.symbol : sort.key === "ltp" ? r.ltp : sort.key === "chg" ? r.chgPct : sort.key === "value" ? r.value : metric.sort(r);
    return [...rows]
      .sort((a, b) => {
        const x = v(a);
        const y = v(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return typeof x === "string" ? sort.dir * x.localeCompare(String(y)) : sort.dir * (x - (y as number));
      })
      .slice(0, 150);
  }, [rows, sort, metric]);

  const head = (k: SortKey, label: string, cls: string) => (
    <button
      onClick={() => setSort((s) => (s.key === k ? { key: k, dir: (s.dir * -1) as 1 | -1 } : { key: k, dir: k === "symbol" ? 1 : -1 }))}
      className={`${cls} whitespace-nowrap py-1.5 text-[9px] font-semibold uppercase ${sort.key === k ? "text-term-accent" : "text-term-dim"}`}
    >
      {label}
      {sort.key === k ? (sort.dir === 1 ? "▲" : "▼") : ""}
    </button>
  );

  return (
    <div>
      <div className="sticky top-0 z-[5] flex items-center border-b border-term-border bg-term-panel px-3">
        {head("symbol", "Symbol", "min-w-0 flex-1 text-left")}
        {head("ltp", "LTP", "w-[62px] text-right")}
        {head("chg", "%Chg", "w-[52px] pl-1 text-right")}
        {head("metric", metric.label, "w-[54px] pl-1 text-right")}
        {head("value", "Value", "w-[56px] pl-1.5 text-right")}
        <span className="w-7" />
      </div>
      {sorted.length === 0 && <div className="p-6 text-center text-[12px] text-term-dim">{empty}</div>}
      {sorted.map((r) => {
        const key = r.fo ? r.symbol : `EQ:${r.symbol}`;
        const has = inWatch.has(key) || added.has(key);
        return (
          <div key={r.symbol} className="flex items-center border-b border-term-border/50 px-3 text-[11.5px]">
            <button
              onClick={() => {
                selectSymbol(r.symbol, true);
                setView("chart");
              }}
              className="flex min-w-0 flex-1 items-center py-2 text-left active:bg-term-border/40"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1">
                  <span className="truncate font-semibold text-term-text">{r.symbol}</span>
                  {!r.fo && <span className="shrink-0 rounded bg-term-border px-0.5 text-[8px] font-semibold text-term-dim">CASH</span>}
                </span>
                {/* the breakout tag / company name sit on a small second line so the symbol keeps its room */}
                {(tag?.(r) || r.name) && (
                  <span className="flex items-center gap-1 text-[9px]">
                    {tag?.(r)}
                    {r.name && <span className="truncate text-term-dim/80">{r.name}</span>}
                  </span>
                )}
              </span>
              <span className="num w-[62px] text-right text-term-text">{nf(r.ltp)}</span>
              <span
                className={`num w-[52px] text-right ${r.chgPct == null ? "text-term-dim" : r.chgPct >= 0 ? "text-up" : "text-down"}`}
              >
                {r.chgPct == null ? "–" : `${r.chgPct >= 0 ? "+" : ""}${nf(r.chgPct)}%`}
              </span>
              <span className="num w-[54px] pl-1 text-right">{metric.cell(r)}</span>
              <span className="num w-[56px] pl-1.5 text-right text-term-dim">{cr(r.value)}</span>
            </button>
            <button
              disabled={has}
              onClick={() => {
                addWatch(key);
                setAdded((a) => new Set(a).add(key));
              }}
              className="w-7 shrink-0 py-2 text-right text-[15px] text-term-dim disabled:text-amber-400"
              title={has ? "In your watchlist" : "Add to watchlist"}
            >
              {has ? "★" : "☆"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
