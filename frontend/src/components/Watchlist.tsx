import { useEffect, useRef, useState, type FormEvent } from "react";
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
const wAbsChg = (w: WatchQuote) => {
  if (w.variation != null) return w.variation;
  const p = wPx(w);
  const c = wPct(w);
  return p != null && c != null ? (p * c) / 100 : null;
};

/** broker-style quote row: name + exchange on the left, LTP + change on the
 *  right, divider between rows. Tapping the row opens the chart for that symbol. */
function QuoteRow({ w }: { w: WatchQuote }) {
  const {
    symbol, selectSymbol, selectExpiry, setChartInstrument, chartInstrument, setView, removeWatch,
    quickTradeFuture, scalpLots,
  } = useStore();
  const on = w.kind === "option" ? chartInstrument === w.key : w.symbol === symbol;
  const px = wPx(w);
  const pct = wPct(w);
  const chg = wAbsChg(w);
  const up = (pct ?? 0) >= 0;
  const col = pct == null ? "text-term-text" : up ? "text-up" : "text-down";
  return (
    <div
      className={`group relative flex items-center gap-2 border-b border-term-border/60 px-3 py-2 transition-colors ${
        on ? "bg-term-accent/[0.07]" : "hover:bg-term-panel/60"
      }`}
    >
      {on && <span className="absolute inset-y-0 left-0 w-[3px] bg-term-accent" />}
      <button
        onClick={() => {
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
        <div className="truncate text-sm font-semibold text-term-text">{wName(w)}</div>
        <div className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-500">
          {wExch(w)}
        </div>
      </button>
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
      {w.kind === "future" && w.expiry && (
        <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => quickTradeFuture(w.symbol, w.expiry!, "BUY", scalpLots)}
            title={`Buy ${scalpLots} lot(s) of ${wName(w)}`}
            className="rounded border border-up/40 bg-up/10 px-1.5 py-0.5 text-[10px] font-semibold text-up transition hover:bg-up/20"
          >
            Buy
          </button>
          <button
            onClick={() => quickTradeFuture(w.symbol, w.expiry!, "SELL", scalpLots)}
            title={`Sell ${scalpLots} lot(s) of ${wName(w)}`}
            className="rounded border border-down/40 bg-down/10 px-1.5 py-0.5 text-[10px] font-semibold text-down transition hover:bg-down/20"
          >
            Sell
          </button>
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

type StrikePair = {
  gkey: string;
  symbol: string;
  expiry?: string;
  strike?: number;
  ce?: WatchQuote;
  pe?: WatchQuote;
};

export function Watchlist() {
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
    scalpLots,
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

  const rowFor = (w: WatchQuote) => <QuoteRow key={w.key} w={w} />;

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

  return (
    <div className="flex h-full flex-col bg-term-panel2">
      {/* header */}
      <div className="flex items-center justify-between px-3 pb-1.5 pt-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold tracking-tight text-term-text">Watchlist</span>
          <span className="text-[9px] text-term-dim">
            {counts.sym} sym · {counts.opt} opt
          </span>
        </div>
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
      </div>

      {/* sort bar */}
      <div className="flex items-center gap-1 px-3 pb-1.5 text-[10px]">
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
            className="ml-auto text-term-dim hover:text-down"
            title="Clear sort (list order)"
          >
            ✕
          </button>
        )}
      </div>

      {/* list tabs — pills */}
      {watchlists && (
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

      {/* search + actions — on mobile this jumps to the top, right under the index band */}
      <div
        className={`relative border-y border-term-border/60 bg-term-panel/30 px-3 py-2 ${
          isMobile ? "order-first" : ""
        }`}
      >
        <form onSubmit={submit} className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-term-dim">
              ⌕
            </span>
            <input
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
        ) : (
          <div className="flex flex-col">
            {nonOpts.length > 0 &&
              (view === "grid" ? (
                <div
                  className="grid gap-1 p-2"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}
                >
                  {nonOpts.map(rowFor)}
                </div>
              ) : (
                <div className="flex flex-col">{nonOpts.map(rowFor)}</div>
              ))}
            {strikeBlocks.length > 0 && <div className="p-2">{optionSection}</div>}
          </div>
        )}
      </div>

      <div className="border-t border-term-border bg-term-panel/30 px-3 py-1.5 text-[9px] leading-tight text-term-dim">
        1-click = {scalpLots} lot · tap a symbol or option to chart it
      </div>
    </div>
  );
}
