import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useStore } from "../store";
import { OrderSheet } from "./OrderSheet";
import { api } from "../lib/api";
import { nf } from "../lib/format";
import { SelectMenu } from "./SelectMenu";
import type { WatchQuote } from "../types";

type SortKey = "none" | "az" | "ltp" | "pct" | "chg";

/** one-click preset watchlists — loads into a new list (or the active one at max) */
const WL_PRESETS: { name: string; syms: string[] }[] = [
  { name: "Indices", syms: ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX", "INDIA VIX"] },
  { name: "Bank pack", syms: ["BANKNIFTY", "HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "KOTAKBANK", "BANKBARODA", "PNB", "INDUSINDBK", "AUBANK", "FEDERALBNK"] },
  { name: "Liquid option movers", syms: ["RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN", "TATAMOTORS", "TATASTEEL", "AXISBANK", "ADANIENT"] },
  { name: "NIFTY heavyweights", syms: ["RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "ITC", "LT", "BHARTIARTL", "SBIN", "AXISBANK"] },
  { name: "IT pack", syms: ["TCS", "INFY", "HCLTECH", "WIPRO", "TECHM", "LTIM", "PERSISTENT", "COFORGE", "MPHASIS"] },
  { name: "Auto pack", syms: ["MARUTI", "TATAMOTORS", "M&M", "BAJAJ-AUTO", "EICHERMOT", "HEROMOTOCO", "TVSMOTOR", "ASHOKLEY", "BOSCHLTD"] },
  { name: "Metals & energy", syms: ["TATASTEEL", "JSWSTEEL", "HINDALCO", "VEDL", "JINDALSTEL", "SAIL", "NMDC", "COALINDIA", "ONGC", "NTPC", "POWERGRID"] },
  { name: "High-beta momentum", syms: ["ADANIENT", "ADANIPORTS", "ADANIGREEN", "RELIANCE", "DLF", "IRCTC", "IEX", "POLYCAB", "TRENT"] },
  { name: "Pharma & FMCG", syms: ["SUNPHARMA", "DRREDDY", "CIPLA", "DIVISLAB", "ITC", "HINDUNILVR", "NESTLEIND", "BRITANNIA", "DABUR"] },
];

const wPx = (w: WatchQuote) =>
  (w.kind === "option" || w.kind === "future" ? w.ltp : w.liveSpot ?? w.spot) ?? null;
const wPct = (w: WatchQuote) =>
  (w.kind === "option" || w.kind === "future" ? w.chgPct : w.liveChgPct) ?? null;
const wChg = (w: WatchQuote) => {
  const p = wPx(w);
  const c = wPct(w);
  return p != null && c != null ? (p * c) / 100 : null; // approx rupee move
};
const wName = (w: WatchQuote) =>
  w.kind === "option"
    ? `${w.symbol} ${w.strike} ${w.optionType}`
    : w.kind === "future"
    ? `${w.symbol} ${w.expiry} FUT`
    : w.symbol;

function sortWatch(rows: WatchQuote[], { k, dir }: { k: SortKey; dir: 1 | -1 }) {
  if (k === "none") return rows;
  const val = (w: WatchQuote): number | string | null =>
    k === "az" ? wName(w) : k === "ltp" ? wPx(w) : k === "pct" ? wPct(w) : wChg(w);
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1; // nulls last
    if (y == null) return -1;
    if (typeof x === "string" || typeof y === "string")
      return dir * String(x).localeCompare(String(y));
    return dir * (x - y);
  });
}

const BSE_SYMS = new Set(["SENSEX", "BANKEX", "SENSEX50", "SNSX50"]);
/** "24-Sep-2026" -> "24 SEP" */
const shortExp = (e?: string) => {
  const m = /^(\d{1,2})-([A-Za-z]{3})/.exec(e ?? "");
  return m ? `${m[1]} ${m[2].toUpperCase()}` : e ?? "";
};
/** broker-style full contract name: "SENSEX 24 SEP 74500 CE", "NIFTY 30 SEP FUT" */
/** Tap an index / stock: its price, a big Chart button, and the symbol's OI views. */
function SymbolSheet({
  w,
  name,
  px,
  chg,
  pct,
  onClose,
  onChart,
  onView,
}: {
  w: WatchQuote;
  name: string;
  px: number | null | undefined;
  chg: number | null | undefined;
  pct: number | null | undefined;
  onClose: () => void;
  onChart: () => void;
  onView: (v: "chain" | "oiprofile" | "trendingoi" | "flow") => void;
}) {
  const up = (pct ?? chg ?? 0) >= 0;
  const views = [
    ["chain", "Option Chain"],
    ["oiprofile", "OI"],
    ["trendingoi", "Trend OI"],
    ["flow", "Flow"],
  ] as const;
  return (
    <div className="fixed inset-0 z-[55] flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-xl border border-term-border bg-term-panel p-3 shadow-2xl sm:rounded-xl"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-term-text">{name}</div>
            <div className="text-[11px] text-term-dim">
              {w.kind === "index" || /^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|NIFTYNXT50|SENSEX|BANKEX|SENSEX50)$/.test(w.symbol)
                ? "Index"
                : "Stock"}
            </div>
          </div>
          <div className="text-right">
            <div className="num text-[16px] font-semibold text-term-text">{px != null ? nf(px) : "–"}</div>
            {(chg != null || pct != null) && (
              <div className={`num text-[11px] ${up ? "text-up" : "text-down"}`}>
                {chg != null ? `${chg >= 0 ? "+" : ""}${nf(chg)}` : ""}
                {pct != null ? ` (${pct >= 0 ? "+" : ""}${nf(pct)}%)` : ""}
              </div>
            )}
          </div>
        </div>
        <button
          onClick={onChart}
          className="mt-3 w-full rounded-lg border border-term-accent/60 bg-term-accent/15 py-3 text-[15px] font-bold text-term-accent active:bg-term-accent/30"
        >
          📈 Chart
        </button>
        {/* an F&O underlying has an option chain; a plain index (INDIA VIX...) doesn't */}
        {w.kind !== "index" && (
        <div className="mt-2 grid grid-cols-4 gap-2">
          {views.map(([v, label]) => (
            <button
              key={v}
              onClick={() => onView(v)}
              className="rounded-md border border-term-border py-2 text-[12px] font-semibold text-term-text active:bg-term-border"
            >
              {label}
            </button>
          ))}
        </div>
        )}
      </div>
    </div>
  );
}

const wFull = (w: WatchQuote) =>
  w.kind === "option"
    ? `${w.symbol} ${shortExp(w.expiry)} ${w.strike} ${w.optionType}`
    : w.kind === "future"
    ? `${w.symbol} ${shortExp(w.expiry)} FUT`
    : w.symbol;
/** the segment a broker shows under the name: NSE / BSE for the cash leg,
 *  NFO / BFO for options and futures */
const wSeg = (w: WatchQuote) => {
  const bse = BSE_SYMS.has(w.symbol.toUpperCase());
  if (w.kind === "option" || w.kind === "future") return bse ? "BFO" : "NFO";
  return bse ? "BSE" : "NSE";
};
const wAbsChg = (w: WatchQuote) => {
  if (w.variation != null) return w.variation;
  const p = wPx(w);
  const c = wPct(w);
  return p != null && c != null ? (p * c) / 100 : null;
};

/** one quote, laid out like the Flattrade / Kite marketwatch: full contract
 *  name over its segment on the left, ▲/▼ LTP over the change on the right.
 *  No buttons -- tap charts it; the ⋮ menu's "Edit list" shows a remove ✕.
 *  `compact` = a narrow panel (the desktop's left pane is ~190px by default). */
function MarketRow({
  w,
  queue,
  editing,
  compact,
}: {
  w: WatchQuote;
  queue: string[];
  editing: boolean;
  compact: boolean;
}) {
  const {
    symbol, selectSymbol, selectExpiry, setChartInstrument, chartInstrument, setView, removeWatch,
    setChartQueue,
  } = useStore();
  const on = w.kind === "option" ? chartInstrument === w.key : w.symbol === symbol;
  const px = wPx(w);
  const pct = wPct(w);
  const chg = wAbsChg(w);
  const has = pct != null || chg != null;
  const up = (pct ?? chg ?? 0) >= 0;
  const col = !has ? "text-term-text" : up ? "text-up" : "text-down";
  const [sheet, setSheet] = useState(false);
  // an option / future row opens the order sheet; an index / stock a quick sheet (Chart + its OI views)
  const tap = () => setSheet(true);
  const tradable = w.kind === "option" || w.kind === "future";
  const sheetEl =
    sheet &&
    (tradable ? (
      <OrderSheet
        w={w}
        name={wFull(w)}
        onClose={() => setSheet(false)}
        onChart={() => {
          setSheet(false);
          open();
        }}
      />
    ) : (
      <SymbolSheet
        w={w}
        name={wFull(w)}
        px={px}
        chg={chg}
        pct={pct}
        onClose={() => setSheet(false)}
        onChart={() => {
          setSheet(false);
          open();
        }}
        onView={(v) => {
          setSheet(false);
          selectSymbol(w.symbol, true);
          setView(v);
        }}
      />
    ));
  const open = () => {
    setChartQueue("Watchlist", queue);
    selectSymbol(w.symbol, true);
    if (w.kind === "option") {
      if (w.expiry) selectExpiry(w.expiry);
      setChartInstrument(w.key);
    }
    setView("chart");
  };
  const removeBtn = editing && (
    <button
      onClick={() => removeWatch(w.key)}
      title="Remove from this list"
      className={`shrink-0 rounded-full border border-down/50 bg-down/10 px-2.5 py-1 text-xs font-semibold text-down ${
        compact ? "mr-2" : "mr-3"
      }`}
    >
      ✕
    </button>
  );
  if (compact)
    // a narrow panel can't fit a full contract name beside the price: the
    // name gets the whole first line; segment, ▲ LTP and % share the second
    return (
      <div
        className={`flex items-center border-b border-term-border/70 ${
          on ? "bg-term-accent/[0.07]" : "hover:bg-term-panel/60"
        }`}
      >
        <button onClick={tap} title={`Chart ${wName(w)}`} className="min-w-0 flex-1 px-2 py-1.5 text-left">
          <span className="block truncate text-[12px] font-medium text-term-text">{wFull(w)}</span>
          <span className="mt-0.5 flex items-baseline gap-1.5 whitespace-nowrap">
            <span className="text-[10px] text-term-dim">{wSeg(w)}</span>
            <span className={`tabular-nums ml-auto text-[12px] font-medium ${col}`}>
              {has && <span className="mr-1 text-[8px]">{up ? "▲" : "▼"}</span>}
              {px != null ? nf(px) : "–"}
            </span>
            {pct != null && <span className="tabular-nums text-[10px] text-term-dim">{nf(pct)}%</span>}
          </span>
        </button>
        {removeBtn}
        {sheetEl}
      </div>
    );
  return (
    <div
      className={`flex items-center border-b border-term-border/70 ${
        on ? "bg-term-accent/[0.07]" : "hover:bg-term-panel/60"
      }`}
    >
      <button
        onClick={tap}
        title={`Chart ${wName(w)}`}
        className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-2.5 text-left active:bg-term-border/40"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-term-text">{wFull(w)}</span>
          <span className="mt-0.5 block text-[11px] text-term-dim">{wSeg(w)}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end">
          <span className={`tabular-nums flex items-center gap-1.5 text-[13px] font-medium ${col}`}>
            {has && <span className="text-[9px] leading-none">{up ? "▲" : "▼"}</span>}
            {px != null ? nf(px) : "–"}
          </span>
          <span className="tabular-nums mt-0.5 text-[11px] text-term-dim">
            {has ? `${nf(chg ?? 0)} (${nf(pct ?? 0)}%)` : " "}
          </span>
        </span>
      </button>
      {removeBtn}
      {sheetEl}
    </div>
  );
}

/** line icons for the Marketwatch header */
function HeadIcon({ d, w = 1.9, size = 21 }: { d: string; w?: number; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
const ICON = {
  bell: "M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 0 0 4 0",
  sort: "M4 7h16M4 12h11M4 17h6",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20",
  dots: "M12 5.5v.01M12 12v.01M12 18.5v.01",
};

const WL_MAX = 8;

/** The watchlist, phone and desktop alike, laid out like a broker's
 *  marketwatch (asked for from a Flattrade screenshot): a "Marketwatch ▾"
 *  header whose icons fold search / sort / tools away, the index band
 *  (`band`, phone), numbered list tabs, and one flat list of full-name rows.
 *  Sizes shrink to a compact version in a narrow panel. */
export function Watchlist({ band }: { band?: ReactNode } = {}) {
  const {
    watch,
    watchlists,
    addWatch,
    wlSetActive,
    wlRename,
    wlAddStrikes,
    wlAddFuture,
    wlClear,
    selectSymbol,
    symClassOk,
    setSymClass,
  } = useStore();
  const wlAdd = useStore((s) => s.wlAdd);
  const wlAddList = useStore((s) => s.wlAddList);
  const wlDeleteList = useStore((s) => s.wlDeleteList);
  const openNotif = useStore((s) => s.openNotif);
  const alertsUnseen = useStore(
    (s) =>
      Math.max(0, s.alerts.length - s.alertsSeen) + Math.max(0, s.unusual.length - s.unusualSeen)
  );

  // the panel's own width decides full vs compact sizing (the desktop pane is
  // resizable; a phone is always full)
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() =>
    window.matchMedia("(max-width: 900px)").matches ? window.innerWidth : 190
  );
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const compact = width < 300;

  const [input, setInput] = useState("");
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.symbolSearch>>["results"]>([]);
  const [openSearch, setOpenSearch] = useState(false);
  // each header icon opens its panel under the header
  const [searchOpen, setSearchOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [listsOpen, setListsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>(() => {
    try {
      const raw = localStorage.getItem("wlSort");
      return raw ? JSON.parse(raw) : { k: "none", dir: 1 };
    } catch {
      return { k: "none", dir: 1 };
    }
  });
  const setSortPersist = (k: SortKey) => {
    setSort((s) => {
      const next: { k: SortKey; dir: 1 | -1 } =
        s.k === k ? { k, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { k, dir: k === "az" ? 1 : -1 };
      try {
        localStorage.setItem("wlSort", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  const hasOptions = watch.some((w) => w.kind === "option");
  const [presetBusy, setPresetBusy] = useState(false);
  const loadPreset = async (p: (typeof WL_PRESETS)[number]) => {
    if (presetBusy || !watchlists) return;
    const target = watchlists.active ?? 0;
    setPresetBusy(true);
    let added = 0;
    try {
      for (const s of p.syms) {
        try {
          await wlAdd(target, s);
          added++;
          if (!symClassOk(s)) setSymClass("all");
        } catch {
          /* skip a symbol the catalog doesn't know */
        }
      }
      await wlSetActive(target);
    } finally {
      setPresetBusy(false);
      if (added < p.syms.length)
        alert(`Added ${added}/${p.syms.length} — the rest aren't in the F&O catalog.`);
    }
  };
  const active = watchlists?.active ?? 0;
  const searchTimer = useRef<number | null>(null);

  useEffect(() => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    const q = input.trim();
    if (q.length < 1) {
      setResults([]);
      return;
    }
    searchTimer.current = window.setTimeout(() => {
      api.symbolSearch(q, useStore.getState().symbol).then((d) => {
        setResults(d.results);
        setOpenSearch(true);
      }, () => {});
    }, 180);
  }, [input]);

  const addResult = async (add: string, optionable: boolean) => {
    await wlAdd(active, add);
    setInput("");
    setResults([]);
    setOpenSearch(false);
    // a symbol can be added successfully and still be invisible if the
    // persisted All/Indices/Stocks filter hides its class -- that looked
    // exactly like "adding does nothing" and cost a lot of back-and-forth
    // to actually diagnose, so never let a successful add go unseen.
    // an option key ("NIFTY|29-Sep-2026|23400|CE") is classed by its underlying
    if (!symClassOk(add.split("|")[0])) setSymClass("all");
    if (optionable && !add.startsWith("IDX:")) selectSymbol(add);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (results.length) {
      await addResult(results[0].add, results[0].optionable);
      return;
    }
    const v = input.trim().toUpperCase();
    if (!v) return;
    await addWatch(v);
    setInput("");
    if (!symClassOk(v)) setSymClass("all");
    selectSymbol(v);
  };

  // one flat list, in your order (or the chosen sort)
  const shown = sortWatch(watch, sort).filter((w) => symClassOk(w.symbol));
  // Next / Prev on the chart follow the underlyings in the order shown here
  const queueSyms = shown.filter((w) => w.kind !== "option" && w.kind !== "future").map((w) => w.symbol);

  // tabs are always numbered 1-5 like a broker's marketwatch; tapping a
  // number with no list behind it yet creates the missing lists (the server keeps 3)
  const pickList = async (i: number) => {
    if (!watchlists) return;
    let n = watchlists.lists.length;
    while (n <= i && n < WL_MAX) {
      await wlAddList();
      n++;
    }
    if (i !== (useStore.getState().watchlists?.active ?? 0)) await wlSetActive(i);
  };
  const headBtns = [
    { ic: "bell", title: "Alerts", on: false, w: 1.9, fn: () => openNotif() },
    { ic: "sort", title: "Sort", on: sortOpen, w: 1.9, fn: () => setSortOpen((o) => !o) },
    { ic: "search", title: "Search & add", on: searchOpen, w: 1.9, fn: () => setSearchOpen((o) => !o) },
    { ic: "dots", title: "Strikes, future, presets, edit list", on: toolsOpen, w: 3.2, fn: () => setToolsOpen((o) => !o) },
  ] as const;

  return (
    <div ref={rootRef} className="flex h-full flex-col bg-term-panel2">
      {/* Marketwatch header: title (your lists) + icons */}
      <div className={`flex shrink-0 items-center bg-term-panel ${compact ? "px-1.5 pb-0.5 pt-1" : "px-3 pb-1 pt-2"}`}>
        <button
          onClick={() => setListsOpen((o) => !o)}
          title="Your lists — switch, rename, add, delete"
          className={`flex min-w-0 items-center gap-1.5 py-1 font-semibold tracking-tight text-term-text ${
            compact ? "pl-1 text-[13px]" : "text-[16px]"
          }`}
        >
          <span className="truncate">Marketwatch</span>
          <span className={`text-xs text-term-dim transition-transform ${listsOpen ? "rotate-180" : ""}`}>▾</span>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {/* a narrow (desktop) pane has no room for all four -- the desktop
              header already carries its own alerts bell */}
          {headBtns.filter((b) => !(compact && b.ic === "bell")).map((b) => (
            <button
              key={b.ic}
              onClick={b.fn}
              title={b.title}
              className={`relative rounded-full ${compact ? "p-1" : "p-2"} ${
                b.on
                  ? "bg-term-accent/15 text-term-accent"
                  : "text-term-text hover:bg-term-border/50 active:bg-term-border/50"
              }`}
            >
              <HeadIcon d={ICON[b.ic]} w={b.w} size={compact ? 16 : 21} />
              {b.ic === "bell" && alertsUnseen > 0 && (
                <span className="absolute -right-0.5 -top-0.5 min-w-[15px] rounded-full bg-down px-1 text-center text-[9px] font-bold leading-4 text-white">
                  {alertsUnseen}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {listsOpen && watchlists && (
        <div className="shrink-0 border-b border-term-border bg-term-panel px-3 pb-1.5">
          {watchlists.lists.map((l, i) => (
            <div key={i} className="flex items-center gap-2 border-t border-term-border/50 py-1.5">
              <button
                onClick={() => {
                  pickList(i);
                  setListsOpen(false);
                }}
                className={`flex min-w-0 flex-1 items-center gap-2 text-left text-sm ${
                  i === active ? "font-semibold text-term-accent" : "text-term-text"
                }`}
              >
                <span className="num w-5 text-center">{i + 1}</span>
                <span className="truncate">{l.name}</span>
                <span className="num text-[10px] text-term-dim">{l.symbols.length}</span>
              </button>
              <button
                onClick={() => {
                  const n = prompt("Rename list", l.name);
                  if (n && n.trim()) wlRename(i, n.trim());
                }}
                title="Rename"
                className="rounded border border-term-dim/70 px-2 py-0.5 text-[11px] text-term-dim hover:text-term-text"
              >
                ✎
              </button>
              {watchlists.lists.length > 1 && (
                <button
                  onClick={() => {
                    if (confirm(`Delete "${l.name}"?`)) wlDeleteList(i);
                  }}
                  title="Delete this list"
                  className="rounded border border-term-dim/70 px-2 py-0.5 text-[11px] text-term-dim hover:text-down"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {watchlists.lists.length < WL_MAX && (
            <button
              onClick={() => {
                wlAddList();
                setListsOpen(false);
              }}
              className="mt-0.5 w-full rounded border border-dashed border-term-dim/70 py-1 text-[11px] text-term-dim hover:text-term-text"
            >
              ＋ New list
            </button>
          )}
        </div>
      )}

      {band}

      {watchlists && (
        <div className="flex shrink-0 border-b border-term-border bg-term-panel">
          {Array.from({ length: Math.min(WL_MAX, Math.max(5, watchlists.lists.length)) }, (_, i) => (
            <button
              key={i}
              onClick={() => pickList(i)}
              title={watchlists.lists[i]?.name ?? `New list ${i + 1}`}
              className={`relative flex-1 ${compact ? "py-1.5 text-[13px]" : "py-2 text-[13px]"} ${
                i === active ? "font-semibold text-term-accent" : "text-term-text hover:text-term-accent"
              }`}
            >
              {i + 1}
              {i === active && (
                <span
                  className={`absolute bottom-0 h-[3px] rounded-t bg-term-accent ${compact ? "inset-x-1.5" : "inset-x-3"}`}
                />
              )}
            </button>
          ))}
        </div>
      )}

      {/* sort bar — behind the sort icon */}
      {sortOpen && (
        <div className="flex flex-wrap items-center gap-1 px-3 py-1.5 text-[10px]">
          <span className="text-term-dim">Sort</span>
          {(
            [
              ["az", "A–Z"],
              ["ltp", "LTP"],
              ["pct", "Chg%"],
              ["chg", "P&L"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setSortPersist(k)}
              className={`rounded border px-1.5 py-0.5 transition ${
                sort.k === k
                  ? "border-term-accent bg-term-accent/15 text-term-text"
                  : "border-term-dim/70 text-term-dim hover:text-term-text"
              }`}
            >
              {label}
              {sort.k === k && <span className="ml-0.5">{sort.dir === 1 ? "▲" : "▼"}</span>}
            </button>
          ))}
          {sort.k !== "none" && (
            <button
              onClick={() => setSortPersist("none" as SortKey)}
              className="text-term-dim hover:text-down"
              title="Clear sort (list order)"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* search (🔍) and tools (⋮) */}
      {(searchOpen || toolsOpen) && (
        <div className="relative border-y border-term-border/60 bg-term-panel/30 px-3 py-2">
          {searchOpen && (
            <form onSubmit={submit} className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-term-dim">
                  ⌕
                </span>
                <input
                  autoFocus
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onFocus={() => results.length && setOpenSearch(true)}
                  onBlur={() => setTimeout(() => setOpenSearch(false), 250)}
                  placeholder="Symbol, or an option: 23400 CE"
                  className="w-full rounded-md border border-term-border bg-term-bg py-1 pl-6 pr-2 text-xs outline-none transition focus:border-term-accent"
                />
              </div>
              <button className="btn shrink-0 px-2" type="submit" title="Add">
                +
              </button>
            </form>
          )}
          {toolsOpen && (
            <div className={searchOpen ? "mt-1.5" : ""}>
              <button
                type="button"
                onClick={() => {
                  setEditing((e) => !e);
                  setToolsOpen(false);
                }}
                className={`w-full rounded border py-1 text-[11px] ${
                  editing ? "border-term-accent text-term-accent" : "border-term-dim/70 text-term-dim hover:text-term-text"
                }`}
                title="Show a remove button on every row"
              >
                ✎ {editing ? "Done editing" : "Edit list (remove symbols)"}
              </button>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => wlAddStrikes(active, 10)}
                  className="flex-1 whitespace-nowrap rounded border border-term-dim/70 px-1 py-0.5 text-[10px] text-term-dim transition hover:border-term-accent hover:text-term-text"
                  title="Add 10 strikes (CE+PE) around ATM for the current symbol"
                >
                  + 10 strikes
                </button>
                <button
                  type="button"
                  onClick={() => wlAddFuture(active)}
                  className="flex-1 whitespace-nowrap rounded border border-term-dim/70 px-1 py-0.5 text-[10px] text-term-dim transition hover:border-term-accent hover:text-term-text"
                  title="Add the futures contract for the current symbol + expiry"
                >
                  + Future
                </button>
                {hasOptions && (
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm("Remove all option strikes from this list?")) wlClear(active, true);
                    }}
                    className="flex-1 whitespace-nowrap rounded border border-term-dim/70 px-1 py-0.5 text-[10px] text-term-dim transition hover:border-down hover:text-down"
                    title="Delete every strike in this list"
                  >
                    ⌫ clear strikes
                  </button>
                )}
              </div>
              <div className="mt-1.5">
                <SelectMenu
                  value=""
                  options={[
                    [presetBusy ? "loading preset…" : "＋ Load a preset watchlist…", ""],
                    ...WL_PRESETS.map(
                      (p) => [`${p.name} · ${p.syms.length}`, p.name] as [string, string]
                    ),
                  ]}
                  onChange={(name) => {
                    const p = WL_PRESETS.find((x) => x.name === name);
                    if (p && !presetBusy) loadPreset(p);
                  }}
                  title="Load a ready-made watchlist into the active list"
                  width={200}
                />
              </div>
            </div>
          )}

          {openSearch && results.length > 0 && (
            <div className="absolute left-3 right-3 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-term-border bg-term-panel shadow-xl">
              {results.map((r) => (
                <button
                  key={r.add}
                  type="button"
                  // pointerdown fires for mouse AND touch, before the input's
                  // blur closes the list — fixes "can't add" on the Fold / phones
                  onPointerDown={(e) => {
                    e.preventDefault();
                    addResult(r.add, r.optionable);
                  }}
                  onClick={(e) => e.preventDefault()}
                  className="flex w-full items-center justify-between border-b border-term-border/40 px-2.5 py-1.5 text-2xs transition last:border-0 hover:bg-term-border"
                >
                  <span className="font-medium text-term-text">{r.label}</span>
                  <span
                    className={`rounded px-1 text-[9px] font-semibold ${
                      r.kind === "vix"
                        ? "bg-amber-500/20 text-amber-400"
                        : r.kind === "option"
                        ? "bg-term-accent/20 text-term-accent"
                        : r.optionable
                        ? "bg-up/20 text-up"
                        : "bg-term-border text-term-dim"
                    }`}
                  >
                    {r.kind === "vix" ? "VIX" : r.kind === "option" ? "OPT" : r.optionable ? "F&O" : "INDEX"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {editing && (
        <div className="flex shrink-0 items-center justify-between gap-2 bg-term-accent/10 px-3 py-1.5 text-xs text-term-text">
          <span>Tap ✕ to remove a symbol</span>
          <button onClick={() => setEditing(false)} className="font-semibold text-term-accent">
            Done
          </button>
        </div>
      )}

      {/* rows */}
      <div className="flex-1 overflow-y-auto">
        {watch.length === 0 ? (
          <div className="p-6 text-center text-[11px] text-term-dim">
            Nothing here yet — tap the search icon above to add an index or stock.
          </div>
        ) : shown.length === 0 ? (
          <div className="p-6 text-center text-[11px] text-term-dim">
            No matching rows — the header All / Indices / Stocks filter is hiding this list.
          </div>
        ) : (
          <div className="flex flex-col">
            {shown.map((w) => (
              <MarketRow key={w.key} w={w} queue={queueSyms} editing={editing} compact={compact} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
