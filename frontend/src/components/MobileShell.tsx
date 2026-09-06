import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, sk, compact, signColor } from "../lib/format";
import { ivRegime } from "../lib/iv";
import type { View } from "../types";

/** compact P&L chips for the mobile top strip */
function MobilePnl() {
  const paper = useStore((s) => s.paper);
  if (!paper) return null;
  const cell = (l: string, v: number) => (
    <span className="flex shrink-0 flex-col items-end leading-none">
      <span className="text-[8px] uppercase text-term-dim">{l}</span>
      <span className={`num text-[11px] font-semibold ${signColor(v)}`}>₹{nf(v, 0)}</span>
    </span>
  );
  return (
    <div className="ml-auto flex shrink-0 items-center gap-2.5 border-l border-term-border pl-2">
      {cell("MTM", paper.unrealized)}
      {cell("Total", paper.total)}
      {cell("Real", paper.realized)}
      {cell("Unreal", paper.unrealized)}
    </div>
  );
}

import {
  HeaderIndices,
  OrderModePill,
  AlertBell,
  BrokerPill,
  UpstoxPill,
  ClassFilter,
} from "./Header";
import { lockNow } from "../lib/auth";
import { NotificationPanel } from "./NotificationPanel";
import { OrderConfirm } from "./OrderConfirm";
import { Watchlist } from "./Watchlist";
import { ExpiryTabs } from "./ExpiryTabs";
import { OptionChain } from "./OptionChain";
import { OIProfile } from "./OIProfile";
import { ScripView } from "./ScripView";
import { TrendingOI } from "./TrendingOI";
import { ScannerView } from "./ScannerView";
import { Chart } from "./Chart";
import { StrategyBuilder } from "./StrategyBuilder";
import { PositionsView } from "./PositionsView";
import { ScalpPanel } from "./ScalpPanel";
import { ScalpCharts } from "./ScalpCharts";
import { AutoBotView } from "./AutoBot";
import { Funds } from "./Funds";

/** left icon rail — order is the tab order down the screen */
const NAV: { v: View; icon: string; label: string }[] = [
  { v: "watchlist", icon: "★", label: "Watch" },
  { v: "chart", icon: "📈", label: "Chart" },
  { v: "scrip", icon: "▤", label: "OI" },
  { v: "scanner", icon: "📡", label: "Scan" },
  { v: "trendingoi", icon: "🔥", label: "Trend OI" },
  { v: "scalper", icon: "⚡", label: "Scalp" },
  { v: "builder", icon: "🧱", label: "Build" },
  { v: "auto", icon: "🤖", label: "Auto" },
  { v: "positions", icon: "💼", label: "Pos" },
  { v: "orders", icon: "📜", label: "Orders" },
  { v: "funds", icon: "💰", label: "Funds" },
];

function ChainStrip() {
  const chain = useStore((s) => s.chain);
  const liveSpots = useStore((s) => s.liveSpots);
  const [ivSeries, setIvSeries] = useState<number[]>([]);
  const sym = chain?.symbol;
  useEffect(() => {
    if (!sym) return;
    let alive = true;
    const load = () =>
      api.history(sym).then(
        (d) =>
          alive &&
          setIvSeries(d.points.map((p) => p.atmIV).filter((v): v is number => v != null)),
        () => {}
      );
    load();
    const id = window.setInterval(load, 60000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [sym]);
  if (!chain) return null;
  const reg = ivRegime(ivSeries, chain.atmIV);
  const live = liveSpots[chain.symbol];
  const fresh = live && Date.now() / 1000 - live.ts < 12;
  const spot = fresh ? live!.ltp : chain.spot;
  const cell = (label: string, value: React.ReactNode, cls = "") => (
    <div className="flex shrink-0 flex-col leading-none">
      <span className="text-[8px] uppercase tracking-wide text-term-dim">{label}</span>
      <span className={`num text-[11px] ${cls}`}>{value}</span>
    </div>
  );
  return (
    <div className="flex items-center gap-3 overflow-x-auto border-b border-term-border bg-term-panel2 px-3 py-1">
      {cell("Spot", nf(spot), "font-semibold text-[12px]")}
      {cell("ATM", sk(chain.atmStrike))}
      {cell("IV", chain.atmIV ? `${nf(chain.atmIV)}%` : "–")}
      {cell(
        "IV zone",
        reg.pctile != null ? `${reg.label} ${reg.pctile}%` : reg.label,
        reg.cls
      )}
      {cell(
        "PCR",
        nf(chain.pcr, 2),
        chain.pcr ? (chain.pcr >= 1 ? "text-up" : "text-down") : ""
      )}
      {cell("Max Pain", nf(chain.maxPain, 0))}
      {cell(
        "Net GEX",
        compact(chain.netGex),
        (chain.netGex ?? 0) >= 0 ? "text-up" : "text-down"
      )}
      {cell("DTE", nf(chain.dte, 1))}
      {cell("Lot", chain.lotSize)}
    </div>
  );
}

function MobileBody({ view }: { view: View }) {
  switch (view) {
    case "chain":
      return (
        <>
          <ExpiryTabs />
          <OptionChain />
        </>
      );
    case "watchlist":
      return <Watchlist />;
    case "oiprofile":
      return <OIProfile />;
    case "scrip":
      return <ScripView />;
    case "trendingoi":
      return <TrendingOI />;
    case "scanner":
      return <ScannerView />;
    case "chart":
      return <Chart />;
    case "scalper":
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <ScalpCharts />
          </div>
          <div className="max-h-[45%] overflow-auto border-t border-term-border">
            <ScalpPanel />
          </div>
        </div>
      );
    case "builder":
      return <StrategyBuilder />;
    case "positions":
      return <PositionsView />;
    case "orders":
      return <PositionsView initialTab="orders" />;
    case "auto":
      return <AutoBotView />;
    case "funds":
      return <Funds />;
    default:
      return null;
  }
}

export function MobileShell() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const orderMode = useStore((s) => s.orderMode);
  const [brokerOpen, setBrokerOpen] = useState(false);

  return (
    <div
      className="relative flex h-full flex-col bg-term-bg text-term-text"
      style={{
        // keep the top bar (broker / login button) clear of the phone's
        // status bar — battery / signal icons were covering it
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      {/* ── top bar ─────────────────────────────────────────── */}
      <div
        className={`flex items-center gap-1.5 border-b bg-term-panel px-1.5 py-1.5 ${
          orderMode === "live" ? "border-down" : "border-term-border"
        }`}
      >
        <span className="shrink-0 text-[13px] font-bold tracking-tight">GT</span>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <HeaderIndices />
        </div>
        <OrderModePill />
        <button
          onClick={() => setBrokerOpen((o) => !o)}
          className={`shrink-0 rounded border px-1.5 py-1 text-[11px] ${
            brokerOpen ? "border-term-accent text-term-accent" : "border-term-border text-term-dim"
          }`}
          title="Broker"
        >
          ⚿
        </button>
        <AlertBell />
      </div>

      {/* stocks / indices filter — applies to watchlist, chain, OI, scanner… */}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-term-border bg-term-panel2 px-2 py-1">
        <span className="shrink-0 text-[9px] uppercase tracking-wide text-term-dim">Show</span>
        <ClassFilter />
        <MobilePnl />
      </div>

      {brokerOpen && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-term-border bg-term-panel2 px-2 py-1.5">
          <BrokerPill />
          <UpstoxPill />
          <button
            onClick={lockNow}
            className="ml-auto rounded border border-term-border px-2 py-1 text-2xs text-term-dim hover:text-term-text"
            title="Lock the app — require the password / PIN again"
          >
            🔒 Lock
          </button>
        </div>
      )}

      <NotificationPanel />
      <ChainStrip />

      {/* ── rail + content ──────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[52px] shrink-0 flex-col overflow-y-auto border-r border-term-border bg-term-panel2 min-[560px]:w-16">
          {NAV.map((n) => (
            <button
              key={n.v}
              onClick={() => setView(n.v)}
              className={`flex flex-col items-center gap-0.5 py-2 ${
                view === n.v
                  ? "bg-term-accent text-white"
                  : "text-term-dim active:bg-term-border"
              }`}
            >
              <span className="text-[15px] leading-none">{n.icon}</span>
              <span className="text-[8px] uppercase tracking-wide">{n.label}</span>
            </button>
          ))}
        </nav>

        <main className="flex min-h-0 flex-1 flex-col overflow-auto">
          <MobileBody view={view} />
        </main>
      </div>

      <OrderConfirm />
    </div>
  );
}
