import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, sk, compact, signColor, px } from "../lib/format";
import { ivRegime } from "../lib/iv";
import type { View } from "../types";

import {
  OrderModePill,
  BrokerPill,
  UpstoxPill,
  ClassFilter,
  FontScale,
  useBookPnl,
} from "./Header";

/** NIFTY + SENSEX, ultra-compact — sits next to the GT mark, fits a folded Fold 6 */
function TopIndices() {
  const [rows, setRows] = useState<
    { symbol: string; spot: number | null; chgPct: number | null }[]
  >([]);
  // last real value per symbol — a poll that returns null must not blank the
  // chip (that flicker between "–" and the price is what users notice)
  const lastRef = useRef<Record<string, { spot: number; chgPct: number | null }>>({});
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .indicesHeader(["NIFTY", "SENSEX"])
        .then((d) => alive && setRows(d.indices), () => {});
    load();
    const t = window.setInterval(load, 10000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  if (rows.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {rows.slice(0, 2).map((r) => {
        if (r.spot != null) lastRef.current[r.symbol] = { spot: r.spot, chgPct: r.chgPct };
        const last = lastRef.current[r.symbol];
        const spot = r.spot ?? last?.spot ?? null;
        const chgPct = r.chgPct ?? last?.chgPct ?? null;
        const up = (chgPct ?? 0) >= 0;
        return (
          <span
            key={r.symbol}
            className="flex shrink-0 items-baseline gap-1 rounded border border-term-border bg-term-bg/60 px-1.5 py-0.5"
          >
            <span className="text-[8px] font-semibold uppercase tracking-tight text-term-dim">
              {r.symbol}
            </span>
            <span className="num text-[11px] font-semibold leading-none">
              {spot != null ? nf(spot, 0) : "–"}
            </span>
            <span
              className={`num text-[8px] leading-none ${
                chgPct == null ? "invisible" : up ? "text-up" : "text-down"
              }`}
            >
              {up ? "▲" : "▼"}
              {nf(Math.abs(chgPct ?? 0), 2)}%
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** two big index quotes across the top of the mobile watchlist */
function MobileIndexBand() {
  const [rows, setRows] = useState<
    { symbol: string; spot: number | null; chgPct: number | null; chgPts?: number | null }[]
  >([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.indicesHeader(["NIFTY", "SENSEX"]).then((d) => alive && setRows(d.indices), () => {});
    load();
    const t = window.setInterval(load, 8000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  if (rows.length === 0) return null;
  const label: Record<string, string> = { NIFTY: "NIFTY 50", "INDIA VIX": "INDIA VIX" };
  return (
    <div className="grid shrink-0 grid-cols-2 divide-x divide-term-border border-b border-term-border bg-term-panel2">
      {rows.slice(0, 2).map((r) => {
        const up = (r.chgPct ?? 0) >= 0;
        const pts =
          r.chgPts ??
          (r.chgPct != null && r.spot != null ? r.spot - r.spot / (1 + r.chgPct / 100) : null);
        return (
          <div key={r.symbol} className="flex flex-col items-center py-1 leading-tight">
            <span className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-term-dim">
              {label[r.symbol] ?? r.symbol}
              {r.chgPct != null && (
                <span className={up ? "text-up" : "text-down"}>{up ? "↑" : "↓"}</span>
              )}
            </span>
            <span className={`num text-xs font-bold ${up ? "text-up" : "text-down"}`}>
              {r.spot != null ? nf(r.spot, r.spot < 100 ? 2 : 0) : "–"}
            </span>
            {(pts != null || r.chgPct != null) && (
              <span className={`num text-[9px] ${up ? "text-up" : "text-down"}`}>
                {pts != null ? `${up ? "+" : "−"}${nf(Math.abs(pts), 2)} ` : ""}
                {r.chgPct != null ? `(${nf(Math.abs(r.chgPct), 2)}%)` : ""}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** P&L card — top of the Positions / Orders tabs. Labels match Flattrade:
 *  MTM = P&L vs entry price; P&L = day M2M from the previous close. */
function MobileReturnCard() {
  const p = useBookPnl();
  const [open, setOpen] = useState(false);
  if (!p) return null;
  return (
    <div className="mx-2 mt-2 rounded-xl border border-term-border bg-term-panel px-3 py-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between"
      >
        <span className="text-xs uppercase tracking-wide text-term-dim">
          MTM {p.source === "paper" && <span className="text-[9px]">· paper</span>}
        </span>
        <span className="flex items-center gap-2">
          <span className={`num text-base font-bold ${signColor(p.today)}`}>₹{nf(p.today, 2)}</span>
          <span className="text-term-dim">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {open && (
        <div className="mt-2 flex items-start justify-between border-t border-term-border/60 pt-2">
          <span className="flex flex-col">
            <span className="text-2xs uppercase text-term-dim">Realized</span>
            <span className={`num text-sm font-semibold ${signColor(p.realized)}`}>
              ₹{nf(p.realized, 2)}
            </span>
          </span>
          <span className="flex flex-col items-end">
            <span className="text-2xs uppercase text-term-dim">Unrealized</span>
            <span className={`num text-sm font-semibold ${signColor(p.mtm)}`}>₹{nf(p.mtm, 2)}</span>
          </span>
        </div>
      )}
      <div className="mt-2 flex items-center justify-between border-t border-term-border/60 pt-2">
        <span className="text-xs uppercase tracking-wide text-term-dim">
          P&amp;L <span className="text-[9px] normal-case">· from prev close</span>
        </span>
        <span className={`num text-base font-bold ${signColor(p.dayPnl)}`}>₹{nf(p.dayPnl, 2)}</span>
      </div>
    </div>
  );
}
import { lockNow } from "../lib/auth";
import { Settings } from "./Settings";
import { NotificationPanel } from "./NotificationPanel";
import { OrderConfirm } from "./OrderConfirm";
import { Watchlist } from "./Watchlist";
import { ExpiryTabs } from "./ExpiryTabs";
import { OptionChain } from "./OptionChain";
import { ScripView } from "./ScripView";
import { TrendingOI } from "./TrendingOI";
import { ScannerView } from "./ScannerView";
import { Chart } from "./Chart";
import { StrategyBuilder } from "./StrategyBuilder";
import { PositionsView, OrdersTab } from "./PositionsView";
import { ScalpPanel } from "./ScalpPanel";
import { ScalpCharts } from "./ScalpCharts";
import { AutoBotView } from "./AutoBot";
import { Funds } from "./Funds";
import { LogoMark } from "./Logo";

type NavItem = { v: View; icon: string; label: string };

/** bottom tab bar — the 5 things you act on */
const BOTTOM_NAV: NavItem[] = [
  { v: "watchlist", icon: "★", label: "Watch" },
  { v: "orders", icon: "📜", label: "Orders" },
  { v: "positions", icon: "💼", label: "Pos" },
  { v: "scalper", icon: "⚡", label: "Scalp" },
  { v: "builder", icon: "🧱", label: "Build" },
];

/** top strip — the analysis views */
const TOP_NAV: NavItem[] = [
  { v: "chart", icon: "📈", label: "Chart" },
  { v: "scrip", icon: "▤", label: "OI" },
  { v: "scanner", icon: "📡", label: "Scan" },
  { v: "trendingoi", icon: "🔥", label: "Trend OI" },
  { v: "auto", icon: "🤖", label: "Auto" },
  { v: "funds", icon: "💰", label: "Funds" },
];

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
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <MobileIndexBand />
          <Watchlist />
        </div>
      );
    case "scrip":
      return <ScripView />;
    case "trendingoi":
      return <TrendingOI />;
    case "scanner":
      return <ScannerView />;
    case "chart":
      return <Chart />;
    case "scalper":
      // one vertical scroll: fixed-height chart on top, full panel (incl. the
      // open-positions list) below — the panel used to be crammed into 45% with
      // an inner flex-1 that collapsed to nothing on a phone.
      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="h-[46vh] shrink-0 border-b border-term-border">
            <ScalpCharts />
          </div>
          <div className="shrink-0">
            <ScalpPanel />
          </div>
        </div>
      );
    case "builder":
      return <StrategyBuilder />;
    case "positions":
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <MobileReturnCard />
          <PositionsView />
        </div>
      );
    case "orders":
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <OrdersTab />
        </div>
      );
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
  const notifOpen = useStore((s) => s.notifOpen);
  const openNotif = useStore((s) => s.openNotif);
  const closeNotif = useStore((s) => s.closeNotif);
  const alertsUnseen = useStore(
    (s) =>
      Math.max(0, s.alerts.length - s.alertsSeen) +
      Math.max(0, s.unusual.length - s.unusualSeen)
  );
  const [brokerOpen, setBrokerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
        <LogoMark size={22} />
        <TopIndices />
        <button
          onClick={() => setBrokerOpen((o) => !o)}
          className={`relative ml-auto shrink-0 rounded border px-1.5 py-1 text-[11px] ${
            brokerOpen ? "border-term-accent text-term-accent" : "border-term-border text-term-dim"
          }`}
          title="Broker · mode · alerts"
        >
          ⚿
          {alertsUnseen > 0 && !brokerOpen && (
            <span className="absolute -right-1.5 -top-1.5 min-w-[15px] rounded-full bg-down px-1 text-[9px] font-bold leading-4 text-white">
              {alertsUnseen}
            </span>
          )}
        </button>
      </div>

      {brokerOpen && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-term-border bg-term-panel2 px-2 py-1.5">
          <span className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-term-dim">
            Mode <OrderModePill />
          </span>
          <span className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-term-dim">
            Show <ClassFilter />
          </span>
          <BrokerPill />
          <UpstoxPill />
          <span className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-term-dim">
            Text <FontScale />
          </span>
          <button
            onClick={() => (notifOpen ? closeNotif() : openNotif())}
            className={`ml-auto rounded border px-2 py-1 text-2xs ${
              notifOpen
                ? "border-term-accent text-term-accent"
                : "border-term-border text-term-dim hover:text-term-text"
            }`}
            title="Alerts & unusual activity"
          >
            Alerts{alertsUnseen > 0 ? ` (${alertsUnseen})` : ""}
          </button>
          <button
            onClick={() => {
              setBrokerOpen(false);
              setSettingsOpen(true);
            }}
            className="rounded border border-term-border px-2 py-1 text-2xs text-term-dim hover:text-term-text"
            title="Settings"
          >
            ⚙ Settings
          </button>
          <button
            onClick={lockNow}
            className="rounded border border-term-border px-2 py-1 text-2xs text-term-dim hover:text-term-text"
            title="Lock the app — require the password / PIN again"
          >
            🔒 Lock
          </button>
        </div>
      )}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}

      <NotificationPanel />
      {/* ── top strip: analysis views (same layout as the bottom bar) ── */}
      <div className="flex border-b border-term-border bg-term-panel2">
        {TOP_NAV.map((n) => (
          <button
            key={n.v}
            onClick={() => setView(n.v)}
            className={`flex flex-1 flex-col items-center gap-0.5 border-b-2 py-1.5 ${
              view === n.v
                ? "border-term-accent bg-term-accent/15 font-semibold text-term-accent"
                : "border-transparent text-term-dim active:bg-term-border"
            }`}
          >
            <span className="text-[17px] leading-none">{n.icon}</span>
            <span className="text-[8px] uppercase tracking-wide">{n.label}</span>
          </button>
        ))}
      </div>

      {/* ── content ───────────────────────────────────────────── */}
      <main className="flex min-h-0 flex-1 flex-col overflow-auto">
        <MobileBody view={view} />
      </main>

      {/* ── bottom tab bar ────────────────────────────────────── */}
      <nav className="flex shrink-0 border-t border-term-border bg-term-panel2">
        {BOTTOM_NAV.map((n) => (
          <button
            key={n.v}
            onClick={() => setView(n.v)}
            className={`flex flex-1 flex-col items-center gap-0.5 border-t-2 py-1.5 ${
              view === n.v
                ? "border-term-accent bg-term-accent/15 font-semibold text-term-accent"
                : "border-transparent text-term-dim active:bg-term-border"
            }`}
          >
            <span className="text-[17px] leading-none">{n.icon}</span>
            <span className="text-[8px] uppercase tracking-wide">{n.label}</span>
          </button>
        ))}
      </nav>

      <OrderConfirm />
    </div>
  );
}
