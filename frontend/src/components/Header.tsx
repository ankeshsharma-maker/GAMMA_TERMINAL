import { useStore } from "../store";
import { compact, nf, ago, sk, signColor } from "../lib/format";
import { api } from "../lib/api";
import { lockNow } from "../lib/auth";
import { ConnBadge } from "./ConnBadge";
import { useEffect, useState, type ReactNode } from "react";

function Stat({ label, value, cls = "" }: { label: string; value: ReactNode; cls?: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[10px] uppercase tracking-wide text-term-dim">{label}</span>
      <span className={`num text-sm ${cls}`}>{value}</span>
    </div>
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
          className={`rounded-md border px-2.5 py-1 font-bold uppercase tracking-wide transition-all ${
            view === v
              ? "border-term-accent bg-term-accent text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_1px_3px_rgba(0,0,0,0.45)]"
              : "border-term-border bg-gradient-to-b from-term-panel2 to-term-bg text-term-text shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_1px_2px_rgba(0,0,0,0.35)] hover:border-term-accent/60 hover:text-white active:translate-y-px"
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

function loadHdrSymbols(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HDR_LS_KEY) || "null");
    return Array.isArray(raw) && raw.length ? raw : HDR_DEFAULT;
  } catch {
    return HDR_DEFAULT;
  }
}

export function HeaderIndices() {
  const [symbols, setSymbols] = useState<string[]>(loadHdrSymbols);
  const [rows, setRows] = useState<{ symbol: string; spot: number | null; chgPct: number | null }[]>([]);
  const [options, setOptions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.indicesHeaderOptions().then((d) => setOptions(d.options), () => {});
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
  }, [symbols]);

  const setAndPersist = (next: string[]) => {
    setSymbols(next);
    try {
      localStorage.setItem(HDR_LS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const toggle = (sym: string) => {
    const has = symbols.includes(sym);
    if (has) setAndPersist(symbols.filter((s) => s !== sym));
    else if (symbols.length < HDR_MAX) setAndPersist([...symbols, sym]);
  };

  const [addTxt, setAddTxt] = useState("");
  const addCustom = () => {
    const s = addTxt.trim().toUpperCase();
    if (!s) return;
    if (!symbols.includes(s) && symbols.length < HDR_MAX) setAndPersist([...symbols, s]);
    setAddTxt("");
  };

  return (
    <div className="relative flex items-center gap-1.5">
      {rows.map((r) => (
        <div
          key={r.symbol}
          className="flex items-baseline gap-1 rounded border border-term-border bg-term-bg/60 px-1.5 py-0.5"
          title={r.symbol}
        >
          <span className="text-[9px] font-semibold uppercase text-term-dim">
            {HDR_LABEL[r.symbol] ?? r.symbol}
          </span>
          <span className="num text-xs font-medium">{r.spot != null ? nf(r.spot) : "–"}</span>
          {r.chgPct != null && (
            <span className={`num text-[10px] ${r.chgPct >= 0 ? "text-up" : "text-down"}`}>
              {r.chgPct >= 0 ? "▲" : "▼"}
              {nf(Math.abs(r.chgPct), 2)}%
            </span>
          )}
        </div>
      ))}

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
            Header indices ({symbols.length}/{HDR_MAX})
          </div>

          {/* currently shown — removable */}
          {symbols.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {symbols.map((s) => (
                <span
                  key={s}
                  className="flex items-center gap-1 rounded bg-term-bg px-1.5 py-0.5 text-2xs text-term-text"
                >
                  {HDR_LABEL[s] ?? s}
                  <button
                    onClick={() => setAndPersist(symbols.filter((x) => x !== s))}
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
              disabled={symbols.length >= HDR_MAX}
              className="min-w-0 flex-1 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs text-term-text outline-none focus:border-term-accent disabled:opacity-40"
            />
            <button
              onClick={addCustom}
              disabled={symbols.length >= HDR_MAX}
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
                    checked={symbols.includes(o)}
                    onChange={() => toggle(o)}
                    disabled={!symbols.includes(o) && symbols.length >= HDR_MAX}
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
          className={`px-2 py-1 ${
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
    <div className="flex items-center gap-3" title={`Margin (${src})`}>
      <Stat
        label={`Margin avail · ${src}`}
        value={avail != null ? `₹${compact(avail)}` : "–"}
        cls={avail != null && avail < 0 ? "text-down" : "text-up"}
      />
      <Stat
        label="Margin used"
        value={used != null ? `₹${compact(used)}` : "–"}
        cls={used ? "text-amber-400" : ""}
      />
    </div>
  );
}

/** live P&L / MTM summary on the dashboard header */
function PnlStrip() {
  const paper = useStore((s) => s.paper);
  const orderMode = useStore((s) => s.orderMode);
  if (!paper) return null;
  const src = orderMode === "live" ? "LIVE" : "paper";
  return (
    <div
      className="flex items-center gap-3 border-l border-term-border pl-3"
      title={`Book P&L (${src})`}
    >
      <Stat
        label="Live P&L (MTM)"
        value={`₹${nf(paper.unrealized, 0)}`}
        cls={signColor(paper.unrealized)}
      />
      <Stat
        label="Total MTM"
        value={`₹${nf(paper.total, 0)}`}
        cls={signColor(paper.total)}
      />
      <Stat
        label="Realized"
        value={`₹${nf(paper.realized, 0)}`}
        cls={signColor(paper.realized)}
      />
      <Stat
        label="Unrealized"
        value={`₹${nf(paper.unrealized, 0)}`}
        cls={signColor(paper.unrealized)}
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
        className={`px-2 py-1 ${orderMode === "paper" ? "bg-term-accent text-white" : "text-term-dim hover:bg-term-border"}`}
      >
        PAPER
      </button>
      <button
        onClick={toLive}
        className={`px-2 py-1 font-semibold ${orderMode === "live" ? "bg-down text-white" : "text-term-dim hover:bg-term-border"}`}
      >
        LIVE
      </button>
    </div>
  );
}

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

export function Header() {
  const chain = useStore((s) => s.chain);
  const liveSpots = useStore((s) => s.liveSpots);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const gexPos = (chain?.netGex ?? 0) >= 0;
  const orderMode = useStore((s) => s.orderMode);
  const live = chain ? liveSpots[chain.symbol] : undefined;
  const liveFresh = live && Date.now() / 1000 - live.ts < 12;

  return (
    <div
      className={`flex flex-wrap items-center gap-x-5 gap-y-2 border-b bg-term-panel px-4 py-2 ${
        orderMode === "live" ? "border-down" : "border-term-border"
      }`}
    >
      <span className="text-base font-semibold tracking-tight">GammaTerminal</span>
      <HeaderIndices />
      <ViewToggle />
      <ClassFilter />
      <OrderModePill />

      {chain ? (
        <>
          <div className="flex items-baseline gap-2">
            <span className="num text-lg font-semibold">
              {nf(liveFresh ? live!.ltp : chain.spot)}
            </span>
            {liveFresh && (
              <span
                className={`num text-2xs ${
                  (live!.chgPct ?? 0) >= 0 ? "text-up" : "text-down"
                }`}
                title="Flattrade live tick"
              >
                {live!.chgPct != null ? `${live!.chgPct > 0 ? "+" : ""}${nf(live!.chgPct, 2)}%` : ""} ●
              </span>
            )}
          </div>
          <Stat label="ATM" value={sk(chain.atmStrike)} />
          <Stat label="ATM IV" value={chain.atmIV ? `${nf(chain.atmIV)}%` : "–"} />
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

      <div className="ml-auto flex items-center gap-3">
        {chain && (
          <span className="text-2xs text-term-dim">
            NSE {chain.nseTimestamp?.split(" ")[1] ?? "–"} · {ago(chain.fetchedAt)}
          </span>
        )}
        <UpstoxPill />
        <BrokerPill />
        <AlertBell />
        <button
          onClick={lockNow}
          className="rounded border border-term-border px-2 py-1 text-2xs text-term-dim hover:text-term-text"
          title="Lock the app — require the password / PIN again"
        >
          🔒
        </button>
        <ConnBadge />
      </div>
    </div>
  );
}
