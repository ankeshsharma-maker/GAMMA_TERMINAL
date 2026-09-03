import { useEffect, useRef, useState, type FormEvent } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, signColor, sk } from "../lib/format";
import type { WatchQuote } from "../types";

type WlView = "list" | "grid";

/** remove button */
function DelBtn({ onClick, title }: { onClick: (e: React.MouseEvent) => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="shrink-0 rounded border border-term-border bg-term-bg/60 px-1 py-0.5 text-[10px] leading-none text-term-dim transition hover:border-down hover:bg-down hover:text-white"
    >
      ✕
    </button>
  );
}

/** a name/label that navigates — styled as a button so it's obviously clickable */
function NavBtn({
  onClick,
  title,
  active,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex min-w-0 flex-1 items-center gap-1 rounded border px-1.5 py-1 text-left transition ${
        active
          ? "border-term-accent/60 bg-term-accent/10"
          : "border-term-border/50 bg-term-bg/40 hover:border-term-accent/60 hover:bg-term-border/40"
      }`}
    >
      <span className="min-w-0 flex-1">{children}</span>
      <span className="shrink-0 text-[10px] text-term-dim transition group-hover:text-term-accent">›</span>
    </button>
  );
}

/** price + % change, inline */
function Px({ px, pct }: { px: number | null | undefined; pct: number | null | undefined }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1 leading-tight">
      <span className="num font-medium tabular-nums">{px != null ? nf(px) : "–"}</span>
      {pct != null && (
        <span className={`num text-[9px] tabular-nums ${signColor(pct)}`}>
          {pct >= 0 ? "▲" : "▼"}
          {nf(Math.abs(pct), 2)}%
        </span>
      )}
    </span>
  );
}

// compact one-line row: [accent] [name/label button] [price ▲%] [✕]
const ROW =
  "group relative flex items-center gap-1.5 rounded-md border bg-term-panel/50 px-2 py-1 transition-colors hover:border-term-border hover:bg-term-panel";

function IndexRow({ w }: { w: WatchQuote }) {
  const removeWatch = useStore((s) => s.removeWatch);
  return (
    <div className={`${ROW} border-term-border/50`}>
      <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-xs font-semibold">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-term-dim" />
        <span className="truncate">{w.symbol}</span>
        <span className="shrink-0 rounded bg-term-border px-1 text-[8px] font-medium text-term-dim">IDX</span>
      </span>
      <Px px={w.spot} pct={w.liveChgPct} />
      <DelBtn onClick={() => removeWatch(w.key)} title="Remove" />
    </div>
  );
}

function SymbolRow({ w }: { w: WatchQuote }) {
  const { symbol, selectSymbol, removeWatch } = useStore();
  const on = w.symbol === symbol;
  const px = w.liveSpot ?? w.spot;
  return (
    <div className={`${ROW} ${on ? "border-term-accent/70 bg-term-accent/[0.08]" : "border-term-border/50"}`}>
      <span className={`absolute inset-y-1 left-0 w-[3px] rounded-full ${on ? "bg-term-accent" : "bg-transparent"}`} />
      <NavBtn onClick={() => selectSymbol(w.symbol)} title={`Open ${w.symbol} option chain`} active={on}>
        <span className={`truncate text-xs font-semibold ${on ? "text-term-accent" : ""}`}>{w.symbol}</span>
      </NavBtn>
      <Px px={px} pct={w.liveChgPct} />
      <DelBtn
        onClick={(e) => {
          e.stopPropagation();
          removeWatch(w.key);
        }}
        title="Remove from watchlist"
      />
    </div>
  );
}

function OptionRow({ w }: { w: WatchQuote }) {
  const { selectSymbol, selectExpiry, removeWatch, setChartInstrument, chartInstrument } = useStore();
  const charted = chartInstrument === w.key;
  const ce = w.optionType === "CE";
  const otChip = ce ? "bg-up/15 text-up" : "bg-down/15 text-down";

  const openChart = () => {
    selectSymbol(w.symbol);
    if (w.expiry) selectExpiry(w.expiry);
    setChartInstrument(w.key);
  };

  return (
    <div
      className={`${ROW} ${charted ? "border-term-accent/70 bg-term-accent/[0.08]" : "border-term-border/50"}`}
    >
      <span
        className={`absolute inset-y-1 left-0 w-[3px] rounded-full ${
          charted ? "bg-term-accent" : ce ? "bg-up/40" : "bg-down/40"
        }`}
      />
      <NavBtn onClick={openChart} title={`Chart ${w.symbol} ${sk(w.strike)} ${w.optionType}`} active={charted}>
        <span className="flex items-center gap-1 truncate text-xs font-semibold">
          <span className={`shrink-0 rounded px-1 text-[9px] font-bold ${otChip}`}>{w.optionType}</span>
          <span className="num truncate">{sk(w.strike)}</span>
        </span>
      </NavBtn>
      <Px px={w.ltp} pct={w.chgPct} />
      <DelBtn onClick={() => removeWatch(w.key)} title="Delete strike" />
    </div>
  );
}

export function Watchlist() {
  const {
    watch,
    watchlists,
    addWatch,
    wlSetActive,
    wlRename,
    wlAddStrikes,
    wlClear,
    selectSymbol,
    scalpLots,
  } = useStore();
  const wlAdd = useStore((s) => s.wlAdd);
  const wlAddList = useStore((s) => s.wlAddList);
  const wlDeleteList = useStore((s) => s.wlDeleteList);
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
  const hasOptions = watch.some((w) => w.kind === "option");
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
    selectSymbol(v);
  };

  const rowFor = (w: WatchQuote) =>
    w.kind === "option" ? (
      <OptionRow key={w.key} w={w} />
    ) : w.kind === "index" ? (
      <IndexRow key={w.key} w={w} />
    ) : (
      <SymbolRow key={w.key} w={w} />
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
        <div className="flex overflow-hidden rounded-md border border-term-border">
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
                        : "border-term-border bg-term-bg text-term-dim hover:text-term-text"
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
              className="shrink-0 rounded-full border border-dashed border-term-border px-2 py-0.5 text-[11px] text-term-dim hover:border-term-accent hover:text-term-text"
            >
              ＋
            </button>
          )}
        </div>
      )}

      {/* search + actions */}
      <div className="relative border-y border-term-border/60 bg-term-panel/30 px-3 py-2">
        <form onSubmit={submit} className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-term-dim">
              ⌕
            </span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => results.length && setOpenSearch(true)}
              onBlur={() => setTimeout(() => setOpenSearch(false), 150)}
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
            className="flex-1 rounded border border-term-border py-0.5 text-[10px] text-term-dim transition hover:border-term-accent hover:text-term-text"
            title="Add 10 strikes (CE+PE) around ATM for the current symbol"
          >
            + 10 strikes
          </button>
          {hasOptions && (
            <button
              type="button"
              onClick={() => {
                if (confirm("Remove all option strikes from this list?")) wlClear(active, true);
              }}
              className="flex-1 rounded border border-term-border py-0.5 text-[10px] text-term-dim transition hover:border-down hover:text-down"
              title="Delete every strike in this list"
            >
              ⌫ clear strikes
            </button>
          )}
        </div>

        {openSearch && results.length > 0 && (
          <div className="absolute left-3 right-3 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-term-border bg-term-panel shadow-xl">
            {results.map((r) => (
              <button
                key={r.add}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addResult(r.add, r.optionable)}
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
        ) : view === "grid" ? (
          <div
            className="grid gap-1 p-2"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}
          >
            {watch.map(rowFor)}
          </div>
        ) : (
          <div className="flex flex-col gap-1 p-2">{watch.map(rowFor)}</div>
        )}
      </div>

      <div className="border-t border-term-border bg-term-panel/30 px-3 py-1.5 text-[9px] leading-tight text-term-dim">
        1-click = {scalpLots} lot · tap a symbol to open its chain · tap an option to chart it
      </div>
    </div>
  );
}
