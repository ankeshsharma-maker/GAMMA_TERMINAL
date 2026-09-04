import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "./store";
import { Header } from "./components/Header";
import { Watchlist } from "./components/Watchlist";
import { ExpiryTabs } from "./components/ExpiryTabs";
import { OptionChain } from "./components/OptionChain";
import { OIProfile } from "./components/OIProfile";
import { ScripView } from "./components/ScripView";
import { Positions } from "./components/Positions";
import { ScannerView } from "./components/ScannerView";
import { Alerts } from "./components/Alerts";
import { Chart } from "./components/Chart";
import { StrategyBuilder } from "./components/StrategyBuilder";
import { PositionsView } from "./components/PositionsView";
import { ScalpPanel } from "./components/ScalpPanel";
import { OrderConfirm } from "./components/OrderConfirm";
import { NotificationPanel } from "./components/NotificationPanel";

const LS = {
  left: "layout.leftW",
  right: "layout.rightW",
  zoom: "layout.zoom",
};
const readNum = (k: string, d: number) => {
  try {
    const v = parseFloat(localStorage.getItem(k) || "");
    return Number.isFinite(v) ? v : d;
  } catch {
    return d;
  }
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** vertical drag handle that resizes a neighbouring column */
function VSplit({ onDrag }: { onDrag: (dx: number) => void }) {
  const last = useRef<number | null>(null);
  const down = (e: React.MouseEvent) => {
    e.preventDefault();
    last.current = e.clientX;
    const move = (ev: MouseEvent) => {
      if (last.current == null) return;
      onDrag(ev.clientX - last.current);
      last.current = ev.clientX;
    };
    const up = () => {
      last.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
  };
  return (
    <div
      onMouseDown={down}
      className="z-10 w-1 shrink-0 cursor-col-resize bg-term-border transition-colors hover:bg-term-accent"
      title="Drag to resize panel"
    />
  );
}

export default function App() {
  const init = useStore((s) => s.init);
  const view = useStore((s) => s.view);
  useEffect(() => {
    init();
  }, [init]);

  const wide = view === "builder" || view === "positions" || view === "scrip";
  const [leftW, setLeftW] = useState(() => readNum(LS.left, 190));
  const [rightW, setRightW] = useState(() => readNum(LS.right, view === "scalper" ? 360 : 300));
  const [zoom, setZoom] = useState(() => readNum(LS.zoom, 100));

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

  const bumpLeft = useCallback((dx: number) => setLeftW((w) => clamp(w + dx, 140, 460)), []);
  const bumpRight = useCallback((dx: number) => setRightW((w) => clamp(w - dx, 220, 560)), []);
  const resetLayout = () => {
    setLeftW(190);
    setRightW(view === "scalper" ? 360 : 300);
    setZoom(100);
  };

  const showRight = !wide;
  const cols = showRight
    ? `${leftW}px 4px minmax(0,1fr) 4px ${rightW}px`
    : `${leftW}px 4px minmax(0,1fr)`;

  return (
    <div className="relative flex h-full flex-col bg-term-bg text-term-text">
      <Header />
      <NotificationPanel />

      {/* layout controls */}
      <div className="flex items-center gap-2 border-b border-term-border bg-term-panel2 px-3 py-1 text-[10px] text-term-dim">
        <span className="uppercase tracking-wide">Layout</span>
        <span>Zoom</span>
        <button className="btn px-1.5 py-0" onClick={() => setZoom((z) => clamp(z - 5, 70, 160))}>
          −
        </button>
        <span className="num w-9 text-center text-term-text">{zoom}%</span>
        <button className="btn px-1.5 py-0" onClick={() => setZoom((z) => clamp(z + 5, 70, 160))}>
          +
        </button>
        <button className="btn ml-2 px-2 py-0" onClick={resetLayout}>
          Reset
        </button>
        <span className="ml-auto hidden sm:inline">drag the dividers to stretch panels</span>
      </div>

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
          <Watchlist />
        </aside>

        <VSplit onDrag={bumpLeft} />

        <main className="flex min-h-0 flex-col overflow-hidden">
          {view === "chain" && (
            <>
              <ExpiryTabs />
              <OptionChain />
            </>
          )}
          {view === "oiprofile" && <OIProfile />}
          {view === "scrip" && <ScripView />}
          {view === "scanner" && <ScannerView />}
          {(view === "chart" || view === "scalper") && <Chart />}
          {view === "builder" && <StrategyBuilder />}
          {view === "positions" && <PositionsView />}
        </main>

        {showRight && <VSplit onDrag={bumpRight} />}
        {showRight && (
          <aside className="min-h-0 overflow-hidden border-l border-term-border">
            {view === "scanner" ? <Alerts /> : view === "scalper" ? <ScalpPanel /> : <Positions />}
          </aside>
        )}
      </div>
      <OrderConfirm />
    </div>
  );
}
