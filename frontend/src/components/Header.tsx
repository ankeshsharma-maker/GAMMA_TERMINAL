import { useStore } from "../store";
import { compact, nf, ago, sk, signColor, px } from "../lib/format";
import { ivRegime } from "../lib/iv";
import { api } from "../lib/api";
import { lockNow } from "../lib/auth";
import { useLiveMtm } from "../lib/useLiveMtm";
import { ConnBadge } from "./ConnBadge";
import { LogoWordmark } from "./Logo";
import { Settings } from "./Settings";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

function Stat({ label, value, cls = "" }: { label: string; value: ReactNode; cls?: string }) {
  return (
    <div className="flex flex-col justify-center border-l border-term-border/60 px-2 leading-tight first:border-l-0">
      <span className="text-[10px] uppercase tracking-wide text-term-dim">{label}</span>
      <span className={`num text-sm ${cls}`}>{value}</span>
    </div>
  );
}

/* ---- tap-to-hide money values (per-key, persisted in localStorage) ---- */
const HIDE_LS = "hdr.hideVals";
const readHidden = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(HIDE_LS) || "{}");
  } catch {
    return {};
  }
};
function useHidden(key: string, startHidden = false): [boolean, () => void] {
  const [map, setMap] = useState<Record<string, boolean>>(readHidden);
  useEffect(() => {
    const h = () => setMap(readHidden());
    window.addEventListener("hdr-hide", h);
    window.addEventListener("storage", h);
    return () => {
      window.removeEventListener("hdr-hide", h);
      window.removeEventListener("storage", h);
    };
  }, []);
  const hidden = key in map ? !!map[key] : startHidden;
  const toggle = () => {
    const cur = readHidden();
    const curVal = key in cur ? !!cur[key] : startHidden;
    const next = { ...cur, [key]: !curVal };
    try {
      localStorage.setItem(HIDE_LS, JSON.stringify(next));
    } catch {}
    window.dispatchEvent(new Event("hdr-hide"));
  };
  return [hidden, toggle];
}

/** Money figure that hides itself (₹ ••••••) when tapped; state persists.
 *  Margin figures start hidden (privacy) until the user taps to reveal. */
function HideNum({ k, children }: { k: string; children: ReactNode }) {
  const [hidden, toggle] = useHidden(k, true);
  return (
    <button
      type="button"
      onClick={toggle}
      title={hidden ? "tap to reveal" : "tap to hide"}
      className="cursor-pointer border-b border-dashed border-term-dim/50 leading-none hover:border-term-accent"
    >
      {hidden ? "₹ ••••••" : children}
    </button>
  );
}

function ViewToggle() {
  const { view, setView } = useStore();
  return (
    <div className="flex flex-wrap gap-1 text-2xs">
      {(
        [
          ["scrip", "OI"],
          ["trendingoi", "Trend OI"],
          ["scanner", "Scan"],
          ["chart", "Chart"],
          ["builder", "Build"],
          ["positions", "Positions"],
          ["scalper", "Scalp"],
          ["auto", "Auto"],
          ["funds", "Funds"],
        ] as const
      ).map(([v, label]) => (
        <button
          key={v}
          onClick={() => setView(v)}
          className={`rounded border px-1.5 py-1 font-semibold uppercase tracking-normal transition-colors ${
            view === v
              ? "border-term-accent bg-term-accent text-white"
              : "border-term-border text-term-dim hover:bg-term-border hover:text-term-text"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const HDR_LABEL: Record<string, string> = { NIFTY: "NIFTY50", BANKNIFTY: "BANKNIFTY" };
const HDR_DEFAULT = ["NIFTY", "BANKNIFTY", "INDIA VIX"];
const HDR_LS_KEY = "hdrIndices";
const HDR_MAX = 6;
// indices kept out of the header ticker even if pinned or on a watchlist
const HDR_TICKER_HIDE = new Set(["BANKEX", "MIDCPNIFTY"]);

function loadHdrSymbols(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HDR_LS_KEY) || "null");
    return Array.isArray(raw) && raw.length ? raw : HDR_DEFAULT;
  } catch {
    return HDR_DEFAULT;
  }
}

export function HeaderIndices({ max = 12 }: { max?: number } = {}) {
  const [pinned, setPinned] = useState<string[]>(loadHdrSymbols);
  const watch = useStore((s) => s.watch);
  const indexSet = useStore((s) => s.indexSet);
  const [rows, setRows] = useState<
    { symbol: string; spot: number | null; chgPct: number | null; chgPts?: number | null }[]
  >([]);
  const [options, setOptions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  const isIndex = useMemo(() => {
    const set = new Set(indexSet.map((s) => s.toUpperCase()));
    return (s: string) => {
      const u = s.toUpperCase();
      return u === "INDIA VIX" || u === "VIX" || u.includes("NIFTY") || set.has(u);
    };
  }, [indexSet]);

  // the ticker shows INDICES ONLY — pinned indices + any index on the watchlist
  const wlSyms = useMemo(
    () => [
      ...new Set(
        watch
          .filter((w) => w.kind !== "option" && isIndex(w.symbol))
          .map((w) => w.symbol.toUpperCase())
      ),
    ],
    [watch, isIndex]
  );
  const symbols = useMemo(
    () =>
      [...new Set([...pinned.filter(isIndex), ...wlSyms])]
        .filter((s) => !HDR_TICKER_HIDE.has(s.toUpperCase()))
        .slice(0, max),
    [pinned, wlSyms, isIndex, max]
  );
  // per-symbol change straight off the watchlist store, as a fallback for
  // anything the header endpoint can't price a change for (stocks when the
  // broker feed is quiet)
  const wlChg = useMemo(() => {
    const m: Record<string, { pts: number | null; pct: number | null }> = {};
    for (const w of watch) {
      if (w.kind === "option") continue;
      m[w.symbol.toUpperCase()] = {
        pts: w.variation ?? null,
        pct: w.liveChgPct ?? w.chgPct ?? null,
      };
    }
    return m;
  }, [watch]);

  useEffect(() => {
    api
      .indicesHeaderOptions()
      .then(
        (d) => setOptions(d.options.filter((o) => !HDR_TICKER_HIDE.has(o.toUpperCase()))),
        () => {}
      );
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.indicesHeader(symbols).then((d) => alive && setRows(d.indices), () => {});
    load();
    const t = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [symbols.join(",")]);

  const setAndPersist = (next: string[]) => {
    setPinned(next);
    try {
      localStorage.setItem(HDR_LS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const toggle = (sym: string) => {
    const has = pinned.includes(sym);
    if (has) setAndPersist(pinned.filter((s) => s !== sym));
    else if (pinned.length < HDR_MAX) setAndPersist([...pinned, sym]);
  };

  const [addTxt, setAddTxt] = useState("");
  const addCustom = () => {
    const s = addTxt.trim().toUpperCase();
    if (!s) return;
    if (!isIndex(s)) {
      alert("The header ticker shows indices only (NIFTY, BANKNIFTY, FINNIFTY, SENSEX, BANKEX, INDIA VIX…).");
      return;
    }
    if (!pinned.includes(s) && pinned.length < HDR_MAX) setAndPersist([...pinned, s]);
    setAddTxt("");
  };

  const byBackend = useMemo(() => {
    const m: Record<string, (typeof rows)[number]> = {};
    for (const r of rows) m[r.symbol.toUpperCase()] = r;
    return m;
  }, [rows]);

  // remember the last real spot per symbol so a poll that briefly returns null
  // doesn't blank the chip to "–" (reads as a flicker)
  const lastSpot = useRef<Record<string, number>>({});

  return (
    <div className="relative flex items-center gap-1">
      {symbols.map((sym) => {
        const r = byBackend[sym];
        const w = wlChg[sym];
        if (r?.spot != null) lastSpot.current[sym] = r.spot;
        const spot = r?.spot ?? lastSpot.current[sym] ?? null;
        let pct = r?.chgPct ?? w?.pct ?? null;
        let pts = r?.chgPts ?? w?.pts ?? null;
        if (pts == null && pct != null && spot != null)
          pts = spot - spot / (1 + pct / 100);
        if (pct == null && pts != null && spot != null && spot !== pts)
          pct = (pts / (spot - pts)) * 100;
        return (
          <div
            key={sym}
            className="flex shrink-0 items-baseline gap-1 rounded border border-term-border bg-term-bg/60 px-1.5 py-0.5"
            title={
              pts != null
                ? `${sym} · ${pts >= 0 ? "+" : ""}${px(pts, Math.abs(pts) < 100 ? 2 : 0)} pts`
                : sym
            }
          >
            <span className="text-xs font-semibold uppercase text-term-dim">
              {HDR_LABEL[sym] ?? sym}
            </span>
            <span className="num text-xs font-semibold">
              {spot != null ? px(spot, spot < 100 ? 2 : 0) : "–"}
            </span>
            <span
              className={`num text-xs ${
                pts == null && pct == null
                  ? "invisible"
                  : (pct ?? pts ?? 0) >= 0
                    ? "text-up"
                    : "text-down"
              }`}
            >
              {(pct ?? pts ?? 0) >= 0 ? "▲" : "▼"}
              {pct != null
                ? `${px(Math.abs(pct), 2)}%`
                : pts != null
                  ? px(Math.abs(pts), Math.abs(pts) < 100 ? 2 : 0)
                  : "0"}
            </span>
          </div>
        );
      })}

      <button
        onClick={() => setOpen((o) => !o)}
        title="Choose which indices show here"
        className={`rounded border px-1 py-0.5 text-[10px] ${
          open ? "border-term-accent text-term-accent" : "border-term-border text-term-dim hover:text-term-text"
        }`}
      >
        ⚙
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-52 rounded-md border border-term-border bg-term-panel p-2 shadow-xl">
          <div className="mb-1.5 text-[10px] uppercase tracking-wide text-term-dim">
            Pinned indices ({pinned.length}/{HDR_MAX})
          </div>
          <div className="mb-1.5 text-[10px] leading-snug text-term-dim/80">
            Everything on your watchlist already shows in the ticker — pin extra
            indices here.
          </div>

          {/* currently shown — removable */}
          {pinned.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {pinned.map((s) => (
                <span
                  key={s}
                  className="flex items-center gap-1 rounded bg-term-bg px-1.5 py-0.5 text-2xs text-term-text"
                >
                  {HDR_LABEL[s] ?? s}
                  <button
                    onClick={() => setAndPersist(pinned.filter((x) => x !== s))}
                    className="text-term-dim hover:text-down"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* add any symbol */}
          <div className="mb-1.5 flex gap-1">
            <input
              value={addTxt}
              onChange={(e) => setAddTxt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCustom()}
              placeholder="Add symbol (e.g. SENSEX)"
              disabled={pinned.length >= HDR_MAX}
              className="min-w-0 flex-1 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs text-term-text outline-none focus:border-term-accent disabled:opacity-40"
            />
            <button
              onClick={addCustom}
              disabled={pinned.length >= HDR_MAX}
              className="btn px-2 py-0.5 text-2xs disabled:opacity-40"
            >
              Add
            </button>
          </div>

          <div className="max-h-44 overflow-y-auto">
            <div className="mb-0.5 text-[9px] uppercase tracking-wide text-term-dim">Quick pick</div>
            <div className="flex flex-col gap-1">
              {options.map((o) => (
                <label
                  key={o}
                  className="flex items-center gap-1.5 rounded px-1 py-0.5 text-2xs hover:bg-term-border/50"
                >
                  <input
                    type="checkbox"
                    checked={pinned.includes(o)}
                    onChange={() => toggle(o)}
                    disabled={!pinned.includes(o) && pinned.length >= HDR_MAX}
                  />
                  {HDR_LABEL[o] ?? o}
                </label>
              ))}
            </div>
          </div>
          <button onClick={() => setOpen(false)} className="btn mt-2 w-full text-2xs">
            Done
          </button>
        </div>
      )}
    </div>
  );
}

export function ClassFilter() {
  const symClass = useStore((s) => s.symClass);
  const setSymClass = useStore((s) => s.setSymClass);
  return (
    <div
      className="flex overflow-hidden rounded border border-term-border text-2xs"
      title="Filter watchlist / scanner / screener to indices or stocks"
    >
      {(
        [
          ["all", "All"],
          ["index", "Indices"],
          ["stock", "Stocks"],
        ] as const
      ).map(([v, label]) => (
        <button
          key={v}
          onClick={() => setSymClass(v)}
          className={`px-1.5 py-1 ${
            symClass === v ? "bg-term-accent text-white" : "bg-term-panel text-term-dim hover:bg-term-border"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function MarginStats() {
  const funds = useStore((s) => s.brokerFunds);
  const paper = useStore((s) => s.paper);
  const orderMode = useStore((s) => s.orderMode);

  const live = orderMode === "live" && funds?.connected && funds.available != null;
  const avail = live ? funds!.available! : paper?.marginAvailable ?? null;
  const used = live ? funds!.used! : paper?.marginUsed ?? null;
  const src = live ? "Flattrade" : "paper";
  if (avail == null && used == null) return null;

  return (
    <div className="flex items-center gap-1.5" title={`Margin (${src})`}>
      <Stat
        label={`Margin avail · ${src}`}
        value={
          <HideNum k="marginAvail">{avail != null ? `₹${compact(avail)}` : "–"}</HideNum>
        }
        cls={avail != null && avail < 0 ? "text-down" : "text-up"}
      />
      <Stat
        label="Margin used"
        value={<HideNum k="marginUsed">{used != null ? `₹${compact(used)}` : "–"}</HideNum>}
        cls={used ? "text-amber-400" : ""}
      />
    </div>
  );
}

const _num = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Book P&L for the dashboard — the real Flattrade position book when the
 *  broker is linked, otherwise the paper book. Shared by the desktop header
 *  and the mobile top strip. */
export function useBookPnl():
  | { source: "broker" | "paper"; mtm: number; realized: number; today: number; dayPnl: number }
  | null {
  const paper = useStore((s) => s.paper);
  const broker = useStore((s) => s.broker);
  const { mark, dayPnl: liveDay } = useLiveMtm();
  const [bpos, setBpos] = useState<any[] | null>(null);

  useEffect(() => {
    if (!broker?.authed) {
      setBpos(null);
      return;
    }
    let alive = true;
    const load = () =>
      api.brokerPositions().then((d) => alive && setBpos(d.positions || []), () => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [broker?.authed]);

  if (broker?.authed && bpos) {
    // live socket MTM (re-marked tick-by-tick) when available, else the 5s poll
    const mtm = bpos.reduce((s, r) => s + (mark(r) ?? (_num(r.urmtom) || _num(r.mtm))), 0);
    const realized = bpos.reduce((s, r) => s + _num(r.rpnl), 0);
    // Flattrade "P&L" — day M2M from prev close; live sum when fresh, else the poll
    const dayPnl =
      liveDay ??
      bpos.reduce(
        (s, r) => s + (Number.isFinite(+r._dayPnl) ? +r._dayPnl : _num(r.rpnl) + _num(r.urmtom)),
        0
      );
    return { source: "broker", mtm, realized, today: mtm + realized, dayPnl };
  }
  if (!paper) return null;
  return {
    source: "paper",
    mtm: paper.unrealized,
    realized: paper.realized,
    today: paper.total,
    dayPnl: paper.total,
  };
}

/** live P&L / MTM summary on the dashboard header — labels match Flattrade */
function PnlStrip() {
  const p = useBookPnl();
  if (!p) return null;
  const broker = p.source === "broker";
  return (
    <div
      className="flex items-center gap-1.5"
      title={
        broker
          ? "MTM = P&L vs your entry price (Flattrade 'MTM'). P&L = day M2M from the previous close (Flattrade 'P&L') — differs by the overnight gap on carried positions."
          : "Paper book P&L (broker not linked)"
      }
    >
      <Stat
        label={broker ? "MTM" : "Paper MTM"}
        value={`₹${nf(p.today, 0)}`}
        cls={signColor(p.today)}
      />
      <Stat
        label={broker ? "P&L" : "Total"}
        value={`₹${nf(p.dayPnl, 0)}`}
        cls={signColor(p.dayPnl)}
      />
    </div>
  );
}

export function BrokerPill() {
  const { broker, connectBroker, disconnectBroker, refreshBroker, setBrokerToken } = useStore();
  const [mode, setMode] = useState<"" | "token">("");
  const [tok, setTok] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      const err = await refreshBroker();
      if (err) alert(`Broker refresh: ${err}`);
    } catch (e: any) {
      alert(`Broker refresh failed: ${e?.message || e}`);
    } finally {
      setRefreshing(false);
    }
  };

  if (!broker || !broker.configured)
    return (
      <span className="text-[10px] text-term-dim" title="Set FLATTRADE_* in backend/.env">
        broker off
      </span>
    );

  const run = async (fn: () => Promise<void>, label: string) => {
    setBusy(true);
    try {
      await fn();
      setMode("");
      setTok("");
    } catch (e: any) {
      alert(`${label} failed: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const tokenForm = mode === "token" && (
    <span className="flex items-center gap-1">
      <input
        autoFocus
        value={tok}
        onChange={(e) => setTok(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && tok.trim() && run(() => setBrokerToken(tok), "Token")}
        placeholder="paste Flattrade token"
        className="w-48 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs outline-none focus:border-term-accent"
      />
      <button
        onClick={() => tok.trim() && run(() => setBrokerToken(tok), "Token")}
        disabled={busy}
        className="rounded bg-term-accent px-1.5 py-0.5 text-2xs text-white disabled:opacity-40"
      >
        {busy ? "…" : "set"}
      </button>
      <button onClick={() => setMode("")} className="text-term-dim hover:text-down">
        ✕
      </button>
    </span>
  );

  const altBtns = !mode && (
    <>
      <button
        onClick={doRefresh}
        disabled={refreshing}
        title="Reload the saved session, re-validate the token and reconnect the live feed"
        className="rounded border border-term-border px-1.5 py-1 text-2xs text-term-dim hover:text-term-text disabled:opacity-40"
      >
        {refreshing ? "…" : "⟳ refresh"}
      </button>
      <button
        onClick={() => setMode("token")}
        title="Paste a token generated from the Flattrade portal"
        className="rounded border border-term-border px-1.5 py-1 text-2xs text-term-dim hover:text-term-text"
      >
        ⌗ token
      </button>
    </>
  );

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {broker.authed ? (
        <button
          onClick={disconnectBroker}
          title={`${broker.clientId} · ${broker.wsConnected ? "feed live" : "feed connecting"} · click to disconnect`}
          className="flex items-center gap-1.5 rounded border border-up/40 bg-up/10 px-2 py-1 text-2xs text-up"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${broker.wsConnected ? "bg-up" : "bg-amber-500 animate-pulse"}`} />
          FT · {broker.clientId}
        </button>
      ) : (
        <button
          onClick={connectBroker}
          className="rounded border border-amber-500/50 bg-amber-500/15 px-2 py-1 text-2xs text-amber-400 hover:bg-amber-500/25"
        >
          Connect Flattrade
        </button>
      )}
      {tokenForm}
      {altBtns}
    </span>
  );
}

export function UpstoxPill() {
  const [st, setSt] = useState<{
    configured: boolean;
    authed: boolean;
    static?: boolean;
    tokenDate: string | null;
  } | null>(null);
  const [src, setSrc] = useState<"nse" | "upstox">("nse");
  const [mode, setMode] = useState<"" | "token">("");
  const [tok, setTok] = useState("");
  const load = () => {
    api.upstoxStatus().then(setSt, () => setSt(null));
    api.dataSource().then((d) => setSrc(d.source), () => {});
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!st) return null; // backend unreachable

  if (st.authed) {
    return (
      <span className="flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-2xs text-sky-300">
        <span className="h-1.5 w-1.5 rounded-full bg-sky-400" title="Upstox data feed connected" />
        <span className="hidden sm:inline">Upstox</span>
        {/* chain source toggle */}
        <span className="flex overflow-hidden rounded border border-sky-500/40">
          {(["nse", "upstox"] as const).map((s) => (
            <button
              key={s}
              onClick={() => api.setDataSource(s).then((d) => setSrc(d.source), () => {})}
              className={`px-1 py-0.5 text-[10px] ${
                src === s ? "bg-sky-500 text-white" : "text-sky-300/70 hover:text-sky-200"
              }`}
              title={`Option chain data from ${s === "nse" ? "NSE" : "Upstox (incl. BSE)"}`}
            >
              {s === "nse" ? "NSE" : "UX"}
            </button>
          ))}
        </span>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1">
      {mode === "token" ? (
        <>
          <input
            autoFocus
            value={tok}
            onChange={(e) => setTok(e.target.value)}
            placeholder="paste Upstox analytics token"
            className="w-44 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs outline-none focus:border-term-accent"
          />
          <button
            onClick={() =>
              tok.trim() && api.upstoxSetToken(tok).then(() => (setMode(""), setTok(""), load()))
            }
            className="rounded bg-term-accent px-1.5 py-0.5 text-2xs text-white"
          >
            set
          </button>
          <button onClick={() => setMode("")} className="text-term-dim hover:text-down">
            ✕
          </button>
        </>
      ) : (
        <button
          onClick={() => setMode("token")}
          title="Paste your Upstox 1-year Analytics Access Token to enable the Upstox data feed"
          className="rounded border border-sky-500/50 bg-sky-500/10 px-2 py-1 text-2xs text-sky-300 hover:bg-sky-500/20"
        >
          + Upstox data
        </button>
      )}
    </span>
  );
}

export function OrderModePill() {
  const { orderMode, broker, setOrderMode } = useStore();
  const toLive = async () => {
    if (!broker?.authed) {
      alert("Connect Flattrade before enabling LIVE orders.");
      return;
    }
    if (
      !window.confirm(
        "Switch to LIVE mode?\n\nEvery Buy/Sell and strategy Execute will place a REAL order on Flattrade with real money. Each order still asks for confirmation."
      )
    )
      return;
    const err = await setOrderMode("live");
    if (err) alert(err);
  };
  return (
    <div className="flex overflow-hidden rounded border border-term-border text-2xs">
      <button
        onClick={() => setOrderMode("paper")}
        className={`px-1.5 py-1 ${orderMode === "paper" ? "bg-term-accent text-white" : "text-term-dim hover:bg-term-border"}`}
      >
        PAPER
      </button>
      <button
        onClick={toLive}
        className={`px-1.5 py-1 font-semibold ${orderMode === "live" ? "bg-down text-white" : "text-term-dim hover:bg-term-border"}`}
      >
        LIVE
      </button>
    </div>
  );
}

export { FontScale, applyFontScale } from "./FontScale";

export function AlertBell() {
  const { alerts, alertsSeen, unusual, unusualSeen, notifOpen, openNotif, closeNotif } = useStore();
  const unseen =
    Math.max(0, alerts.length - alertsSeen) + Math.max(0, unusual.length - unusualSeen);
  return (
    <button
      onClick={() => (notifOpen ? closeNotif() : openNotif())}
      className={`relative rounded border px-2 py-1 text-sm hover:bg-term-border ${
        notifOpen ? "border-term-accent bg-term-border" : "border-term-border"
      }`}
      title="Notifications"
    >
      🔔
      {unseen > 0 && (
        <span className="absolute -right-1.5 -top-1.5 min-w-[16px] rounded-full bg-down px-1 text-[10px] font-bold leading-4 text-white">
          {unseen}
        </span>
      )}
    </button>
  );
}

/** ATM-IV regime chip — where current IV sits in the session's IV range. */
function IvBadge() {
  const chain = useStore((s) => s.chain);
  const [series, setSeries] = useState<number[]>([]);
  const sym = chain?.symbol;
  useEffect(() => {
    if (!sym) return;
    let alive = true;
    const load = () =>
      api.history(sym).then(
        (d) =>
          alive &&
          setSeries(d.points.map((p) => p.atmIV).filter((v): v is number => v != null)),
        () => {}
      );
    load();
    const id = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [sym]);
  if (!chain) return null;
  const r = ivRegime(series, chain.atmIV);
  return (
    <Stat
      label="IV regime"
      value={
        <span title={r.hint}>
          {r.label}
          {r.pctile != null && <span className="text-term-dim"> · {r.pctile}%</span>}
        </span>
      }
      cls={r.cls}
    />
  );
}

export function Header({ children }: { children?: ReactNode }) {
  const chain = useStore((s) => s.chain);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [, force] = useState(0);
  useEffect(() => {
    // keep the "…ago" timestamp fresh
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const gexPos = (chain?.netGex ?? 0) >= 0;
  const orderMode = useStore((s) => s.orderMode);

  return (
    <div
      className={`flex flex-col gap-1 border-b bg-term-panel px-3 py-1 ${
        orderMode === "live" ? "border-down" : "border-term-border"
      }`}
    >
      {/* row 1 — logo, index ticker, view switch, filters, session pills */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <LogoWordmark />
        <HeaderIndices />
        {chain && (
          <span className="text-2xs text-term-dim">
            NSE {chain.nseTimestamp?.split(" ")[1]?.slice(0, 5) ?? "–"} ·{" "}
            <span className="inline-block w-[2.5rem]">{ago(chain.fetchedAt)}</span>
          </span>
        )}
        <ViewToggle />
        <ClassFilter />
        <div className="ml-auto flex items-center gap-1.5">
          <OrderModePill />
          <BrokerPill />
          <AlertBell />
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded border border-term-border px-1.5 py-1 text-2xs text-term-dim hover:text-term-text"
            title="Settings"
          >
            ⚙
          </button>
          <button
            onClick={lockNow}
            className="rounded border border-term-border px-1.5 py-1 text-2xs text-term-dim hover:text-term-text"
            title="Lock the app — require the password / PIN again"
          >
            🔒
          </button>
          <ConnBadge />
        </div>
      </div>

      {/* row 2 — data source + chain stats + margin + P&L */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <UpstoxPill />
      {chain ? (
        <>
          <Stat label="ATM IV" value={chain.atmIV ? `${nf(chain.atmIV)}%` : "–"} />
          <IvBadge />
          <Stat
            label="PCR"
            value={nf(chain.pcr, 2)}
            cls={chain.pcr ? (chain.pcr >= 1 ? "text-up" : "text-down") : ""}
          />
          <Stat label="Max Pain" value={nf(chain.maxPain, 0)} />
          <Stat label="Net GEX" value={compact(chain.netGex)} cls={gexPos ? "text-up" : "text-down"} />
          <Stat label="DTE" value={nf(chain.dte, 1)} />
          <Stat label="Lot" value={chain.lotSize} />
        </>
      ) : (
        <span className="text-xs text-term-dim">loading chain…</span>
      )}

      <MarginStats />
      <PnlStrip />
      <div className="ml-auto flex items-center">{children}</div>
      </div>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
