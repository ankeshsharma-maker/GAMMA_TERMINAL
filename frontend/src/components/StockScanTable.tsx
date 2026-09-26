import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { api, type VolRow, type VolSnapshot } from "../lib/api";
import { nf } from "../lib/format";

/** shares: 1,33,45,678 -> "1.33Cr", 12,40,000 -> "12.4L" (no space: the columns are narrow) */
export const qty = (v: number) => (v >= 1e7 ? `${(v / 1e7).toFixed(2)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(1)}L` : nf(v, 0));
/** rupees -> "1.6KCr" / "151Cr" / "4.2Cr" / "85L" (short enough for a phone column) */
export const cr = (v: number) =>
  v >= 1e10
    ? `${(v / 1e10).toFixed(1)}KCr`
    : v >= 1e9
    ? `${nf(v / 1e7, 0)}Cr`
    : v >= 1e7
    ? `${(v / 1e7).toFixed(1)}Cr`
    : `${nf(v / 1e5, 0)}L`;
/** a price: 1 decimal from 10,000 up so "10,770.0" fits the column */
const px = (v: number) => (v >= 10000 ? nf(v, 1) : nf(v));

/** fo = stocks with options, cash = NSE stocks WITHOUT options, all = every NSE stock */
export type Universe = "fo" | "cash" | "all";

/** the Volume and Movers tabs' data, refreshed every 20 s ("cash" = the all-NSE list minus F&O) */
export function useStockScan(universe: Universe) {
  const [data, setData] = useState<VolSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    const load = () =>
      api.volumeScreener(universe === "fo" ? "fo" : "all").then(
        (d) => alive && (setData(universe === "cash" ? { ...d, rows: d.rows.filter((r) => !r.fo) } : d), setErr(null)),
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
  universe: Universe;
  setUniverse: (u: Universe) => void;
  data: VolSnapshot | null;
}) {
  const asOf = data?.asOf ? new Date(data.asOf * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[13px] font-bold uppercase tracking-wide text-term-text">{title}</span>
      <div className="flex overflow-hidden rounded border border-term-border">
        <button onClick={() => setUniverse("fo")} className={segCls(universe === "fo")}>
          F&amp;O
        </button>
        <button onClick={() => setUniverse("cash")} className={segCls(universe === "cash")} title="NSE stocks that have no options">
          Cash
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

type SortKey = "symbol" | "ltp" | "chg" | "dir" | "metric" | "vol" | "value";
type Col = SortKey;
/** default column widths (px) for 12-px numbers: wider than a phone -- the table swipes
 *  sideways with the SYMBOL column frozen on the left */
const DEF_W: Record<Col, number> = { symbol: 84, ltp: 72, chg: 60, dir: 44, metric: 54, vol: 62, value: 58 };
const W_KEY = "scan.colWidths.v3"; // v3: + the direction column, bigger text
const DIR: Record<string, { label: string; cls: string; n: number }> = {
  BUY: { label: "▲ Buy", cls: "text-up", n: 1 },
  SELL: { label: "▼ Sell", cls: "text-down", n: -1 },
  MIXED: { label: "◆", cls: "text-term-dim", n: 0 },
};
const readWidths = (): Record<Col, number> => {
  try {
    return { ...DEF_W, ...JSON.parse(localStorage.getItem(W_KEY) || "{}") };
  } catch {
    return { ...DEF_W };
  }
};
const saveWidths = (w: Record<Col, number>) => {
  try {
    localStorage.setItem(W_KEY, JSON.stringify(w));
  } catch {
    /* ignore */
  }
};

/** A grid, one line per stock: SYMBOL | LTP | %CHG | DIR | the scan's own number | VOLUME | VALUE | ☆
 *  (SYMBOL frozen while the table swipes sideways).
 *  Tap a header to sort (again to flip), drag a header's column line to resize it, tap a
 *  row for its chart. */
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
      sort.key === "symbol"
        ? r.symbol
        : sort.key === "ltp"
        ? r.ltp
        : sort.key === "chg"
        ? r.chgPct
        : sort.key === "vol"
        ? r.vol
        : sort.key === "dir"
        ? (DIR[r.dir]?.n ?? 0) * 1000 + (r.rvol ?? 0) // buys first, heaviest volume within
        : sort.key === "value"
        ? r.value
        : metric.sort(r);
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

  // ---- column widths: drag a header's right edge to resize; remembered on this device ----
  const [w, setW] = useState<Record<Col, number>>(readWidths);
  const drag = (c: Col) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = w[c];
    const move = (ev: PointerEvent) => setW((p) => ({ ...p, [c]: Math.max(40, Math.min(280, Math.round(w0 + ev.clientX - x0))) }));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setW((p) => {
        saveWidths(p);
        return p;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const resetWidth = (c: Col) =>
    setW((p) => {
      const n = { ...p, [c]: DEF_W[c] };
      saveWidths(n);
      return n;
    });

  const head = (k: SortKey & Col, label: string, right: boolean) => (
    <div
      style={{ width: w[k] }}
      className={`relative shrink-0 border-r border-term-border ${k === "symbol" ? "sticky left-0 z-[3] bg-term-panel" : ""}`}
    >
      <button
        onClick={() => setSort((s) => (s.key === k ? { key: k, dir: (s.dir * -1) as 1 | -1 } : { key: k, dir: k === "symbol" ? 1 : -1 }))}
        className={`w-full whitespace-nowrap px-1 py-1.5 text-[10px] font-semibold uppercase ${right ? "text-right" : "text-left"} ${
          sort.key === k ? "text-term-accent" : "text-term-dim"
        }`}
      >
        {label}
        {sort.key === k ? (sort.dir === 1 ? "▲" : "▼") : ""}
      </button>
      {/* the column line is the handle: drag it (mouse or finger) to widen / narrow; double-tap resets */}
      <span
        onPointerDown={drag(k)}
        onDoubleClick={() => resetWidth(k)}
        title="Drag to resize · double-tap to reset"
        className="absolute -right-[7px] top-0 z-10 flex h-full w-[13px] cursor-col-resize touch-none justify-center"
      >
        <span className="h-full w-[3px] rounded bg-term-border/0 hover:bg-term-accent/70 active:bg-term-accent" />
      </span>
    </div>
  );
  const cell = (c: Col, cls: string, body: ReactNode) => (
    <div
      style={{ width: w[c] }}
      className={`shrink-0 overflow-hidden whitespace-nowrap border-r border-term-border px-1 py-1.5 ${
        c === "symbol" ? "sticky left-0 z-[2] bg-inherit" : ""
      } ${cls}`}
    >
      {body}
    </div>
  );

  return (
    // shrink-0: a flex child of the scrolling tab, it must grow with its rows, not get its own scroll box
    <div className="mx-1 my-2 shrink-0 overflow-x-auto rounded-md border border-term-border">
      <div className="min-w-max">
        <div className="flex border-b border-term-border bg-term-panel">
          {head("symbol", "Symbol", false)}
          {head("ltp", "LTP", true)}
          {head("chg", "%Chg", true)}
          {head("dir", "Dir", true)}
          {head("metric", metric.label, true)}
          {head("vol", "Volume", true)}
          {head("value", "Value", true)}
          <div className="w-7 shrink-0" />
        </div>
        {sorted.length === 0 && <div className="p-6 text-center text-[12px] text-term-dim">{empty}</div>}
        {sorted.map((r, i) => {
          const key = r.fo ? r.symbol : `EQ:${r.symbol}`;
          const has = inWatch.has(key) || added.has(key);
          const open = () => {
            selectSymbol(r.symbol, true);
            setView("chart");
          };
          return (
            <div
              key={r.symbol}
              role="button"
              onClick={open}
              className={`flex cursor-pointer items-stretch text-[12px] active:bg-term-border ${
                i < sorted.length - 1 ? "border-b border-term-border" : ""
              } ${i % 2 ? "bg-term-panel" : "bg-term-bg"}`}
            >
              {cell(
                "symbol",
                "min-w-0",
                <>
                  <span className="flex items-center gap-1">
                    <span className="truncate text-[12.5px] font-semibold text-term-text">{r.symbol}</span>
                    {!r.fo && <span className="shrink-0 rounded bg-term-border px-0.5 text-[8px] font-semibold text-term-dim">CASH</span>}
                  </span>
                  {/* the breakout tag / company name sit on a small second line so the symbol keeps its room */}
                  {(tag?.(r) || r.name) && (
                    <span className="flex items-center gap-1 overflow-hidden text-[10px]">
                      {tag?.(r)}
                      {r.name && <span className="truncate text-term-dim/80">{r.name}</span>}
                    </span>
                  )}
                </>
              )}
              {cell("ltp", "num flex items-center justify-end text-term-text", px(r.ltp))}
              {cell(
                "chg",
                `num flex items-center justify-end ${r.chgPct == null ? "text-term-dim" : r.chgPct >= 0 ? "text-up" : "text-down"}`,
                r.chgPct == null ? "–" : `${r.chgPct >= 0 ? "+" : ""}${nf(r.chgPct)}%`
              )}
              {cell(
                "dir",
                `flex items-center justify-center font-semibold ${DIR[r.dir]?.cls ?? "text-term-dim"}`,
                <span title="Buying = above the day's VWAP and high in the day's range; selling = the opposite. An estimate.">
                  {DIR[r.dir]?.label ?? "–"}
                </span>
              )}
              {cell("metric", "num flex items-center justify-end", metric.cell(r))}
              {cell("vol", "num flex items-center justify-end text-term-text", qty(r.vol))}
              {cell("value", "num flex items-center justify-end text-term-dim", cr(r.value))}
              <button
                disabled={has}
                onClick={(e) => {
                  e.stopPropagation();
                  addWatch(key);
                  setAdded((a) => new Set(a).add(key));
                }}
                className="w-7 shrink-0 text-center text-[15px] text-term-dim disabled:text-amber-400"
                title={has ? "In your watchlist" : "Add to watchlist"}
              >
                {has ? "★" : "☆"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
