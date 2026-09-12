import { useCallback, useEffect, useState } from "react";
import { useStore } from "./store";
import { Header } from "./components/Header";
import { HeaderMenu, MenuRow } from "./components/HeaderMenu";
import { applyFontScale } from "./components/FontScale";
import { Watchlist } from "./components/Watchlist";
import { ExpiryTabs } from "./components/ExpiryTabs";
import { OptionChain } from "./components/OptionChain";
import { OIProfile } from "./components/OIProfile";
import { ScripView } from "./components/ScripView";
import { Positions } from "./components/Positions";
import { ScannerView } from "./components/ScannerView";
import { TrendingOI } from "./components/TrendingOI";
import { TradeJournal } from "./components/TradeJournal";
import { Chart } from "./components/Chart";
import { StrategyBuilder } from "./components/StrategyBuilder";
import { PositionsView } from "./components/PositionsView";
import { ScalpPanel } from "./components/ScalpPanel";
import { ScalpCharts } from "./components/ScalpCharts";
import { OILadder } from "./components/OILadder";
import { AutoBotView } from "./components/AutoBot";
import { Funds } from "./components/Funds";
import { OrderConfirm } from "./components/OrderConfirm";
import { NotificationPanel } from "./components/NotificationPanel";
import { MobileShell } from "./components/MobileShell";
import { LoginGate } from "./components/LoginGate";
import { PinLock } from "./components/PinLock";
import { useIsMobile } from "./lib/useIsMobile";
import { VSplit, clamp, readNum } from "./components/VSplit";

const LS = {
  left: "layout.leftW",
  right: "layout.rightW",
  zoom: "layout.zoom",
  hideLeft: "layout.hideLeft",
  hideRight: "layout.hideRight",
  notifW: "layout.notifW",
};

export default function App() {
  return (
    // password gate FIRST — nothing (not even the device-PIN screen) renders
    // until the shared app password has been entered.
    <LoginGate>
      <PinLock>
        <Shell />
      </PinLock>
    </LoginGate>
  );
}

function Shell() {
  const init = useStore((s) => s.init);
  const isMobile = useIsMobile();
  useEffect(() => {
    applyFontScale();
    init();
  }, [init]);
  return isMobile ? <MobileShell /> : <DesktopShell />;
}

function DesktopShell() {
  const view = useStore((s) => s.view);

  const wide =
    view === "builder" ||
    view === "positions" ||
    view === "orders" ||
    view === "scrip" ||
    view === "trendingoi" ||
    view === "scanner" ||
    view === "auto" ||
    view === "funds" ||
    view === "journal";
  const [leftW, setLeftW] = useState(() => readNum(LS.left, 190));
  const [rightW, setRightW] = useState(() => readNum(LS.right, view === "scalper" ? 360 : 300));
  const [notifW, setNotifW] = useState(() => readNum(LS.notifW, 320));
  const [zoom, setZoom] = useState(() => readNum(LS.zoom, 100));

  const notifDock = useStore((s) => s.notifDock);
  const setNotifDock = useStore((s) => s.setNotifDock);

  useEffect(() => {
    try {
      localStorage.setItem(LS.left, String(leftW));
    } catch {}
  }, [leftW]);
  useEffect(() => {
    try {
      localStorage.setItem(LS.right, String(rightW));
    } catch {}
  }, [rightW]);
  useEffect(() => {
    try {
      localStorage.setItem(LS.zoom, String(zoom));
    } catch {}
  }, [zoom]);

  useEffect(() => {
    try {
      localStorage.setItem(LS.notifW, String(notifW));
    } catch {}
  }, [notifW]);

  const bumpLeft = useCallback((dx: number) => setLeftW((w) => clamp(w + dx, 140, 460)), []);
  const bumpRight = useCallback((dx: number) => setRightW((w) => clamp(w - dx, 220, 560)), []);
  const bumpNotif = useCallback((dx: number) => setNotifW((w) => clamp(w - dx, 250, 520)), []);
  const resetLayout = () => {
    setLeftW(190);
    setRightW(view === "scalper" ? 360 : 300);
    setZoom(100);
  };

  const [hideLeft, setHideLeft] = useState(() => localStorage.getItem(LS.hideLeft) === "1");
  const [hideRight, setHideRight] = useState(() => localStorage.getItem(LS.hideRight) === "1");
  useEffect(() => {
    try {
      localStorage.setItem(LS.hideLeft, hideLeft ? "1" : "0");
    } catch {}
  }, [hideLeft]);
  useEffect(() => {
    try {
      localStorage.setItem(LS.hideRight, hideRight ? "1" : "0");
    } catch {}
  }, [hideRight]);

  const showRight = !wide && !hideRight;
  const leftCols = hideLeft ? "0px" : `${leftW}px 4px`;
  const notifCols = notifDock ? ` 4px ${notifW}px` : "";
  const cols =
    (showRight
      ? `${leftCols} minmax(0,1fr) 4px ${rightW}px`
      : `${leftCols} minmax(0,1fr)`) + notifCols;

  return (
    <div className="relative flex h-full flex-col bg-term-bg text-term-text">
      <Header>
        <HeaderMenu icon="☰" title="Layout — panels & reset">
          <MenuRow onClick={() => setHideLeft((v) => !v)} active={!hideLeft}>
            <span>Watchlist panel</span>
            <span className="text-[10px] opacity-70">{hideLeft ? "Hidden" : "Shown"}</span>
          </MenuRow>
          {!wide && (
            <MenuRow onClick={() => setHideRight((v) => !v)} active={!hideRight}>
              <span>Right panel</span>
              <span className="text-[10px] opacity-70">{hideRight ? "Hidden" : "Shown"}</span>
            </MenuRow>
          )}
          <MenuRow onClick={() => setNotifDock(!notifDock)} active={notifDock}>
            <span>Alerts as right column</span>
            <span className="text-[10px] opacity-70">{notifDock ? "On" : "Off"}</span>
          </MenuRow>
          <div className="my-0.5 h-px bg-term-border" />
          <MenuRow onClick={resetLayout}>
            <span>Reset panels &amp; zoom</span>
            <span className="text-[10px] opacity-70">↺</span>
          </MenuRow>
        </HeaderMenu>
      </Header>
      <NotificationPanel />

      <div
        className="grid min-h-0 flex-1"
        style={
          {
            gridTemplateColumns: cols,
            zoom: zoom / 100,
          } as React.CSSProperties
        }
      >
        <aside className="min-h-0 overflow-hidden border-r border-term-border">
          {!hideLeft && <Watchlist />}
        </aside>

        {!hideLeft && <VSplit onDrag={bumpLeft} />}

        <main className="flex min-h-0 flex-col overflow-hidden">
          {view === "chain" && (
            <>
              <ExpiryTabs />
              <OptionChain />
            </>
          )}
          {view === "oiprofile" && <OIProfile />}
          {view === "scrip" && <ScripView />}
          {view === "trendingoi" && <TrendingOI />}
          {view === "scanner" && <ScannerView />}
          {view === "chart" && <Chart />}
          {view === "scalper" && <ScalpCharts />}
          {view === "builder" && <StrategyBuilder />}
          {view === "positions" && <PositionsView />}
          {view === "orders" && <PositionsView initialTab="orders" />}
          {view === "auto" && <AutoBotView />}
          {view === "funds" && <Funds />}
          {view === "journal" && <TradeJournal />}
        </main>

        {showRight && <VSplit onDrag={bumpRight} />}
        {showRight && (
          <aside className="min-h-0 overflow-hidden border-l border-term-border">
            {view === "scalper" ? <ScalpPanel /> : view === "chart" ? <OILadder /> : <Positions />}
          </aside>
        )}

        {notifDock && <VSplit onDrag={bumpNotif} />}
        {notifDock && (
          <aside className="min-h-0 overflow-hidden border-l border-term-border">
            <NotificationPanel docked />
          </aside>
        )}
      </div>
      <OrderConfirm />
    </div>
  );
}
