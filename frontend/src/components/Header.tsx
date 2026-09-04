import { useStore } from "../store";
import { compact, nf, ago, sk } from "../lib/format";
import { api } from "../lib/api";
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
    <div className="flex overflow-hidden rounded border border-term-border text-2xs">
      {(
        [
          ["chain", "chain"],
          ["scrip", "scrip"],
          ["oiprofile", "OI"],
          ["scanner", "scanner"],
          ["chart", "chart"],
          ["builder", "builder"],
          ["positions", "positions"],
          ["scalper", "scalper"],
          ["auto", "auto"],
          ["funds", "funds"],
        ] as const
      ).map(([v, label]) => (
        <button
          key={v}
          onClick={() => setView(v)}
          className={`px-2.5 py-1 capitalize ${
            view === v ? "bg-term-accent text-white" : "bg-term-panel text-term-dim hover:bg-term-border"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const HDR_LABEL: Record<string, string> = { NIFTY: "NIFTY50", BANKNIFTY: "BANKNIFTY", "INDIA VIX": "INDIA VIX" };

function HeaderIndices() {
  const [rows, setRows] = useState<{ symbol: string; spot: number | null; chgPct: number | null }[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.indicesHeader().then((d) => alive && setRows(d.indices), () => {});
    load();
    const t = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (rows.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
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
    </div>
  );
}

function ClassFilter() {
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

function BrokerPill() {
  const { broker, connectBroker, disconnectBroker, refreshBroker, setBrokerToken, brokerDirectLogin } =
    useStore();
  const [mode, setMode] = useState<"" | "token" | "login">("");
  const [tok, setTok] = useState("");
  const [cred, setCred] = useState({ uid: "", pwd: "", totp: "", vc: "" });
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
      setCred({ uid: "", pwd: "", totp: "", vc: "" });
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

  const loginForm = mode === "login" && (
    <span className="flex items-center gap-1">
      <input
        autoFocus
        value={cred.uid}
        onChange={(e) => setCred({ ...cred, uid: e.target.value })}
        placeholder="client id"
        className="w-20 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs outline-none focus:border-term-accent"
      />
      <input
        type="password"
        value={cred.pwd}
        onChange={(e) => setCred({ ...cred, pwd: e.target.value })}
        placeholder="password"
        className="w-24 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs outline-none focus:border-term-accent"
      />
      <input
        value={cred.totp}
        onChange={(e) => setCred({ ...cred, totp: e.target.value })}
        placeholder="TOTP code or secret"
        className="w-32 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-2xs outline-none focus:border-term-accent"
      />
      <button
        onClick={() =>
          cred.uid && cred.pwd && cred.totp && run(() => brokerDirectLogin(cred), "Login")
        }
        disabled={busy}
        className="rounded bg-term-accent px-1.5 py-0.5 text-2xs text-white disabled:opacity-40"
      >
        {busy ? "…" : "login"}
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
        onClick={() => setMode("login")}
        title="Direct login: client id + password + TOTP (no OAuth redirect)"
        className="rounded border border-term-border px-1.5 py-1 text-2xs text-term-dim hover:text-term-text"
      >
        ⚿ login
      </button>
      <button
        onClick={() => setMode("token")}
        title="Paste a token generated from the Flattrade portal"
        className="rounded border border-term-border px-1.5 py-1 text-2xs text-term-dim hover:text-term-text"
      >
        ⌗
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
      {loginForm}
      {altBtns}
    </span>
  );
}

function OrderModePill() {
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

function AlertBell() {
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
            <span className="text-base font-semibold tracking-tight">{chain.symbol}</span>
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

      <div className="ml-auto flex items-center gap-3">
        {chain && (
          <span className="text-2xs text-term-dim">
            NSE {chain.nseTimestamp?.split(" ")[1] ?? "–"} · {ago(chain.fetchedAt)}
          </span>
        )}
        <BrokerPill />
        <AlertBell />
        <ConnBadge />
      </div>
    </div>
  );
}
