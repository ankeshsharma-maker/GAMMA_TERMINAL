import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { api, type VolRow, type VolSnapshot } from "../lib/api";
import { nf } from "../lib/format";

/** shares: 1,33,45,678 -> "1.33Cr", 12,40,000 -> "12.4L" (no space: the columns are narrow) */
export const qty = (v: number) => (v >= 1e7 ? `${(v / 1e7).toFixed(v >= 1e8 ? 1 : 2)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(1)}L` : nf(v, 0));
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
const px = (v: number) => (v >= 10000 ? nf(v, 0) : v >= 1000 ? nf(v, 1) : nf(v));

/** fo = stocks with options, cash = NSE stocks WITHOUT options, all = every NSE stock */
export type Universe = "fo" | "cash" | "all";

/** the Volume and Movers tabs' data, refreshed every 20 s ("cash" = the all-NSE list minus F&O) */
export function useStockScan(universe: Universe, pos = false) {
  const [data, setData] = useState<VolSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    const load = () =>
      api.volumeScreener(universe === "fo" ? "fo" : "all", pos).then(
        (d) => alive && (setData(universe === "cash" ? { ...d, rows: d.rows.filter((r) => !r.fo) } : d), setErr(null)),
        (e) => alive && setErr(String(e?.message || e))
      );
    load();
    const t = window.setInterval(() => !document.hidden && load(), 20_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [universe, pos]);
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
const COLS: Col[] = ["symbol", "ltp", "chg", "dir", "metric", "vol", "value"];
/** the narrowest each column can go with 12-px numbers (measured on a 360-px phone; Dir shows
 *  only its arrow below DIR_WORD). SYMBOL may go down to 76 (long names end in "…"). */
const MIN_W: Record<Col, number> = { symbol: 76, ltp: 45, chg: 47, dir: 26, metric: 44, vol: 41, value: 41 };
/** SYMBOL is filled first up to this (a 10-letter symbol in full), then spare room is shared by GROW */
const SYMBOL_WANT = 92;
const GROW: Record<Col, number> = { symbol: 2, ltp: 1, chg: 1, dir: 1, metric: 1, vol: 1, value: 1 };
const DIR_WORD = 40; // Dir wide enough for "▲ Buy" rather than just "▲"
const STAR_W = 22;
/** only the columns someone has dragged are stored; the rest fit the screen every time */
const W_KEY = "scan.colWidths.v4";
/** widths that fill `avail` px: the dragged ones as set, the others from their minimum up,
 *  spare room shared by GROW. Narrower than the minimums -> the table swipes (SYMBOL frozen). */
const fitWidths = (avail: number, fixed: Partial<Record<Col, number>>): Record<Col, number> => {
  const out = {} as Record<Col, number>;
  for (const c of COLS) out[c] = fixed[c] ?? MIN_W[c];
  let room = avail - COLS.reduce((s, c) => s + out[c], 0);
  if (room <= 0) return out;
  if (fixed.symbol == null) {
    const add = Math.min(room, SYMBOL_WANT - out.symbol);
    out.symbol += add;
    room -= add;
  }
  const free = COLS.filter((c) => fixed[c] == null);
  const grow = free.reduce((s, c) => s + GROW[c], 0);
  if (grow) for (const c of free) out[c] += Math.floor((room * GROW[c]) / grow);
  return out;
};
const DIR: Record<string, { label: string; cls: string; n: number }> = {
  BUY: { label: "▲ Buy", cls: "text-up", n: 1 },
  SELL: { label: "▼ Sell", cls: "text-down", n: -1 },
  MIXED: { label: "◆", cls: "text-term-dim", n: 0 },
};
const readWidths = (): Partial<Record<Col, number>> => {
  try {
    return JSON.parse(localStorage.getItem(W_KEY) || "{}");
  } catch {
    return {};
  }
};
const saveWidths = (w: Partial<Record<Col, number>>) => {
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

  // ---- column widths: fit the box by default; drag a header's right edge to resize (that
  //      column is then remembered on this device), double-tap it to go back to fitting ----
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBoxW(el.clientWidth);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure); // phone rotation, in case the observer is late
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const [fixed, setFixed] = useState<Partial<Record<Col, number>>>(readWidths);
  const w = useMemo(() => fitWidths(Math.max(0, boxW - STAR_W), fixed), [boxW, fixed]);
  const drag = (c: Col) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = w[c];
    const move = (ev: PointerEvent) =>
      setFixed((p) => ({ ...p, [c]: Math.max(c === "dir" ? 24 : 36, Math.min(280, Math.round(w0 + ev.clientX - x0))) }));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setFixed((p) => {
        saveWidths(p);
        return p;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const resetWidth = (c: Col) =>
    setFixed((p) => {
      const n = { ...p };
      delete n[c];
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
        className={`w-full px-[3px] py-1.5 text-[10px] leading-tight font-semibold uppercase ${right ? "text-right" : "text-left"} ${
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
      className={`shrink-0 overflow-hidden whitespace-nowrap border-r border-term-border px-[3px] py-1.5 ${
        c === "symbol" ? "sticky left-0 z-[2] bg-inherit" : ""
      } ${cls}`}
    >
      {body}
    </div>
  );

  return (
    // shrink-0: a flex child of the scrolling tab, it must grow with its rows, not get its own scroll box
    <div ref={boxRef} className="mx-1 my-2 shrink-0 overflow-x-auto rounded-md border border-term-border">
      <div className="min-w-max">
        <div className="flex border-b border-term-border bg-term-panel">
          {head("symbol", "Symbol", false)}
          {head("ltp", "LTP", true)}
          {head("chg", "%Chg", true)}
          {head("dir", "Dir", true)}
          {head("metric", metric.label, true)}
          {head("vol", "Vol", true)}
          {head("value", "Value", true)}
          <div style={{ width: STAR_W }} className="shrink-0" />
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
                    <span className="truncate text-[12px] font-semibold text-term-text">{r.symbol}</span>
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
              {cell("ltp", "tabular-nums flex items-center justify-end text-term-text", px(r.ltp))}
              {cell(
                "chg",
                `tabular-nums flex items-center justify-end ${r.chgPct == null ? "text-term-dim" : r.chgPct >= 0 ? "text-up" : "text-down"}`,
                r.chgPct == null ? "–" : `${r.chgPct >= 0 ? "+" : ""}${nf(r.chgPct, Math.abs(r.chgPct) >= 10 ? 1 : 2)}%`
              )}
              {cell(
                "dir",
                `flex items-center justify-center font-semibold ${DIR[r.dir]?.cls ?? "text-term-dim"}`,
                <span title="Buying = above the day's VWAP and high in the day's range; selling = the opposite. An estimate.">
                  {w.dir >= DIR_WORD ? DIR[r.dir]?.label ?? "–" : DIR[r.dir]?.label.split(" ")[0] ?? "–"}
                </span>
              )}
              {cell("metric", "tabular-nums flex items-center justify-end", metric.cell(r))}
              {cell("vol", "tabular-nums flex items-center justify-end text-term-text", qty(r.vol))}
              {cell("value", "tabular-nums flex items-center justify-end text-term-dim", cr(r.value))}
              <button
                disabled={has}
                onClick={(e) => {
                  e.stopPropagation();
                  addWatch(key);
                  setAdded((a) => new Set(a).add(key));
                }}
                style={{ width: STAR_W }}
                className="shrink-0 text-center text-[15px] text-term-dim disabled:text-amber-400"
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
