import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, signColor, sk } from "../lib/format";
import { useIsMobile } from "../lib/useIsMobile";
import { SelectMenu } from "./SelectMenu";
import type { WatchQuote } from "../types";

type WlView = "list" | "grid";
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
/** row label: a future's expiry without the year ("NIFTY 30-Sep FUT") so it
 *  isn't cut off on a phone; the full name stays in the tooltip */
const wLabel = (w: WatchQuote) =>
  w.kind === "future" ? `${w.symbol} ${(w.expiry ?? "").replace(/-\d{4}$/, "")} FUT` : wName(w);

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
const wExch = (w: WatchQuote) => {
  const u = w.symbol.toUpperCase();
  if (BSE_SYMS.has(u)) return "BSE";
  if (w.kind === "index" || u === "INDIA VIX" || u === "VIX" || u.includes("NIFTY")) return "INDEX";
  return "NSE";
};
/** "24-Sep-2026" -> "24 SEP" */
const shortExp = (e?: string) => {
  const m = /^(\d{1,2})-([A-Za-z]{3})/.exec(e ?? "");
  return m ? `${m[1]} ${m[2].toUpperCase()}` : e ?? "";
};
/** broker-style full contract name (phone rows): "SENSEX 24 SEP 74500 CE", "NIFTY 30 SEP FUT" */
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

/** broker-style quote row: name + exchange on the left, LTP with its change
 *  beside it in brackets on the right, divider between rows. `stacked` (the
 *  narrow grid cells) puts the change under the price instead. Tapping the
 *  row opens the chart for that symbol. No order buttons here, by request. */
function QuoteRow({ w, queue, stacked = false }: { w: WatchQuote; queue: string[]; stacked?: boolean }) {
  const {
    symbol, selectSymbol, selectExpiry, setChartInstrument, chartInstrument, setView, removeWatch,
    setChartQueue,
  } = useStore();
  const on = w.kind === "option" ? chartInstrument === w.key : w.symbol === symbol;
  const px = wPx(w);
  const pct = wPct(w);
  const chg = wAbsChg(w);
  const up = (pct ?? 0) >= 0;
  const col = pct == null ? "text-term-text" : up ? "text-up" : "text-down";
  const sg = (v: number) => (v >= 0 ? "+" : "−");
  return (
    <div
      className={`group relative flex items-center gap-2 border-b border-term-border/60 px-3 py-2 transition-colors ${
        on ? "bg-term-accent/[0.07]" : "hover:bg-term-panel/60"
      }`}
    >
      {on && <span className="absolute inset-y-0 left-0 w-[3px] bg-term-accent" />}
      <button
        onClick={() => {
          setChartQueue("Watchlist", queue);
          selectSymbol(w.symbol, true);
          if (w.kind === "option") {
            if (w.expiry) selectExpiry(w.expiry);
            setChartInstrument(w.key);
          }
          setView("chart");
        }}
        title={`Chart ${wName(w)}`}
        className="min-w-0 flex-1 text-left"
      >
        <div className="truncate text-sm font-semibold text-term-text">{wLabel(w)}</div>
        {/* option rows sit under a "SENSEX · 24-Sep" header already — the
            exchange tag under every strike only cost a line */}
        {w.kind !== "option" && (
          <div className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-500">
            {wExch(w)}
          </div>
        )}
      </button>
      {stacked ? (
        <div className="flex shrink-0 flex-col items-end leading-tight">
          <span className={`num text-[15px] font-semibold tabular-nums ${col}`}>
            {px != null ? nf(px) : "–"}
          </span>
          {(chg != null || pct != null) && (
            <span className={`num mt-0.5 flex items-center gap-1 text-xs tabular-nums ${col}`}>
              <span>{up ? "↑" : "↓"}</span>
              {chg != null && <span>{nf(Math.abs(chg))}</span>}
              {pct != null && <span>({nf(Math.abs(pct), 2)}%)</span>}
            </span>
          )}
        </div>
      ) : (
        <div className="flex shrink-0 items-baseline gap-1 leading-tight">
          <span className={`num text-[15px] font-semibold tabular-nums ${col}`}>
            {px != null ? nf(px) : "–"}
          </span>
          {(chg != null || pct != null) && (
            <span className={`num whitespace-nowrap text-xs tabular-nums ${col}`}>
              (
              {[
                chg != null ? `${sg(chg)}${nf(Math.abs(chg))}` : null,
                pct != null ? `${sg(pct)}${nf(Math.abs(pct), 2)}%` : null,
              ]
                .filter(Boolean)
                .join(" ")}
              )
            </span>
          )}
        </div>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          removeWatch(w.key);
        }}
        title="Remove from watchlist"
        className="shrink-0 rounded px-1 text-[11px] leading-none text-term-dim opacity-40 transition hover:text-down group-hover:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}

/** phone row, laid out like the Flattrade / Kite marketwatch: full contract
 *  name over its segment on the left, ▲/▼ LTP over the change on the right.
 *  No buttons -- tap charts it; the ⋮ menu's "Edit list" shows a remove ✕. */
function MobileQuoteRow({ w, queue, editing }: { w: WatchQuote; queue: string[]; editing: boolean }) {
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
  return (
    <div className={`flex items-center border-b border-term-border/70 ${on ? "bg-term-accent/[0.07]" : ""}`}>
      <button
        onClick={() => {
          setChartQueue("Watchlist", queue);
          selectSymbol(w.symbol, true);
          if (w.kind === "option") {
            if (w.expiry) selectExpiry(w.expiry);
            setChartInstrument(w.key);
          }
          setView("chart");
        }}
        title={`Chart ${wName(w)}`}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left active:bg-term-border/40"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-term-text">{wFull(w)}</span>
          <span className="mt-1 block text-xs text-term-dim">{wSeg(w)}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end">
          <span className={`num flex items-center gap-1.5 text-[15px] font-medium tabular-nums ${col}`}>
            {has && <span className="text-[10px] leading-none">{up ? "▲" : "▼"}</span>}
            {px != null ? nf(px) : "–"}
          </span>
          <span className="num mt-1 text-xs tabular-nums text-term-dim">
            {has ? `${nf(chg ?? 0)} (${nf(pct ?? 0)}%)` : " "}
          </span>
        </span>
      </button>
      {editing && (
        <button
          onClick={() => removeWatch(w.key)}
          title="Remove from this list"
          className="mr-3 shrink-0 rounded-full border border-down/50 bg-down/10 px-2.5 py-1 text-xs font-semibold text-down"
        >
          ✕
        </button>
      )}
    </div>
  );
}

/** 20px line icons for the phone Marketwatch header */
function HeadIcon({ d, w = 1.9 }: { d: string; w?: number }) {
  return (
    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth={w}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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

type StrikePair = {
  gkey: string;
  symbol: string;
  expiry?: string;
  strike?: number;
  ce?: WatchQuote;
  pe?: WatchQuote;
};

/** `band` (phone): the index quotes, shown under the Marketwatch header */
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
  const isMobile = useIsMobile();
  const [input, setInput] = useState("");
  const [renaming, setRenaming] = useState<number | null>(null);
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.symbolSearch>>["results"]>([]);
  const [openSearch, setOpenSearch] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false); // phone: strike / future / preset tools folded away
  // phone Marketwatch header: each icon opens its panel under the header
  const [searchOpen, setSearchOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [listsOpen, setListsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const openNotif = useStore((s) => s.openNotif);
  const alertsUnseen = useStore(
    (s) =>
      Math.max(0, s.alerts.length - s.alertsSeen) + Math.max(0, s.unusual.length - s.unusualSeen)
  );
  const [view, setView] = useState<WlView>(() => {
    try {
      return (localStorage.getItem("wlView") as WlView) || "list";
    } catch {
      return "list";
    }
  });
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

  const setViewPersist = (v: WlView) => {
    setView(v);
    try {
      localStorage.setItem("wlView", v);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    const q = input.trim();
    if (q.length < 1) {
      setResults([]);
      return;
    }
    searchTimer.current = window.setTimeout(() => {
      api.symbolSearch(q).then((d) => {
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
    if (!symClassOk(add)) setSymClass("all");
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

  const shown = sortWatch(watch, sort).filter((w) => symClassOk(w.symbol));
  const nonOpts = shown.filter((w) => w.kind !== "option");
  const optRows = shown.filter((w) => w.kind === "option");

  // pair CE + PE of the same (symbol, expiry, strike) into one row
  const pairMap = new Map<string, StrikePair>();
  for (const w of optRows) {
    const gkey = `${w.symbol}|${w.expiry ?? ""}|${w.strike ?? ""}`;
    let pr = pairMap.get(gkey);
    if (!pr) {
      pr = { gkey, symbol: w.symbol, expiry: w.expiry, strike: w.strike };
      pairMap.set(gkey, pr);
    }
    if (w.optionType === "PE") pr.pe = w;
    else pr.ce = w;
  }
  const pairs = [...pairMap.values()];
  if (sort.k === "none") {
    pairs.sort(
      (a, b) =>
        a.symbol.localeCompare(b.symbol) ||
        String(a.expiry).localeCompare(String(b.expiry)) ||
        (a.strike ?? 0) - (b.strike ?? 0)
    );
  }

  // group headers (symbol · expiry) between strike rows
  const strikeBlocks: { head: string; items: StrikePair[] }[] = [];
  for (const pr of pairs) {
    const head = `${pr.symbol}${pr.expiry ? ` · ${pr.expiry}` : ""}`;
    const last = strikeBlocks[strikeBlocks.length - 1];
    if (last && last.head === head) last.items.push(pr);
    else strikeBlocks.push({ head, items: [pr] });
  }

  // Next / Prev on the chart follow the underlyings in the order shown here
  const queueSyms = nonOpts.filter((w) => w.kind !== "future").map((w) => w.symbol);
  const rowFor = (w: WatchQuote, stacked = false) => (
    <QuoteRow key={w.key} w={w} queue={queueSyms} stacked={stacked} />
  );

  const optionSection = (
    <div className="flex flex-col gap-2">
      {strikeBlocks.map((blk) => (
        <div key={blk.head} className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 px-1 pt-0.5 text-[9px] font-semibold uppercase tracking-wide text-term-dim">
            <span className="h-px flex-1 bg-term-border/60" />
            {blk.head}
            <span className="h-px flex-1 bg-term-border/60" />
          </div>
          {blk.items.map((p) => (
            <div key={p.gkey} className="flex flex-col gap-0.5">
              {p.ce && rowFor(p.ce)}
              {p.pe && rowFor(p.pe)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );

  const counts = watch.reduce(
    (a, w) => {
      if (w.kind === "option") a.opt++;
      else a.sym++;
      return a;
    },
    { sym: 0, opt: 0 }
  );

  const viewToggle = (
    <div className="segx rounded-md">
      {(["list", "grid"] as const).map((v) => (
        <button
          key={v}
          onClick={() => setViewPersist(v)}
          title={`${v} view`}
          className={`px-2 py-1 text-[11px] transition ${
            view === v ? "bg-term-accent text-white" : "text-term-dim hover:bg-term-border"
          }`}
        >
          {v === "list" ? "☰" : "▦"}
        </button>
      ))}
    </div>
  );

  // phone tabs are always numbered 1-5 like a broker's marketwatch; tapping a
  // number with no list behind it yet creates the missing lists (the server keeps 3)
  const pickList = async (i: number) => {
    if (!watchlists) return;
    let n = watchlists.lists.length;
    while (n <= i && n < 8) {
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
    <div className="flex h-full flex-col bg-term-panel2">
      {/* phone: Flattrade-style Marketwatch -- title (your lists) + icons,
          the index band, numbered list tabs; search / sort / tools fold away */}
      {isMobile && (
        <>
          <div className="flex shrink-0 items-center bg-term-panel px-3 pb-1 pt-2">
            <button
              onClick={() => setListsOpen((o) => !o)}
              title="Your lists — switch, rename, delete"
              className="flex items-center gap-1.5 py-1 text-[19px] font-semibold tracking-tight text-term-text"
            >
              Marketwatch
              <span className={`text-xs text-term-dim transition-transform ${listsOpen ? "rotate-180" : ""}`}>
                ▾
              </span>
            </button>
            <div className="ml-auto flex items-center gap-0.5">
              {headBtns.map((b) => (
                <button
                  key={b.ic}
                  onClick={b.fn}
                  title={b.title}
                  className={`relative rounded-full p-2 ${
                    b.on ? "bg-term-accent/15 text-term-accent" : "text-term-text active:bg-term-border/50"
                  }`}
                >
                  <HeadIcon d={ICON[b.ic]} w={b.w} />
                  {b.ic === "bell" && alertsUnseen > 0 && (
                    <span className="absolute right-0.5 top-0.5 min-w-[15px] rounded-full bg-down px-1 text-center text-[9px] font-bold leading-4 text-white">
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
                    className="rounded border border-term-dim/70 px-2 py-0.5 text-[11px] text-term-dim"
                  >
                    ✎
                  </button>
                  {watchlists.lists.length > 1 && (
                    <button
                      onClick={() => {
                        if (confirm(`Delete "${l.name}"?`)) wlDeleteList(i);
                      }}
                      title="Delete this list"
                      className="rounded border border-term-dim/70 px-2 py-0.5 text-[11px] text-term-dim"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {band}
          {watchlists && (
            <div className="flex shrink-0 border-b border-term-border bg-term-panel">
              {Array.from({ length: Math.min(8, Math.max(5, watchlists.lists.length)) }, (_, i) => (
                <button
                  key={i}
                  onClick={() => pickList(i)}
                  title={watchlists.lists[i]?.name ?? `New list ${i + 1}`}
                  className={`relative flex-1 py-2.5 text-[15px] ${
                    i === active ? "font-semibold text-term-accent" : "text-term-text"
                  }`}
                >
                  {i + 1}
                  {i === active && (
                    <span className="absolute inset-x-3 bottom-0 h-[3px] rounded-t bg-term-accent" />
                  )}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* header (desktop) */}
      {!isMobile && (
        <div className="flex items-center justify-between px-3 pb-1.5 pt-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold tracking-tight text-term-text">Watchlist</span>
            <span className="text-[9px] text-term-dim">
              {counts.sym} sym · {counts.opt} opt
            </span>
          </div>
          {viewToggle}
        </div>
      )}

      {/* sort bar (phone: behind the sort icon) */}
      {(!isMobile || sortOpen) && (
      <div className={`flex items-center gap-1 px-3 pb-1.5 text-[10px] ${isMobile ? "pt-1.5" : ""}`}>
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
            className={`${isMobile ? "" : "ml-auto"} text-term-dim hover:text-down`}
            title="Clear sort (list order)"
          >
            ✕
          </button>
        )}
      </div>
      )}

      {/* list tabs — pills (phone: the numbered tabs above) */}
      {watchlists && !isMobile && (
        <div className="flex items-center gap-1 overflow-x-auto px-3 pb-2">
          {watchlists.lists.map((l, i) => {
            const on = i === active;
            return (
              <div key={i} className="group/tab relative shrink-0">
                {renaming === i ? (
                  <input
                    autoFocus
                    defaultValue={l.name}
                    onBlur={(e) => {
                      wlRename(i, e.target.value);
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    className="w-20 rounded-full border border-term-accent bg-term-bg px-2 py-0.5 text-center text-[11px] text-term-text outline-none"
                  />
                ) : (
                  <button
                    onClick={() => wlSetActive(i)}
                    onDoubleClick={() => setRenaming(i)}
                    title="Double-click to rename"
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${
                      on
                        ? "border-term-accent bg-term-accent text-white"
                        : "border-term-dim/70 bg-term-bg text-term-dim hover:text-term-text"
                    }`}
                  >
                    {l.name}
                  </button>
                )}
                {watchlists.lists.length > 1 && renaming !== i && (
                  <button
                    onClick={() => {
                      if (confirm(`Delete "${l.name}"?`)) wlDeleteList(i);
                    }}
                    title="Delete this list"
                    className="absolute -right-1 -top-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-down text-[9px] leading-none text-white group-hover/tab:flex"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          {watchlists.lists.length < 8 && (
            <button
              onClick={wlAddList}
              title="Add a watchlist"
              className="shrink-0 rounded-full border border-dashed border-term-dim/70 px-2 py-0.5 text-[11px] text-term-dim hover:border-term-accent hover:text-term-text"
            >
              ＋
            </button>
          )}
        </div>
      )}

      {/* search + actions (phone: search behind 🔍, tools behind ⋮) */}
      {(!isMobile || searchOpen || toolsOpen) && (
      <div className="relative border-y border-term-border/60 bg-term-panel/30 px-3 py-2">
        {(!isMobile || searchOpen) && (
        <form onSubmit={submit} className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-term-dim">
              ⌕
            </span>
            <input
              autoFocus={isMobile}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => results.length && setOpenSearch(true)}
              onBlur={() => setTimeout(() => setOpenSearch(false), 250)}
              placeholder="Search index / VIX / stock…"
              className="w-full rounded-md border border-term-border bg-term-bg py-1 pl-6 pr-2 text-xs outline-none transition focus:border-term-accent"
            />
          </div>
          <button className="btn shrink-0 px-2" type="submit" title="Add">
            +
          </button>
        </form>
        )}
        {(!isMobile || toolsOpen) && (
        <>
        {isMobile && (
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => {
                setEditing((e) => !e);
                setToolsOpen(false);
              }}
              className={`flex-1 rounded border py-1 text-[11px] ${
                editing ? "border-term-accent text-term-accent" : "border-term-dim/70 text-term-dim"
              }`}
              title="Show a remove button on every row"
            >
              ✎ {editing ? "Done editing" : "Edit list (remove symbols)"}
            </button>
          </div>
        )}
        <div className="mt-1.5 flex gap-1">
          <button
            type="button"
            onClick={() => wlAddStrikes(active, 10)}
            className="flex-1 rounded border border-term-dim/70 py-0.5 text-[10px] text-term-dim transition hover:border-term-accent hover:text-term-text"
            title="Add 10 strikes (CE+PE) around ATM for the current symbol"
          >
            + 10 strikes
          </button>
          <button
            type="button"
            onClick={() => wlAddFuture(active)}
            className="flex-1 rounded border border-term-dim/70 py-0.5 text-[10px] text-term-dim transition hover:border-term-accent hover:text-term-text"
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
              className="flex-1 rounded border border-term-dim/70 py-0.5 text-[10px] text-term-dim transition hover:border-down hover:text-down"
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
            title="Load a ready-made watchlist into a new list"
            width={200}
          />
        </div>
        </>
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
                      : r.optionable
                      ? "bg-up/20 text-up"
                      : "bg-term-border text-term-dim"
                  }`}
                >
                  {r.kind === "vix" ? "VIX" : r.optionable ? "F&O" : "INDEX"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      )}

      {isMobile && editing && (
        <div className="flex shrink-0 items-center justify-between bg-term-accent/10 px-4 py-1.5 text-xs text-term-text">
          <span>Tap ✕ to remove a symbol from this list</span>
          <button onClick={() => setEditing(false)} className="font-semibold text-term-accent">
            Done
          </button>
        </div>
      )}

      {/* rows */}
      <div className="flex-1 overflow-y-auto">
        {watch.length === 0 ? (
          <div className="p-6 text-center text-[11px] text-term-dim">
            Nothing here yet — search above to add an index or stock.
          </div>
        ) : shown.length === 0 ? (
          <div className="p-6 text-center text-[11px] text-term-dim">
            No matching rows — the header All / Indices / Stocks filter is hiding this list.
          </div>
        ) : isMobile ? (
          // phone: one flat list in your order (or the chosen sort), full
          // contract names, no group headers -- like the broker's marketwatch
          <div className="flex flex-col">
            {shown.map((w) => (
              <MobileQuoteRow key={w.key} w={w} queue={queueSyms} editing={editing} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col">
            {nonOpts.length > 0 &&
              (view === "grid" ? (
                <div
                  className="grid gap-1 p-2"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}
                >
                  {nonOpts.map((w) => rowFor(w, true))}
                </div>
              ) : (
                <div className="flex flex-col">{nonOpts.map((w) => rowFor(w))}</div>
              ))}
            {strikeBlocks.length > 0 && <div className="p-2">{optionSection}</div>}
          </div>
        )}
      </div>

      {!isMobile && (
        <div className="border-t border-term-border bg-term-panel/30 px-3 py-1.5 text-[9px] leading-tight text-term-dim">
          tap a symbol or option to chart it
        </div>
      )}
    </div>
  );
}
