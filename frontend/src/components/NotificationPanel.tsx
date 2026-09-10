import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { hhmm } from "../lib/format";
import type { UnusualKind } from "../types";

const sevStyle: Record<string, string> = {
  critical: "border-l-down bg-down/10 text-down",
  warning: "border-l-amber-500 bg-amber-500/10 text-amber-400",
  info: "border-l-term-accent bg-term-accent/10 text-term-accent",
};

const kindStyle: Record<UnusualKind, string> = {
  DELTA_JUMP: "bg-term-accent/20 text-term-accent",
  GAMMA_SPIKE: "bg-amber-500/20 text-amber-400",
  GAMMA_COLLAPSE: "bg-down/20 text-down",
};
const kindLabel: Record<UnusualKind, string> = {
  DELTA_JUMP: "Δ JUMP",
  GAMMA_SPIKE: "Γ SPIKE",
  GAMMA_COLLAPSE: "Γ COLLAPSE",
};

export function NotificationPanel({ docked = false }: { docked?: boolean } = {}) {
  const {
    notifOpen,
    notifDock,
    notifTab,
    setNotifTab,
    setNotifDock,
    closeNotif,
    alerts,
    unusual,
    alertsSeen,
    unusualSeen,
    selectSymbol,
  } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  // sub-filter for the Unusual tab — "different windows" for spike / collapse / jump
  const [uKind, setUKind] = useState<"all" | UnusualKind>("all");

  // popover mode: close on outside click / Esc. docked mode: never auto-close.
  useEffect(() => {
    if (docked || !notifOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeNotif();
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && closeNotif();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [docked, notifOpen, closeNotif]);

  // keep the bell badge clear while the dock is visible (mark the active tab seen)
  useEffect(() => {
    if (docked) setNotifTab(notifTab);
  }, [docked, notifTab, alerts.length, unusual.length, setNotifTab]);

  if (docked ? !notifDock : !notifOpen) return null;

  const aNew = Math.max(0, alerts.length - alertsSeen);
  const uNew = Math.max(0, unusual.length - unusualSeen);
  const uCounts: Record<"all" | UnusualKind, number> = {
    all: unusual.length,
    GAMMA_SPIKE: unusual.filter((e) => e.kind === "GAMMA_SPIKE").length,
    GAMMA_COLLAPSE: unusual.filter((e) => e.kind === "GAMMA_COLLAPSE").length,
    DELTA_JUMP: unusual.filter((e) => e.kind === "DELTA_JUMP").length,
  };
  const uShown = uKind === "all" ? unusual : unusual.filter((e) => e.kind === uKind);

  return (
    <div
      ref={ref}
      className={
        docked
          ? "flex h-full w-full flex-col bg-term-panel"
          : "absolute right-3 top-12 z-[70] flex max-h-[75vh] w-[calc(100vw-1.5rem)] max-w-[400px] flex-col rounded-lg border border-term-border bg-term-panel shadow-2xl"
      }
    >
      <div className="flex items-center border-b border-term-border text-2xs">
        {(
          [
            ["unusual", "Unusual Activity", uNew],
            ["alerts", "Alerts", aNew],
          ] as const
        ).map(([k, label, n]) => (
          <button
            key={k}
            onClick={() => setNotifTab(k)}
            className={`flex items-center gap-1.5 px-3 py-2 ${
              notifTab === k
                ? "border-b-2 border-term-accent text-term-text"
                : "text-term-dim hover:text-term-text"
            }`}
          >
            {label}
            {n > 0 && (
              <span className="rounded-full bg-down px-1 text-[10px] font-bold leading-4 text-white">
                {n}
              </span>
            )}
          </button>
        ))}
        {docked ? (
          <button
            onClick={() => setNotifDock(false)}
            title="Undock — back to the pop-over"
            className="ml-auto px-3 py-2 text-term-dim hover:text-term-text"
          >
            ⇤ undock
          </button>
        ) : (
          <>
            <button
              onClick={() => setNotifDock(true)}
              title="Dock as a fixed side panel"
              className="ml-auto px-2 py-2 text-term-dim hover:text-term-text"
            >
              ⇥ dock
            </button>
            <button onClick={closeNotif} className="px-3 py-2 text-term-dim hover:text-term-text">
              ✕
            </button>
          </>
        )}
      </div>

      {notifTab === "unusual" && (
        <div className="flex flex-wrap items-center gap-1 border-b border-term-border/60 px-2 py-1.5 text-[10px]">
          {(
            [
              ["all", "All"],
              ["GAMMA_SPIKE", "Γ Spike"],
              ["GAMMA_COLLAPSE", "Γ Collapse"],
              ["DELTA_JUMP", "Δ Jump"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setUKind(k)}
              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${
                uKind === k
                  ? "border-term-accent bg-term-accent/15 text-term-text"
                  : "border-term-border text-term-dim hover:text-term-text"
              }`}
            >
              {label}
              <span className="num text-term-dim">{uCounts[k]}</span>
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {notifTab === "unusual" ? (
          uShown.length === 0 ? (
            <div className="p-4 text-2xs text-term-dim">
              {unusual.length === 0
                ? "No unusual Greeks activity. Fires when a near-ATM strike's delta or gamma moves sharply between polls."
                : "Nothing in this category right now."}
            </div>
          ) : (
            uShown.map((e, i) => (
              <button
                key={e.ts + e.strike + e.optionType + i}
                onClick={() => {
                  selectSymbol(e.symbol);
                  closeNotif();
                }}
                className="block w-full border-b border-term-border/40 border-l-2 border-l-amber-500 bg-amber-500/5 px-3 py-2 text-left text-2xs hover:bg-amber-500/10"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold">
                    {e.symbol} {e.strike.toFixed(0)}
                    {e.optionType}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`rounded px-1 text-[9px] font-bold ${kindStyle[e.kind]}`}>
                      {kindLabel[e.kind]}
                    </span>
                    <span className="num text-term-dim">{hhmm(e.ts)}</span>
                  </span>
                </div>
                <div className="num mt-0.5 text-term-text/90">
                  Δ {e.prevDelta.toFixed(2)} → {e.delta.toFixed(2)} ({e.dDelta >= 0 ? "+" : ""}
                  {e.dDelta.toFixed(2)}) · Γ {e.prevGamma.toFixed(4)} → {e.gamma.toFixed(4)}
                </div>
              </button>
            ))
          )
        ) : alerts.length === 0 ? (
          <div className="p-4 text-2xs text-term-dim">
            No alerts. Fires on IV pops, straddle expansion, and rising gamma-blast scores.
          </div>
        ) : (
          alerts.map((a, i) => (
            <div
              key={a.ts + a.kind + i}
              className={`border-b border-term-border/40 border-l-2 px-3 py-2 text-2xs ${
                sevStyle[a.severity] ?? ""
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold">{a.symbol}</span>
                <span className="num text-term-dim">{hhmm(a.ts)}</span>
              </div>
              <div className="text-term-text/90">{a.message}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
