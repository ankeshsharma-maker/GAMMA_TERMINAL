import { useStore } from "../store";
import { compact, nf, ago, sk } from "../lib/format";
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
          ["oiprofile", "OI"],
          ["scanner", "scanner"],
          ["chart", "chart"],
          ["builder", "builder"],
          ["positions", "positions"],
          ["scalper", "scalper"],
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
  const { broker, connectBroker, disconnectBroker } = useStore();
  if (!broker || !broker.configured)
    return (
      <span className="text-[10px] text-term-dim" title="Set FLATTRADE_* in backend/.env">
        broker off
      </span>
    );
  if (!broker.authed)
    return (
      <button
        onClick={connectBroker}
        className="rounded border border-amber-500/50 bg-amber-500/15 px-2 py-1 text-2xs text-amber-400 hover:bg-amber-500/25"
      >
        Connect Flattrade
      </button>
    );
  return (
    <button
      onClick={disconnectBroker}
      title={`${broker.clientId} · ${broker.wsConnected ? "feed live" : "feed connecting"} · click to disconnect`}
      className="flex items-center gap-1.5 rounded border border-up/40 bg-up/10 px-2 py-1 text-2xs text-up"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${broker.wsConnected ? "bg-up" : "bg-amber-500 animate-pulse"}`} />
      FT · {broker.clientId}
    </button>
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
      <ViewToggle />
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
