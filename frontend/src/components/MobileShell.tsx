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
  LegRuleBell,
  useBookPnl,
} from "./Header";

/** NIFTY + SENSEX, ultra-compact — sits next to the GT mark, fits a folded Fold 6 */
function TopIndices() {
  const [rows, setRows] = useState<
    { symbol: string; spot: number | null; chgPct: number | null; chgPts?: number | null }[]
  >([]);
  // last real value per symbol — a poll that returns null must not blank the
  // chip (that flicker between "–" and the price is what users notice)
  const lastRef = useRef<Record<string, { spot: number; chgPct: number | null; chgPts: number | null }>>({});
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
        if (r.spot != null)
          lastRef.current[r.symbol] = { spot: r.spot, chgPct: r.chgPct, chgPts: r.chgPts ?? null };
        const last = lastRef.current[r.symbol];
        const spot = r.spot ?? last?.spot ?? null;
        const chgPct = r.chgPct ?? last?.chgPct ?? null;
        let chgPts = r.chgPts ?? last?.chgPts ?? null;
        if (chgPts == null && chgPct != null && spot != null) chgPts = spot - spot / (1 + chgPct / 100);
        const up = (chgPct ?? chgPts ?? 0) >= 0;
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
                chgPct == null && chgPts == null ? "invisible" : up ? "text-up" : "text-down"
              }`}
            >
              {up ? "▲" : "▼"}
              {chgPts != null ? nf(Math.abs(chgPts), Math.abs(chgPts) < 100 ? 1 : 0) : "0"}
              {chgPct != null ? ` (${nf(Math.abs(chgPct), 2)}%)` : ""}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** current symbol's PCR + its change since this chip first saw it (session
 *  baseline, resets on a symbol switch) — desktop shows this in the header
 *  on every tab (Header.tsx's "zone 2" stats); mobile had no equivalent
 *  persistent spot for it, so it was only reachable by opening OI Profile. */
function PcrChip() {
  const chain = useStore((s) => s.chain);
  const baseRef = useRef<{ symbol: string; pcr: number } | null>(null);
  if (chain?.symbol && chain.pcr != null && baseRef.current?.symbol !== chain.symbol) {
    baseRef.current = { symbol: chain.symbol, pcr: chain.pcr };
  }
  if (!chain || chain.pcr == null) return null;
  const base = baseRef.current?.symbol === chain.symbol ? baseRef.current.pcr : chain.pcr;
  const chg = chain.pcr - base;
  return (
    <span
      className="flex shrink-0 items-baseline gap-1 rounded border border-term-border bg-term-bg/60 px-1.5 py-0.5"
      title={`${chain.symbol} put/call OI ratio — ${chg === 0 ? "unchanged" : chg > 0 ? "rising" : "falling"} since this screen opened`}
    >
      <span className="text-[8px] font-semibold uppercase tracking-tight text-term-dim">PCR</span>
      <span className={`num text-[11px] font-semibold leading-none ${chain.pcr >= 1 ? "text-up" : "text-down"}`}>
        {nf(chain.pcr, 2)}
      </span>
      <span className={`num text-[8px] leading-none ${chg === 0 ? "invisible" : chg > 0 ? "text-up" : "text-down"}`}>
        {chg >= 0 ? "▲" : "▼"}
        {nf(Math.abs(chg), 2)}
      </span>
    </span>
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
import { FlowView } from "./Flow";
import { OrderFlowView } from "./OrderFlow";
import { TrendingOI } from "./TrendingOI";
import { ScannerView } from "./ScannerView";
import { Chart } from "./Chart";
import { OIProfile } from "./OIProfile";
import { StrategyBuilder } from "./StrategyBuilder";
import { PositionsView, OrdersTab } from "./PositionsView";
import { ScalpPanel } from "./ScalpPanel";
import { ScalpCharts } from "./ScalpCharts";
import { AutoBotView } from "./AutoBot";
import { Funds } from "./Funds";
import { TradeJournal } from "./TradeJournal";
import { VolatilityView } from "./VolatilityView";
import { LogoMark } from "./Logo";

/** Top and bottom tab bars — direct shortcuts to the 8 views checked most
 *  often on the phone, requested explicitly in place of the 4-group
 *  landing-page nav (which still exists -- Chart.tsx's own Chain/OI/Trend
 *  OI/OI Profile switcher and each view's own internal navigation still
 *  reach everything else; these are just the fast one-tap paths). */
const TOP_NAV: { v: View; label: string }[] = [
  { v: "scrip", label: "OI" },
  { v: "trendingoi", label: "Trend OI" },
  { v: "flow", label: "Flow" },
  { v: "orderflow", label: "OrderFlow" },
  { v: "vol", label: "Vol" },
  { v: "scanner", label: "Screener" },
  { v: "auto", label: "Auto" },
  { v: "builder", label: "Build" },
  { v: "chart", label: "Chart" },
  { v: "scalper", label: "Scalp" },
  { v: "journal", label: "Journal" },
];
const tabCls = (active: boolean) =>
  `rounded border text-[11px] font-semibold ${
    active
      ? "border-term-accent/50 bg-term-accent/15 text-term-accent"
      : "border-term-dim/70 bg-term-border/40 text-term-dim active:bg-term-border"
  }`;

/** all tabs on ONE row that swipes sideways (was 3 wrapped rows, ~68px of
 *  chart/data lost on a 375px phone). Fades mark the edges that have more
 *  tabs behind them; on a screen wide enough for all of them (an unfolded
 *  Fold) they grow to fill the row instead. */
function ScrollTabs({ view, setView }: { view: View; setView: (v: View) => void }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  const measure = () => {
    const el = rowRef.current;
    if (!el) return;
    setEdge({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    });
  };
  // centre the selected tab — a switch from elsewhere (bottom bar, Chart's
  // own view switcher) can land on one that's scrolled off, and an edge
  // position would sit under the fade. (scrollTo, not scrollIntoView, which
  // would also scroll the page's ancestors; instant while the app is in the
  // background, where a smooth scroll never animates and stays put.)
  useEffect(() => {
    const row = rowRef.current;
    const el = row?.querySelector<HTMLElement>(`[data-v="${view}"]`);
    if (row && el)
      row.scrollTo({
        left: el.offsetLeft - (row.clientWidth - el.offsetWidth) / 2,
        behavior: document.hidden ? "auto" : "smooth",
      });
    measure();
  }, [view]);
  // the row's own size, not window resize — covers fold/unfold and rotation
  useEffect(() => {
    const el = rowRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <nav className="relative shrink-0 border-b border-term-border bg-term-panel2">
      <div
        ref={rowRef}
        onScroll={measure}
        className="no-scrollbar flex items-center gap-1 overflow-x-auto px-1.5 py-1.5"
      >
        {TOP_NAV.map((n) => (
          <button
            key={n.v}
            data-v={n.v}
            onClick={() => setView(n.v)}
            className={`shrink-0 grow whitespace-nowrap px-2.5 py-1.5 ${tabCls(view === n.v)}`}
          >
            {n.label}
          </button>
        ))}
      </div>
      {edge.left && (
        <span className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-term-panel2 to-transparent" />
      )}
      {edge.right && (
        <span className="pointer-events-none absolute inset-y-0 right-0 flex w-8 items-center justify-end bg-gradient-to-l from-term-panel2 via-term-panel2/80 to-transparent pr-1 text-xs font-bold text-term-dim">
          ›
        </span>
      )}
    </nav>
  );
}

/** four-corners glyph as SVG — the ⛶ character is missing from some Android fonts */
function FullIcon({ exit }: { exit?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d={
          exit
            ? "M6 1.5V6H1.5M10 1.5V6h4.5M6 14.5V10H1.5M10 14.5V10h4.5"
            : "M1.5 6V1.5H6M10 1.5h4.5V6M1.5 10v4.5H6M14.5 10v4.5H10"
        }
      />
    </svg>
  );
}

const BOTTOM_NAV: { v: View; icon: string; label: string }[] = [
  { v: "watchlist", icon: "★", label: "Watchlist" },
  { v: "orders", icon: "📋", label: "Orders" },
  { v: "positions", icon: "💼", label: "Position" },
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
    case "flow":
      return <FlowView />;
    case "orderflow":
      return <OrderFlowView />;
    case "vol":
      return <VolatilityView />;
    case "oiprofile":
      return <OIProfile />;
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
          <div className="flex min-h-[46vh] shrink-0 flex-col border-b border-term-border">
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
    case "journal":
      return <TradeJournal />;
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

  // full screen on Chart / Scalp: the top bar, tab row and bottom bar go away
  const [full, setFull] = useState(false);
  const fullOk = view === "chart" || view === "scalper";
  const isFull = full && fullOk;
  useEffect(() => {
    if (!fullOk) setFull(false); // left via the chart's own view switcher
  }, [fullOk]);
  // the phone's Back button (and browser back) leaves full screen rather than
  // the app: entering pushes a history entry, Back pops it
  useEffect(() => {
    if (!isFull) return;
    window.history.pushState({ gtFull: true }, "");
    const onPop = () => setFull(false);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // left by the button or a view switch, not Back — drop the entry we pushed
      if (window.history.state?.gtFull) window.history.back();
    };
  }, [isFull]);

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
      {!isFull && (
        <>
          {/* ── top bar ─────────────────────────────────────────── */}
          <div
            className={`flex items-center gap-1.5 border-b bg-term-panel px-1.5 py-1.5 ${
              orderMode === "live" ? "border-down" : "border-term-border"
            }`}
          >
            <LogoMark size={22} />
            <TopIndices />
            <PcrChip />
            {fullOk && (
              <button
                onClick={() => {
                  setBrokerOpen(false);
                  setFull(true);
                }}
                className="shrink-0 rounded border border-term-dim/70 px-1.5 py-1 text-term-dim"
                title="Full screen — hide the bars (Back or the corner button brings them back)"
              >
                <FullIcon />
              </button>
            )}
            <button
              onClick={() => setBrokerOpen((o) => !o)}
              className={`relative ml-auto shrink-0 rounded border px-1.5 py-1 text-[11px] ${
                brokerOpen ? "border-term-accent text-term-accent" : "border-term-dim/70 text-term-dim"
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

          {/* ── top tab row — ONE row, however many tabs there are ──── */}
          <ScrollTabs view={view} setView={setView} />

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
              <LegRuleBell />
              <button
                onClick={() => (notifOpen ? closeNotif() : openNotif())}
                className={`ml-auto rounded border px-2 py-1 text-2xs ${
                  notifOpen
                    ? "border-term-accent text-term-accent"
                    : "border-term-dim/70 text-term-dim hover:text-term-text"
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
                className="rounded border border-term-dim/70 px-2 py-1 text-2xs text-term-dim hover:text-term-text"
                title="Settings"
              >
                ⚙ Settings
              </button>
              <button
                onClick={lockNow}
                className="rounded border border-term-dim/70 px-2 py-1 text-2xs text-term-dim hover:text-term-text"
                title="Lock the app — require the password / PIN again"
              >
                🔒 Lock
              </button>
            </div>
          )}
        </>
      )}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}

      <NotificationPanel />

      {/* ── content ───────────────────────────────────────────── */}
      <main className="flex min-h-0 flex-1 flex-col overflow-auto">
        <MobileBody view={view} />
      </main>

      {isFull && (
        <button
          onClick={() => setFull(false)}
          className="fixed z-40 rounded-full border border-term-dim/70 bg-term-panel/85 p-2 text-term-text shadow-lg"
          style={{
            right: "calc(env(safe-area-inset-right) + 6px)",
            bottom: "calc(env(safe-area-inset-bottom) + 6px)",
          }}
          title="Exit full screen"
        >
          <FullIcon exit />
        </button>
      )}

      {/* ── bottom tab bar ────────────────────────────────────── */}
      {!isFull && (
        <nav className="flex shrink-0 border-t border-term-border bg-term-panel2">
          {BOTTOM_NAV.map((n) => {
            const active = view === n.v;
            return (
              <button
                key={n.v}
                onClick={() => setView(n.v)}
                className={`flex flex-1 flex-col items-center gap-0.5 border-t-2 py-1.5 ${
                  active
                    ? "border-term-accent bg-term-accent/15 font-semibold text-term-accent"
                    : "border-term-border bg-term-border/25 text-term-dim active:bg-term-border"
                }`}
              >
                <span className="text-[17px] leading-none">{n.icon}</span>
                <span className="text-[8px] uppercase tracking-wide">{n.label}</span>
              </button>
            );
          })}
        </nav>
      )}

      <OrderConfirm />
    </div>
  );
}
