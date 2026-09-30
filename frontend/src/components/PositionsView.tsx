import { useEffect, useRef, useState, type ReactNode } from "react";
import { attachWhenFilled, useStore } from "../store";
import { playOrderSound } from "../lib/soundNotif";
import { api } from "../lib/api";
import { nf, signColor, sk } from "../lib/format";
import { StopEditor } from "./StopEditor";
import { useLiveMtm } from "../lib/useLiveMtm";
import { isViewer } from "../lib/auth";
import { useIsMobile } from "../lib/useIsMobile";
import { LegBracketBadge, findBracket, type LegRule } from "./LegBracketBadge";
import { ScenarioGrid } from "./ScenarioGrid";
import { PortfolioSummary } from "./PortfolioSummary";
import { AutoSquareOff } from "./AutoSquareOff";
import { ShortGuard, guardText } from "./ShortGuard";
import { Positions as PaperPositions } from "./Positions";
import type { ShortGuardLeg } from "../types";
import { Capacitor } from "@capacitor/core";

/** open-position card text: 2px smaller in the phone app (asked 28-Sep), the website keeps its sizes */
/** the phone app: position cards exactly like Flattrade's (3 lines, nothing else); a tap opens the
 *  BUY / SELL sheet, which also carries Exit, + SL / TGT and the short-strike warning (asked 28-Sep).
 *  ("preview.app" = 1 in localStorage shows the same in a browser, for previews) */
const APP = (() => {
  try {
    return Capacitor.isNativePlatform() || localStorage.getItem("preview.app") === "1";
  } catch {
    return Capacitor.isNativePlatform();
  }
})();

const FS = Capacitor.isNativePlatform()
  ? { line: "text-[12px]", name: "text-[14px]", pct: "text-[13px]" }
  : { line: "text-[14px]", name: "text-[16px]", pct: "text-[15px]" };

type Tab = "broker" | "holdings" | "orders" | "advanced";
// Positions / Holdings read like the Flattrade app's Portfolio screen; the
// risk tools (portfolio Greeks + hedge, short-strike guard, scenario grid,
// auto square-off) live together under "Advanced"
const TABS: [Tab, string][] = [
  ["broker", "Positions"],
  ["holdings", "Holdings"],
  ["orders", "Orders"],
  ["advanced", "Advanced"],
];

/** Noren product code -> the name the broker app shows */
const PRD: Record<string, string> = { M: "NRML", I: "MIS", C: "CNC", H: "CO", B: "BO" };
const PNL_MODE_LS = "positions.pnlMode";

const n = (v: any) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="p-6 text-center text-xs text-term-dim">{children}</div>;
}

function TH({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-r border-term-border px-3 py-1.5 text-left font-medium last:border-r-0">
      {children}
    </th>
  );
}
function TD({ children, cls = "" }: { children: React.ReactNode; cls?: string }) {
  return (
    <td className={`border-b border-r border-term-border/50 px-3 py-1.5 last:border-r-0 ${cls}`}>
      {children}
    </td>
  );
}

// ---------------- Broker positions ----------------
function BrokerTab({ onCount }: { onCount?: (n: number) => void }) {
  const broker = useStore((s) => s.broker);
  const { mark } = useLiveMtm();
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const loadRef = useRef<() => void>(() => {});
  // the MTM | P&L switch, as in the broker app (remembered on this device)
  const [mode, setModeState] = useState<"mtm" | "pnl">(() => {
    try {
      return localStorage.getItem(PNL_MODE_LS) === "mtm" ? "mtm" : "pnl";
    } catch {
      return "pnl";
    }
  });
  const setMode = (m: "mtm" | "pnl") => {
    setModeState(m);
    try {
      localStorage.setItem(PNL_MODE_LS, m);
    } catch {
      /* ignore */
    }
  };
  // tapping a card opens its actions (target / SL, select, square off)
  const [openKey, setOpenKey] = useState<string | null>(null);
  // press and hold a card (~0.7 s): the Flattrade-style BUY / SELL sheet for that contract
  const [sheet, setSheet] = useState<{ r: any; avg: number; pnl: number } | null>(null);
  const pressT = useRef<number | null>(null);
  const pressFired = useRef(false);
  const pressXY = useRef<[number, number] | null>(null);
  const cancelPress = () => {
    if (pressT.current) window.clearTimeout(pressT.current);
    pressT.current = null;
  };
  useEffect(() => onCount?.(rows.length), [rows.length, onCount]);

  // the short-strike guard's read of each short leg, keyed by trading symbol --
  // shown on the card itself so a warning is seen where the trade is managed
  const [guard, setGuard] = useState<Record<string, ShortGuardLeg>>({});

  // per-position target/SL brackets (leg rules attached to an already-open position)
  const [legRules, setLegRules] = useState<LegRule[]>([]);
  const loadLegRules = () =>
    api.legRules().then((d) => setLegRules((d.rules || []) as LegRule[]), () => {});

  useEffect(() => {
    if (!broker?.authed) return;
    let alive = true;
    const load = () => {
      api.brokerPositions().then(
        (d) => alive && (setRows(d.positions || []), setErr(null)),
        (e) => alive && setErr(String(e.message || e))
      );
      loadLegRules();
      api.shortGuard().then(
        (d) =>
          alive &&
          setGuard(Object.fromEntries(d.legs.filter((l) => l.src === "live" && l.name).map((l) => [l.name as string, l]))),
        () => {}
      );
    };
    loadRef.current = load;
    load();
    const t = setInterval(load, 5000);
    // back from a locked phone: fresh positions now, not at the next 5 s tick
    window.addEventListener("gt-resume", load);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("gt-resume", load);
    };
  }, [broker?.authed]);

  if (!broker?.authed) return <Empty>Connect Flattrade (header) to see live broker positions.</Empty>;
  if (err) return <Empty>{err}</Empty>;

  let totalMtm = 0;
  let totalRealized = 0;
  let totalDay = 0;
  const withPnl = rows.map((r) => {
    const mtm = mark(r) ?? n(r.urmtom) ?? n(r.mtm) ?? 0;
    const rpnl = n(r.rpnl) ?? 0;
    const day = Number.isFinite(+r._dayPnl) ? +r._dayPnl : rpnl + (n(r.urmtom) ?? 0);
    totalMtm += mtm;
    totalRealized += rpnl;
    totalDay += day;
    return { r, mtm, rpnl, day, today: mtm + rpnl, key: String(r.tsym ?? r.symname ?? "") };
  });
  const totalToday = totalMtm + totalRealized;
  // Buy / Sell / Net value like the broker app: traded value, carry-forward included
  const amt = (r: any, side: "buy" | "sell") =>
    n(r[`tot${side}amt`]) ?? (n(r[`day${side}amt`]) ?? 0) + (n(r[`cf${side}amt`]) ?? 0);
  const buyVal = rows.reduce((s, r) => s + amt(r, "buy"), 0);
  const sellVal = rows.reduce((s, r) => s + amt(r, "sell"), 0);
  const allKeys = withPnl.map((w) => w.key).filter(Boolean);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(allKeys));
  const toggleOne = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const withBusy = async (key: string, fn: () => Promise<unknown>) => {
    setBusy((b) => new Set(b).add(key));
    try {
      await fn();
      loadRef.current();
    } catch (e: any) {
      alert(String(e?.message || e));
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(key);
        return next;
      });
    }
  };

  const squareOff = (r: any) => {
    const qty = n(r.netqty) ?? 0;
    if (!qty) return;
    if (!window.confirm(`Square off ${r.tsym} — real MARKET order for ${Math.abs(qty)} qty. Continue?`))
      return;
    withBusy(r.tsym, () =>
      api.brokerSquareOff({ tsym: r.tsym, exch: r.exch || "NFO", qty, prd: r.prd })
    );
  };

  const squareOffAll = () => {
    const targets = withPnl.filter((w) => (n(w.r.netqty) ?? 0) !== 0);
    if (!targets.length) return;
    if (
      !window.confirm(
        `SQUARE OFF ALL ${targets.length} open position(s) — this places ${targets.length} real MARKET order(s) right now. This cannot be undone. Continue?`
      )
    )
      return;
    targets.forEach(({ r }) =>
      withBusy(r.tsym, () =>
        api.brokerSquareOff({ tsym: r.tsym, exch: r.exch || "NFO", qty: n(r.netqty) ?? 0, prd: r.prd })
      )
    );
    setSelected(new Set());
  };

  const squareOffSelected = () => {
    const targets = withPnl.filter((w) => selected.has(w.key) && (n(w.r.netqty) ?? 0) !== 0);
    if (!targets.length) return;
    if (
      !window.confirm(
        `Square off ${targets.length} selected position(s) — this places ${targets.length} real MARKET order(s). Continue?`
      )
    )
      return;
    targets.forEach(({ r }) =>
      withBusy(r.tsym, () =>
        api.brokerSquareOff({ tsym: r.tsym, exch: r.exch || "NFO", qty: n(r.netqty) ?? 0, prd: r.prd })
      )
    );
    setSelected(new Set());
  };

  // MTM = vs the entry price, P&L = day M2M from the previous close (the
  // labels the Flattrade app uses -- same as the phone's MTM card)
  const total = mode === "mtm" ? totalToday : totalDay;
  const anyOpen = withPnl.some((w) => (n(w.r.netqty) ?? 0) !== 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-term-bg p-2 md:p-3">
      {/* MTM | P&L + the book total */}
      <div className="flex items-center justify-between gap-3 rounded-lg bg-term-panel px-4 py-2.5">
        <div className="flex overflow-hidden rounded-lg border border-term-dim/60">
          {(
            [
              ["mtm", "MTM"],
              ["pnl", "P&L"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setMode(k)}
              className={`px-3 py-0.5 text-[12px] ${
                mode === k ? "rounded-lg bg-term-accent text-white" : "text-term-text"
              }`}
              title={k === "mtm" ? "Profit / loss against your entry price" : "Day M2M from the previous close"}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="min-w-0 text-right">
          <div className={`tabular-nums truncate text-[16px] font-medium leading-tight ${signColor(total)}`}>
            {nf(total, 2)}
          </div>
          <div className="mt-0.5 flex items-center justify-end gap-1.5 text-[10px] text-term-dim">
            <span className="num">
              realised <span className={signColor(totalRealized)}>{nf(totalRealized, 2)}</span>
            </span>
            <span
              className={`h-1.5 w-1.5 rounded-full ${broker?.wsConnected ? "bg-up" : "animate-pulse bg-amber-500"}`}
              title={
                broker?.wsConnected
                  ? "Live tick feed connected — MTM re-marks on every tick"
                  : "Live tick feed down — MTM is on the ~4s REST poll instead of tick-by-tick (Flattrade WS disconnected, e.g. another session using the same login)"
              }
            />
          </div>
        </div>
      </div>

      {/* Buy / Sell / Net value */}
      <div className="grid grid-cols-3 rounded-lg bg-term-panel px-4 py-2.5">
        {(
          [
            ["Buy Value", buyVal, "text-left"],
            ["Sell Value", sellVal, "text-center"],
            ["Net Value", buyVal - sellVal, "text-right"],
          ] as const
        ).map(([label, v, align]) => (
          <div key={label} className={align}>
            <div className="text-[15px] text-term-text">{label}</div>
            <div className="tabular-nums mt-0.5 text-[15px] text-term-text">{nf(v, 2)}</div>
          </div>
        ))}
      </div>

      {/* bulk square-off (kept from before) */}
      {anyOpen && (
        <div className="flex flex-wrap items-center gap-2 px-1 text-2xs">
          <button
            className="btn btn-sell font-semibold"
            onClick={squareOffAll}
            title="Flatten every open position in one click, no selection needed"
          >
            ⚡ Square off ALL
          </button>
          {selected.size > 0 && (
            <button className="btn btn-sell" onClick={squareOffSelected}>
              Square off selected ({selected.size})
            </button>
          )}
          <label className="ml-auto flex items-center gap-1.5 text-[10px] text-term-dim">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            select all
          </label>
        </div>
      )}

      {withPnl.length === 0 && (
        <div className="rounded-lg bg-term-panel px-3 py-6 text-center text-xs text-term-dim">
          No positions today.
        </div>
      )}

      {/* position cards -- the broker app's layout; tap one for its actions */}
      <div className="grid gap-2 lg:grid-cols-2 2xl:grid-cols-3">
        {withPnl.map(({ r, today, day, key }, i) => {
          const qty = n(r.netqty) ?? 0;
          const isBusy = busy.has(r.tsym);
          const avg = qty ? n(r.netavgprc) ?? n(r.daybuyavgprc) ?? n(r.daysellavgprc) ?? 0 : 0;
          const lp = n(r.lp);
          const pnl = mode === "mtm" ? today : day;
          // the trade's return on its price: a short gains when the price falls,
          // so its sign flips (-22% on a winning short read like a loss)
          const pct = avg && lp != null ? ((lp - avg) / avg) * 100 * (qty < 0 ? -1 : 1) : 0;
          const closed = !qty;
          const sel = selected.has(key);
          const open = openKey === key;
          const prd = r.s_prdt_ali ?? PRD[String(r.prd ?? "")] ?? r.prd ?? "NRML";
          return (
            <div
              key={key || i}
              onPointerDown={(e) => {
                pressFired.current = false;
                pressXY.current = [e.clientX, e.clientY];
                cancelPress();
                pressT.current = window.setTimeout(() => {
                  pressFired.current = true;
                  pressT.current = null;
                  try {
                    navigator.vibrate?.(30);
                  } catch {
                    /* no vibration */
                  }
                  setSheet({ r, avg, pnl });
                }, 700);
              }}
              onPointerMove={(e) => {
                const p = pressXY.current;
                if (p && Math.hypot(e.clientX - p[0], e.clientY - p[1]) > 10) cancelPress(); // a scroll, not a hold
              }}
              onPointerUp={cancelPress}
              onPointerLeave={cancelPress}
              onPointerCancel={cancelPress}
              onContextMenu={(e) => e.preventDefault()}
              onClick={() => {
                if (pressFired.current) {
                  pressFired.current = false; // the hold opened the sheet; don't also toggle the card
                  return;
                }
                if (APP) return setSheet({ r, avg, pnl }); // the app: a tap opens the sheet, like Flattrade
                setOpenKey(open ? null : key);
              }}
              title="Tap for actions · press and hold to BUY / SELL"
              className={`cursor-pointer select-none rounded-lg bg-term-panel px-4 py-2.5 ${
                sel ? "ring-1 ring-term-accent" : ""
              }`}
            >
              <div className={`flex items-baseline justify-between gap-2 ${FS.line}`}>
                <span className="flex items-center gap-2 text-term-text">
                  {prd} | {r.exch ?? "NFO"}
                  {/* exit right from the card -- no need to open it first (the app: in the tap sheet) */}
                  {!!qty && !APP && (
                    <button
                      disabled={isBusy}
                      onClick={(e) => {
                        e.stopPropagation();
                        squareOff(r);
                      }}
                      className="rounded border border-down/60 bg-down/10 px-2 py-0.5 text-[11px] font-semibold leading-none text-down disabled:opacity-30"
                      title="Exit this position with an opposite-side MARKET order"
                    >
                      {isBusy ? "…" : "Exit"}
                    </button>
                  )}
                </span>
                <span className="tabular-nums whitespace-nowrap">
                  <span className="text-term-dim">{mode === "mtm" ? "MTM" : "P&L"} : </span>
                  <span className={signColor(pnl)}>{nf(pnl, 2)}</span>
                </span>
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-2">
                <span className={`truncate ${FS.name} text-term-text`}>
                  {r.dname ?? r.tsym ?? r.symname ?? "—"}
                </span>
                {!closed && (
                  <span className={`tabular-nums whitespace-nowrap ${FS.pct} ${signColor(pct)}`}>
                    ({pct > 0 ? "+" : ""}
                    {nf(pct, 2)} %)
                  </span>
                )}
              </div>
              <div className={`mt-1 flex items-baseline justify-between gap-2 ${FS.line}`}>
                {closed ? (
                  // a closed leg: what it booked, not "Qty 0 · Price 0.00"
                  <span className="tabular-nums whitespace-nowrap text-term-dim">
                    Closed · booked <span className={signColor(n(r.rpnl) ?? 0)}>{nf(n(r.rpnl) ?? 0, 2)}</span>
                  </span>
                ) : (
                <span className="tabular-nums flex gap-4 whitespace-nowrap">
                  <span className={qty > 0 ? "text-up" : qty < 0 ? "text-down" : "text-term-dim"}>
                    Qty : {qty}
                  </span>
                  <span>
                    <span className="text-term-dim">Price : </span>
                    <span className="text-term-text">{avg.toFixed(2)}</span>
                  </span>
                </span>
                )}
                <span className="tabular-nums whitespace-nowrap">
                  <span className="text-term-dim">LTP </span>
                  <span className="text-term-text">{lp != null ? lp.toFixed(2) : "–"}</span>
                </span>
              </div>

              {!APP && (() => {
                const g = qty < 0 ? guard[String(r.tsym ?? "")] : undefined;
                if (!g || g.level < 1) return null;
                const t = guardText(g);
                return (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className={`mt-2 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] ${
                      g.level >= 2 ? "bg-down/15 text-down" : "bg-amber-500/15 text-amber-400"
                    }`}
                  >
                    <span className="min-w-0 flex-1 leading-snug">
                      <b>{g.level >= 2 ? "🔴 DANGER" : "🟠 WARNING"}</b> · {t.where}
                      {t.next && <> · {t.next}</>}
                    </span>
                    <button
                      disabled={isBusy}
                      onClick={() => squareOff(r)}
                      className={`shrink-0 rounded px-3 py-1 text-[12px] font-bold text-white disabled:opacity-40 ${
                        g.level >= 2 ? "bg-down" : "bg-amber-500"
                      }`}
                    >
                      Exit
                    </button>
                  </div>
                );
              })()}
              {/* SL / target on this leg: always on the card (it used to hide in the tap-to-expand area) */}
              {!!qty && !APP && (
                <div className="mt-1.5 flex" onClick={(e) => e.stopPropagation()}>
                  <LegBracketBadge r={r} bracket={findBracket(r, legRules)} onChanged={loadLegRules} />
                </div>
              )}
              {open && !APP && (
                <div
                  className="mt-2 flex flex-col gap-1.5 border-t border-term-border/60 pt-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center gap-2 text-[11px]">
                    {!!qty && (
                      <label className="flex items-center gap-1.5 text-term-dim">
                        <input type="checkbox" checked={sel} onChange={() => key && toggleOne(key)} />
                        select
                      </label>
                    )}
                    <span className="tabular-nums text-term-dim">
                      realised <span className={signColor(n(r.rpnl))}>{nf(n(r.rpnl) ?? 0, 2)}</span>
                    </span>
                    {!!qty && (
                      <button
                        disabled={isBusy}
                        onClick={() => squareOff(r)}
                        className="ml-auto rounded border border-down/50 px-3 py-1 text-[11px] font-semibold text-down hover:bg-down/10 disabled:opacity-30"
                        title="Flatten this position with an opposite-side MARKET order"
                      >
                        {isBusy ? "…" : "Exit"}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {sheet && (
        <PositionSheet
          r={sheet.r}
          avg={sheet.avg}
          pnl={sheet.pnl}
          onClose={() => setSheet(null)}
          extras={
            APP && (n(sheet.r.netqty) ?? 0) !== 0
              ? (() => {
                  const r = sheet.r;
                  const g = (n(r.netqty) ?? 0) < 0 ? guard[String(r.tsym ?? "")] : undefined;
                  const t = g && g.level >= 1 ? guardText(g) : null;
                  return (
                    <div className="mt-3 flex flex-col gap-2">
                      {t && g && (
                        <div className={`rounded-md px-2.5 py-1.5 text-[12px] leading-snug ${g.level >= 2 ? "bg-down/15 text-down" : "bg-amber-500/15 text-amber-400"}`}>
                          <b>{g.level >= 2 ? "🔴 DANGER" : "🟠 WARNING"}</b> · {t.where}
                          {t.next && <> · {t.next}</>}
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <LegBracketBadge r={r} bracket={findBracket(r, legRules)} onChanged={loadLegRules} />
                        <button
                          disabled={busy.has(r.tsym)}
                          onClick={() => {
                            setSheet(null);
                            squareOff(r);
                          }}
                          className="ml-auto rounded border border-down/60 bg-down/10 px-3 py-1.5 text-[12px] font-semibold text-down disabled:opacity-40"
                          title="Exit the whole position at market"
                        >
                          Exit all
                        </button>
                      </div>
                    </div>
                  );
                })()
              : null
          }
        />
      )}
    </div>
  );
}

/** Press-and-hold on a position: the broker app's sheet for that contract -- BUY / SELL, lots, at
 *  market or at YOUR price (a limit order that waits in the order book, e.g. "sell 2 of my 4 lots at
 *  480"). Orders by the position's own broker symbol, so SENSEX / BSE contracts need no lookup.
 *  Starts on the side that reduces the position, with half of it. */
function PositionSheet({
  r,
  avg,
  pnl,
  onClose,
  init,
  extras,
}: {
  r: any;
  avg: number;
  pnl: number;
  onClose: () => void;
  /** start values (Repeat Order: the executed order's side / lots / type / price) */
  init?: { side: "BUY" | "SELL"; lots: number; type: "LMT" | "MKT"; price: number | null };
  /** more actions under the order form (the app: Exit all, + SL / TGT, the short-strike warning) */
  extras?: ReactNode;
}) {
  // the watchlist order window (OrderSheet.tsx), copied for a position: BUY / SELL, lots, NRML / MIS,
  // Market / Limit, SL / target / trailing SL -- plus what you hold, ½ / All and the leg's P&L
  const net = Number(r.netqty) || 0;
  const lotSize = Number(r.ls) || 1;
  const heldLots = Math.floor(Math.abs(net) / lotSize);
  const lp = r.lp != null ? Number(r.lp) : null;
  const name = r.dname || r.tsym;
  const legPrd: "NRML" | "MIS" = r.prd === "I" || r.s_prdt_ali === "MIS" ? "MIS" : "NRML";
  const closeSide: "BUY" | "SELL" = net > 0 ? "SELL" : "BUY";
  const [side, setSide] = useState<"BUY" | "SELL">(init?.side ?? (net ? closeSide : "BUY"));
  const [lots, setLots] = useState(init?.lots ?? Math.max(1, Math.floor(heldLots / 2) || 1));
  const [product, setProduct] = useState<"NRML" | "MIS">(legPrd);
  // booking part of a position is usually "at my price"; adding / a new order starts at market
  const [type, setType] = useState<"LMT" | "MKT">(init?.type ?? (net ? "LMT" : "MKT"));
  const [limit, setLimit] = useState(init?.price ? init.price.toFixed(2) : lp != null ? lp.toFixed(2) : "");
  const [sl, setSl] = useState("");
  const [target, setTarget] = useState("");
  const [trail, setTrail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const buy = side === "BUY";
  const qty = lots * lotSize;
  const reduces = !!net && side === closeSide;
  // an exit must be in the leg's own product -- the broker keeps NRML and MIS apart, so a MIS
  // sell against an NRML long opens a new short instead of booking it
  const prdNow = reduces ? legPrd : product;
  const price = type === "LMT" ? parseFloat(limit) || 0 : 0;
  const px = price || lp || 0;
  // SL / target protect what the order OPENS or ADDS to; an exit has nothing new to protect
  const protect = !reduces;

  const place = async () => {
    setErr(null);
    if (type === "LMT" && !(price > 0)) return setErr("Enter a limit price.");
    const s = protect && sl ? parseFloat(sl) : null;
    const t = protect && target ? parseFloat(target) : null;
    const tr = protect && trail ? parseFloat(trail) : null;
    if (tr != null && !(tr > 0)) return setErr("Trailing SL must be more than 0 points.");
    if (tr != null && px && tr >= px) return setErr(`Trailing SL ${tr} pts is more than the price itself.`);
    // a stop / target on the wrong side of the entry would exit at once
    if (s != null && px && (buy ? s >= px : s <= px)) return setErr(`SL must be ${buy ? "below" : "above"} the price (${nf(px)}).`);
    if (t != null && px && (buy ? t <= px : t >= px)) return setErr(`Target must be ${buy ? "above" : "below"} the price (${nf(px)}).`);
    const lines = [
      `${side} ${lots} lot${lots === 1 ? "" : "s"} (${qty} qty) of ${name} · ${prdNow}`,
      type === "LMT" ? `LIMIT @ ${price.toFixed(2)} — waits in the order book until the price reaches it` : "at MARKET — fills now",
      "REAL order on Flattrade.",
    ];
    if (reduces && qty <= Math.abs(net)) lines.push(`Books ${qty} of your ${Math.abs(net)} (${Math.abs(net) - qty} left).`);
    if (reduces && qty > Math.abs(net)) lines.push(`⚠ That is MORE than you hold (${Math.abs(net)}): the rest opens a position the other way.`);
    if (net && !reduces && pnl < 0) lines.push(`⚠ This ADDS to a LOSING position (₹${nf(pnl, 0)}). Is it in your plan?`);
    if (type === "LMT" && lp != null && (buy ? price > lp : price < lp))
      lines.push(`Note: your price is past the current ${lp.toFixed(2)}, so it will fill right away.`);
    if (s != null || t != null || tr != null)
      lines.push(
        `Once filled: ${[s != null && `SL ${s}`, t != null && `target ${t}`, tr != null && `trail ${tr} pts`].filter(Boolean).join(" · ")} on the whole leg` +
          (net && prdNow === legPrd ? " (replaces any SL / target it has now)." : ".")
      );
    if (!window.confirm(lines.join("\n"))) return;
    setBusy(true);
    try {
      // units, not lots: the server checks they are whole lots of ITS lot size
      await api.brokerOrderTsym({
        tsym: r.tsym, exch: r.exch, side, lots, qty, prd: prdNow === "MIS" ? "I" : "M", price: type === "LMT" ? price : 0,
      });
      playOrderSound(side);
      if (s != null || t != null || tr != null)
        void attachWhenFilled(r.tsym, s, t, tr, { side, prevNet: prdNow === legPrd ? net : 0, qty });
      onClose();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  // BUY / SELL toggle: big, and the side that is off keeps its own colour (tinted) so both read clearly
  const sideBtn = (on: boolean, tone: "up" | "down") =>
    `flex-1 rounded-md border-2 py-2.5 text-[15px] font-bold tracking-wide transition-colors ${
      tone === "up"
        ? on
          ? "border-up bg-up text-white shadow-md ring-2 ring-up/40"
          : "border-up/60 bg-up/10 text-up hover:bg-up/20"
        : on
        ? "border-down bg-down text-white shadow-md ring-2 ring-down/40"
        : "border-down/60 bg-down/10 text-down hover:bg-down/20"
    }`;
  const seg = (on: boolean, tone = "accent") =>
    `flex-1 rounded border py-1.5 text-[12px] font-semibold ${
      on
        ? tone === "up"
          ? "border-up bg-up text-white"
          : tone === "down"
          ? "border-down bg-down text-white"
          : "border-term-accent bg-term-accent/20 text-term-accent"
        : "border-term-border text-term-dim"
    }`;
  const inp =
    "num w-full rounded border border-term-border bg-term-bg px-2 py-1.5 text-[13px] text-term-text outline-none focus:border-term-accent";
  const row = (k: string, v: ReactNode) => (
    <div className="flex items-baseline justify-between border-b border-term-border/50 py-1 text-[12px]">
      <span className="text-term-dim">{k}</span>
      <span className="tabular-nums text-term-text">{v}</span>
    </div>
  );
  return (
    <div className="fixed inset-0 z-[55] flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-xl border border-term-border bg-term-panel p-3 shadow-2xl sm:rounded-xl"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* contract + price */}
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-term-text">{name}</div>
            <div className="text-[11px] text-term-dim">
              {r.exch ?? "NFO"} · lot {lotSize}
              <span className="ml-1.5 rounded bg-down px-1 text-[9px] font-bold text-white">LIVE</span>
            </div>
          </div>
          <div className="num text-right text-[16px] font-semibold text-term-text">{lp != null ? nf(lp) : "–"}</div>
        </div>

        <div className="mt-3 flex gap-2">
          <button onClick={() => setSide("BUY")} className={sideBtn(buy, "up")}>BUY</button>
          <button onClick={() => setSide("SELL")} className={sideBtn(!buy, "down")}>SELL</button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-term-dim">
              Lots · qty {qty}
              {heldLots > 0 && <span className="normal-case"> · you hold {heldLots}</span>}
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setLots((n) => Math.max(1, n - 1))} className="rounded border border-term-border px-3 py-1.5 text-term-text">−</button>
              <span className="num flex-1 text-center text-[14px] font-semibold text-term-text">{lots}</span>
              <button onClick={() => setLots((n) => Math.min(500, n + 1))} className="rounded border border-term-border px-3 py-1.5 text-term-text">+</button>
            </div>
            {reduces && heldLots > 1 && (
              <div className="mt-1 flex gap-1">
                {[
                  ["½", Math.max(1, Math.floor(heldLots / 2))],
                  ["All", heldLots],
                ].map(([l, v]) => (
                  <button key={String(l)} onClick={() => setLots(Number(v))} className="chipbtn text-[11px]">
                    {l}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-term-dim">Product</div>
            <div className="flex gap-1">
              {(["NRML", "MIS"] as const).map((pp) => (
                <button
                  key={pp}
                  disabled={reduces && pp !== legPrd}
                  onClick={() => setProduct(pp)}
                  className={`${seg(prdNow === pp)} disabled:opacity-30`}
                >
                  {pp}
                </button>
              ))}
            </div>
            {reduces && <div className="mt-1 text-[10px] text-term-dim">an exit stays {legPrd}, like the leg</div>}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-term-dim">Order</div>
            <div className="flex gap-1">
              <button onClick={() => setType("MKT")} className={seg(type === "MKT")}>Market</button>
              <button onClick={() => setType("LMT")} className={seg(type === "LMT")}>Limit</button>
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-term-dim">Limit price</div>
            <input
              id="pos-sheet-price"
              inputMode="decimal"
              disabled={type !== "LMT"}
              value={type === "LMT" ? limit : ""}
              onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder={type === "LMT" ? "price" : "at market"}
              className={`${inp} disabled:opacity-40`}
            />
          </div>
        </div>

        {/* protection, attached to the whole leg once the order fills */}
        {protect ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-down">Stop-loss price</div>
                <input id="pos-sheet-sl" inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value.replace(/[^\d.]/g, ""))} placeholder={buy ? "below price" : "above price"} className={inp} />
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-up">Target price</div>
                <input id="pos-sheet-tgt" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value.replace(/[^\d.]/g, ""))} placeholder={buy ? "above price" : "below price"} className={inp} />
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-amber-400">Trailing SL · points</div>
                <input id="pos-sheet-trail" inputMode="decimal" value={trail} onChange={(e) => setTrail(e.target.value.replace(/[^\d.]/g, ""))} placeholder="e.g. 10" className={inp} />
              </div>
              <div className="self-end pb-1 text-[10px] leading-snug text-term-dim">
                {trail && parseFloat(trail) > 0
                  ? buy
                    ? `Exits if price falls ${trail} pts from its highest since entry.`
                    : `Exits if price rises ${trail} pts from its lowest since entry.`
                  : "Follows the price: the stop moves up (buy) / down (sell) as it goes your way."}
              </div>
            </div>
            <div className="mt-1 text-[10px] leading-snug text-term-dim">
              Optional. Attached to the whole leg once it fills{net ? " (replaces its current SL / target)" : ""}; the server exits at market when one is hit (works with the app closed).
            </div>
          </>
        ) : (
          <div className="mt-2 text-[10px] leading-snug text-term-dim">
            This books part of the position — the rest keeps its SL / target{extras ? " (change it below)" : ""}.
          </div>
        )}

        {!!net && (
          <div className="mt-2">
            {row("Net qty", `${Math.abs(net)} ${net > 0 ? "long" : "short"}`)}
            {row("Avg price", avg ? avg.toFixed(2) : "–")}
            {row("P&L", <span className={signColor(pnl)}>{nf(pnl, 2)}</span>)}
          </div>
        )}

        {err && <div className="mt-2 text-[12px] text-down">{err}</div>}

        <button
          disabled={busy}
          onClick={place}
          className={`mt-3 w-full rounded-lg py-3 text-[14px] font-bold text-white disabled:opacity-50 ${buy ? "bg-up" : "bg-down"}`}
        >
          {busy ? "…" : `${side} ${lots} lot${lots === 1 ? "" : "s"}${type === "LMT" && price ? ` @ ${price.toFixed(2)}` : ""}`}
          {px ? <span className="ml-1.5 text-[12px] font-normal opacity-90">≈ ₹{nf(px * qty, 0)}</span> : null}
          <span className="ml-1.5 text-[11px] font-normal opacity-90">· review next</span>
        </button>
        {extras}
      </div>
    </div>
  );
}

// ---------------- Holdings ----------------
function HoldingsTab() {
  const broker = useStore((s) => s.broker);
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!broker?.authed) return;
    let alive = true;
    const load = () =>
      api.brokerHoldings().then(
        (d) => alive && (setRows(d.holdings || []), setErr(null)),
        (e) => alive && setErr(String(e.message || e))
      );
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [broker?.authed]);

  if (!broker?.authed) return <Empty>Connect Flattrade (header) to see your holdings.</Empty>;
  if (err) return <Empty>{err}</Empty>;
  if (rows.length === 0) return <Empty>No holdings.</Empty>;

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <table className="grid-table text-xs">
        <thead className="sticky top-0 z-10 bg-term-panel text-[10px] uppercase text-term-dim">
          <tr>
            <TH>Symbol</TH>
            <TH>Qty</TH>
            <TH>Avg Cost</TH>
            <TH>LTP</TH>
            <TH>P&L</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const sym = r.exch_tsym?.[0]?.tsym ?? r.tsym ?? "—";
            const qty =
              (n(r.holdqty) ?? 0) + (n(r.npoadqty) ?? 0) + (n(r.btstqty) ?? 0) - (n(r.usedqty) ?? 0);
            const avg = n(r.upldprc) ?? n(r.avgprc);
            const ltp = n(r.exch_tsym?.[0]?.lp) ?? n(r.lp);
            const pnl = avg != null && ltp != null ? (ltp - avg) * qty : null;
            return (
              <tr key={i}>
                <TD cls="num font-medium">{sym}</TD>
                <TD cls="num">{qty}</TD>
                <TD cls="num">{nf(avg)}</TD>
                <TD cls="num">{nf(ltp)}</TD>
                <TD cls={`num ${signColor(pnl)}`}>{pnl != null ? `₹${nf(pnl, 0)}` : "—"}</TD>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------- Orders ----------------
/** Cancel / modify a still-resting (open) broker order in place. The
 *  Flattrade order-book poll (every 5s in OrdersTab) picks up the result
 *  on its own -- no separate reload plumbing needed here. */
function OrderRowActions({ order }: { order: any }) {
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"cancelled" | "modified" | null>(null);

  const cancel = async () => {
    if (!window.confirm(`Cancel this order — ${order.dname || order.tsym}?`)) return;
    setBusy(true);
    try {
      await api.brokerOrderCancel(order.norenordno);
      setDone("cancelled");
    } catch (e: any) {
      alert(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  if (done) return <span className="text-[12px] text-term-dim">{done === "cancelled" ? "Cancel sent…" : "Change sent…"}</span>;
  return (
    <>
      <div className="flex w-full gap-2">
        <button
          disabled={busy}
          onClick={() => setSheet(true)}
          className="flex-1 rounded-md border border-term-accent/60 bg-term-accent/15 py-1.5 text-[13px] font-semibold text-term-accent active:bg-term-accent/30 disabled:opacity-40"
        >
          ✎ Modify
        </button>
        <button
          disabled={busy}
          onClick={cancel}
          className="flex-1 rounded-md border border-down/60 bg-down/10 py-1.5 text-[13px] font-semibold text-down active:bg-down/25 disabled:opacity-40"
        >
          {busy ? "…" : "✕ Cancel"}
        </button>
      </div>
      {sheet && <ModifyOrderSheet order={order} onClose={() => setSheet(false)} onDone={() => setDone("modified")} />}
    </>
  );
}

/** Change a resting order: limit price (or go Market), lots, and the trigger on a stop order.
 *  The server fills in the rest of Flattrade's ModifyOrder request from the order book. */
function ModifyOrderSheet({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const ls = Math.max(1, Number(order.ls) || 1);
  const qty0 = Number(order.qty) || ls;
  const filled = Number(order.fillshares) || 0;
  const buy = String(order.trantype || "B").toUpperCase().startsWith("B");
  const isStop = Number(order.trgprc) > 0;
  const [lots, setLots] = useState(Math.max(1, Math.round(qty0 / ls)));
  const [type, setType] = useState<"LMT" | "MKT">(String(order.prctyp).toUpperCase() === "MKT" ? "MKT" : "LMT");
  const [price, setPrice] = useState(String(order.prc ?? ""));
  const [trg, setTrg] = useState(isStop ? String(order.trgprc) : "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const minLots = Math.max(1, Math.ceil((filled + 1) / ls)); // can't go below what already filled

  const submit = async () => {
    setErr(null);
    const q = lots * ls;
    const body: { qty?: number; price?: number; priceType?: "LMT" | "MKT"; triggerPrice?: number } = {};
    if (q !== qty0) body.qty = q;
    if (type === "MKT") body.priceType = "MKT";
    else {
      const p = parseFloat(price);
      if (!(p > 0)) return setErr("Enter a limit price.");
      body.priceType = "LMT";
      body.price = p;
    }
    if (isStop) {
      const t = parseFloat(trg);
      if (!(t > 0)) return setErr("Enter a trigger price.");
      body.triggerPrice = t;
    }
    if (q !== qty0 || type === "MKT" || body.price !== Number(order.prc) || (isStop && body.triggerPrice !== Number(order.trgprc))) {
      setBusy(true);
      try {
        await api.brokerOrderModify(order.norenordno, body);
        onDone();
        onClose();
      } catch (e: any) {
        setErr(String(e?.message || e));
      } finally {
        setBusy(false);
      }
    } else setErr("Nothing changed.");
  };

  const seg = (on: boolean) =>
    `flex-1 rounded border py-1.5 text-[12px] font-semibold ${
      on ? "border-term-accent bg-term-accent/20 text-term-accent" : "border-term-border text-term-dim"
    }`;
  const inp =
    "num w-full rounded border border-term-border bg-term-bg px-2 py-1.5 text-[13px] text-term-text outline-none focus:border-term-accent";

  return (
    <div className="fixed inset-0 z-[55] flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-xl border border-term-border bg-term-panel p-3 shadow-2xl sm:rounded-xl"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-term-text">{order.dname || order.tsym}</div>
            <div className="text-[11px] text-term-dim">
              <span className={buy ? "text-up" : "text-down"}>{buy ? "BUY" : "SELL"}</span> · Modify open order · lot {ls}
              {filled > 0 && ` · ${filled} filled`}
            </div>
          </div>
          <button onClick={onClose} className="px-1 text-[16px] text-term-dim">
            ✕
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-term-dim">Lots · qty {lots * ls}</div>
            <div className="flex items-center gap-1">
              <button onClick={() => setLots((n) => Math.max(minLots, n - 1))} className="rounded border border-term-border px-3 py-1.5 text-term-text">
                −
              </button>
              <span className="num flex-1 text-center text-[14px] font-semibold text-term-text">{lots}</span>
              <button onClick={() => setLots((n) => Math.min(500, n + 1))} className="rounded border border-term-border px-3 py-1.5 text-term-text">
                +
              </button>
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-term-dim">Order</div>
            <div className="flex gap-1">
              <button onClick={() => setType("LMT")} className={seg(type === "LMT")}>
                Limit
              </button>
              <button onClick={() => setType("MKT")} className={seg(type === "MKT")}>
                Market
              </button>
            </div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-term-dim">Limit price</div>
            <input
              id="modify-price"
              disabled={type !== "LMT"}
              value={type === "LMT" ? price : ""}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder={type === "LMT" ? "price" : "at market"}
              className={`${inp} disabled:opacity-40`}
            />
          </div>
          {isStop ? (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-amber-400">Trigger price</div>
              <input id="modify-trigger" value={trg} onChange={(e) => setTrg(e.target.value.replace(/[^\d.]/g, ""))} className={inp} />
            </div>
          ) : (
            <div className="self-end pb-1 text-[10px] leading-snug text-term-dim">
              Now: {Math.round(qty0 / ls)} lot{Math.round(qty0 / ls) === 1 ? "" : "s"} @ {order.prctyp === "MKT" ? "market" : order.prc}
            </div>
          )}
        </div>

        {err && <div className="mt-2 text-[12px] text-down">{err}</div>}

        <button
          disabled={busy}
          onClick={submit}
          className="mt-3 w-full rounded-lg bg-term-accent py-3 text-[14px] font-bold text-white disabled:opacity-50"
        >
          {busy ? "…" : "Update order"}
        </button>
      </div>
    </div>
  );
}

/** one order, whatever it came from, in the shape the cards draw */
type OrderCard = {
  key: string;
  ms: number;
  side: "BUY" | "SELL";
  prd: string;
  exch: string;
  name: string;
  status: string; // as shown: COMPLETE / OPEN / REJECTED / CANCELLED / TRIGGER PENDING / PLACED
  open: boolean; // still working at the exchange
  qty: number | null;
  filled: number | null;
  lots?: number; // an order refused before sending has lots, not a qty
  price: string; // order price, "MKT" for a market order
  avg: number | null;
  trg: number | null;
  time: string;
  reason: string;
  book?: any; // the Flattrade order-book row (for modify / cancel)
};

const OPEN_RE = /open|pending|trigger|received|modif/i;
const statusCls = (s: string) =>
  /complete|filled/i.test(s)
    ? "bg-up/15 text-up"
    : /reject/i.test(s)
    ? "bg-down/15 text-down"
    : /cancel/i.test(s)
    ? "bg-term-border/60 text-term-dim"
    : /trigger/i.test(s)
    ? "bg-amber-500/15 text-amber-400"
    : "bg-term-accent/15 text-term-accent";
const bseName = (s: string) => /^(SENSEX|BANKEX|SENSEX50|SNSX50)$/i.test(s || "");

/** 24h "HH:MM:SS", the way the broker's order book prints times */
const hms = (ms: number) => (ms ? new Date(ms).toLocaleTimeString("en-GB", { hour12: false }) : "");
/** "01-Oct-2026" -> "01 OCT" */
const expShort = (e?: string) => {
  const m = /^(\d{1,2})-([A-Za-z]{3})/.exec(e || "");
  return m ? `${m[1]} ${m[2].toUpperCase()}` : "";
};

/** "15:20:13 22-09-2026" (Noren norentm) -> epoch ms */
const norenMs = (t?: string): number => {
  const m = /^(\d{2}):(\d{2}):(\d{2})\s+(\d{2})-(\d{2})-(\d{4})/.exec(t || "");
  return m ? new Date(+m[6], +m[5] - 1, +m[4], +m[1], +m[2], +m[3]).getTime() : 0;
};

/** Orders, laid out like the broker app's order book: Open | Executed tabs
 *  of cards -- "BUY | NRML | NFO" + status, the contract + time, Qty
 *  filled/total, Price and Avg. Tap an open order to modify / cancel it.
 *  Live = Flattrade's order book plus any order GammaTerminal refused before
 *  sending (those never reach the book); Paper = this session's paper fills. */
export function OrdersTab() {
  const broker = useStore((s) => s.broker);
  const paper = useStore((s) => s.paper);
  const orderMode = useStore((s) => s.orderMode);
  // Paper / Live is the header toggle's job: this tab shows only that side (viewers: paper)
  const src: "live" | "paper" = isViewer() || orderMode !== "live" ? "paper" : "live";
  const [book, setBook] = useState<any[]>([]);
  const [liveLog, setLiveLog] = useState<any[]>([]);
  const [tab, setTab] = useState<"open" | "done">("open");
  const [openKey, setOpenKey] = useState<string | null>(null);
  // tap an executed live order: its details + Repeat Order (the broker app's order sheet)
  const [detail, setDetail] = useState<OrderCard | null>(null);
  // each contract's LTP, from the live positions (the order book carries none)
  const [ltpOf, setLtpOf] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (src !== "live") return;
      api.liveOrderLog().then((d) => alive && setLiveLog(d.orders || []), () => {});
      if (broker?.authed) api.brokerOrders().then((d) => alive && setBook(d.orders || []), () => {});
      if (broker?.authed)
        api.brokerPositions().then(
          (d) =>
            alive &&
            setLtpOf(
              Object.fromEntries(
                (d.positions || []).filter((r: any) => r.tsym && r.lp != null && r.lp !== "").map((r: any) => [r.tsym, Number(r.lp)])
              )
            ),
          () => {}
        );
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [broker?.authed, src]);

  const tsMs = (raw: any): number => {
    const x = Number(raw);
    if (Number.isFinite(x) && x > 0) return x < 1e12 ? x * 1000 : x;
    const d = raw ? new Date(raw) : null;
    return d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
  };
  // broker-style name: "SENSEX 01 OCT 74800 CE"
  const contract = (o: any) =>
    [o.symbol, expShort(o.expiry), o.optionType === "FUT" ? "FUT" : `${sk(o.strike)} ${o.optionType ?? ""}`]
      .filter(Boolean)
      .join(" ")
      .trim();

  let cards: OrderCard[] = [];
  if (src === "live") {
    const fromBook: OrderCard[] = book.map((o, i) => {
      const st = String(o.status || "").toUpperCase().replace(/_/g, " ").replace("CANCELED", "CANCELLED");
      const ms = norenMs(o.norentm);
      return {
        key: String(o.norenordno ?? `b${i}`),
        ms,
        side: o.trantype === "B" ? "BUY" : "SELL",
        prd: o.s_prdt_ali ?? PRD[String(o.prd ?? "")] ?? o.prd ?? "NRML",
        exch: o.exch ?? "NFO",
        name: String(o.dname || "").trim() || o.tsym || "—",
        status: st || "—",
        open: OPEN_RE.test(st),
        qty: n(o.qty),
        filled: n(o.fillshares) ?? 0,
        price: /MKT/i.test(o.prctyp || "") ? "MKT" : n(o.prc)?.toFixed(2) ?? "–",
        avg: n(o.avgprc),
        trg: n(o.trgprc),
        time: (o.norentm || "").split(" ")[0] || hms(ms),
        reason: String(o.rejreason || "").trim(),
        book: o,
      };
    });
    // GammaTerminal's own log: an order refused before sending never reaches
    // the broker's book, so it's added here (and, with Flattrade not
    // connected, everything GammaTerminal sent this session)
    const fromLog: OrderCard[] = liveLog
      .filter((o) => (o.mode || "live") !== "paper")
      .filter((o) => !broker?.authed || (!o.orderId && /reject|error/i.test(o.status || "")))
      .map((o, i) => {
        const ms = tsMs(o.ts);
        const rej = /reject|error/i.test(o.status || "");
        return {
          key: `g${i}-${o.ts}`,
          ms,
          side: o.side === "SELL" ? "SELL" : "BUY",
          prd: "NRML",
          exch: o.exch ?? (bseName(o.symbol) ? "BFO" : "NFO"),
          name: contract(o),
          status: rej ? "REJECTED" : String(o.status || "PLACED").toUpperCase(),
          open: false,
          qty: n(o.qty),
          filled: null,
          lots: n(o.qtyLots) ?? undefined,
          price: "–",
          avg: null,
          trg: null,
          time: hms(ms),
          reason: rej ? `Not sent — ${o.error || "refused by GammaTerminal"}` : "",
        };
      });
    cards = [...fromBook, ...fromLog];
  } else {
    cards = (paper?.orders ?? []).map((o: any, i: number) => {
      const ms = tsMs(o.ts);
      return {
        key: `p${i}-${o.ts}`,
        ms,
        side: o.side === "SELL" ? "SELL" : "BUY",
        prd: "PAPER",
        exch: bseName(o.symbol) ? "BFO" : "NFO",
        name: contract(o),
        status: "COMPLETE",
        open: false,
        qty: n(o.qty),
        filled: n(o.qty),
        price: n(o.price)?.toFixed(2) ?? "–",
        avg: n(o.price),
        trg: null,
        time: hms(ms),
        reason: "",
      };
    });
  }
  cards.sort((a, b) => b.ms - a.ms);
  const openCards = cards.filter((c) => c.open);
  const doneCards = cards.filter((c) => !c.open);
  const shown = tab === "open" ? openCards : doneCards;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Open | Executed, underlined like the broker app */}
      <div className="flex shrink-0 items-stretch border-b border-term-border bg-term-panel">
        {(
          [
            ["open", "Pending", openCards.length],
            ["done", "Executed", doneCards.length],
          ] as const
        ).map(([k, label, count]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`relative flex flex-1 items-center justify-center gap-2 py-2.5 text-[15px] ${
              tab === k ? "text-term-accent" : "text-term-text hover:text-term-accent"
            }`}
          >
            {label}
            {count > 0 && (
              <span className="flex h-6 min-w-[24px] items-center justify-center rounded-full bg-term-accent px-1.5 text-[13px] tabular-nums text-white">
                {count}
              </span>
            )}
            {tab === k && <span className="absolute inset-x-0 bottom-0 h-[3px] bg-term-accent" />}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-term-bg p-2 md:p-3">
        <div className="flex items-center gap-2 px-1 text-[11px] text-term-dim">
          <span
            className={`rounded px-2 py-0.5 text-[11px] font-bold tracking-wide ${
              src === "live" ? "bg-down text-white" : "bg-term-accent text-white"
            }`}
          >
            {src === "live" ? "LIVE" : "PAPER"}
          </span>
          <span className="truncate">
            {src === "live"
              ? broker?.authed
                ? "Flattrade"
                : "Flattrade not connected — orders GammaTerminal sent"
              : "paper orders this session"}
          </span>
        </div>

        {shown.length === 0 && (
          <div className="rounded-lg bg-term-panel px-3 py-6 text-center text-xs text-term-dim">
            {tab === "open" ? "No open orders." : "No executed orders today."}
          </div>
        )}

        <div className="grid gap-2 lg:grid-cols-2 2xl:grid-cols-3">
          {shown.map((c) => {
            // Modify / Cancel on every open order (was hidden until the card was tapped)
            const expanded = c.open && !!c.book?.norenordno;
            const tappable = !c.open && !!c.book?.tsym;
            return (
              <div
                key={c.key}
                onClick={tappable ? () => setDetail(c) : undefined}
                title={tappable ? "Tap for the order's details · Repeat Order" : undefined}
                className={`rounded-lg bg-term-panel px-4 py-2.5 ${tappable ? "cursor-pointer active:bg-term-panel2" : ""}`}
              >
                {/* the broker app's order card: [BUY] Qty. 40/40 · time [STATUS] / contract · price / exch prd type · LTP */}
                <div className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="flex items-center gap-2 tabular-nums">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                        c.side === "BUY" ? "bg-term-accent/15 text-term-accent" : "bg-down/15 text-down"
                      }`}
                    >
                      {c.side}
                    </span>
                    <span className="text-term-dim">
                      Qty.{" "}
                      {c.filled != null && c.qty != null
                        ? `${c.filled}/${c.qty}`
                        : c.qty ?? (c.lots ? `${c.lots} lot${c.lots > 1 ? "s" : ""}` : "–")}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 whitespace-nowrap">
                    <span className="tabular-nums text-term-dim">⏱ {c.time}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${statusCls(c.status)}`}>{c.status}</span>
                  </span>
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-2">
                  <span className="truncate text-[14px] text-term-text">{c.name}</span>
                  <span className="whitespace-nowrap text-[14px] tabular-nums text-term-text">
                    {/* executed: what it filled at; working: its own price (trigger for a stop order) */}
                    {c.avg != null && c.avg > 0 ? c.avg.toFixed(2) : c.trg != null && c.trg > 0 ? `${c.price} · trg ${c.trg.toFixed(2)}` : c.price}
                  </span>
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-2 text-[12px] text-term-dim">
                  <span className="flex gap-2 whitespace-nowrap">
                    <span>{c.exch}</span>
                    <span>{c.prd}</span>
                    <span>{c.price === "MKT" ? "MKT" : c.book?.prctyp || (c.price !== "–" ? "LMT" : "")}</span>
                  </span>
                  {c.book?.tsym && ltpOf[c.book.tsym] != null && (
                    <span className="whitespace-nowrap tabular-nums">LTP {ltpOf[c.book.tsym].toFixed(2)}</span>
                  )}
                </div>
                {c.reason && <div className="mt-1 text-[12px] leading-snug text-down/90">{c.reason}</div>}
                {expanded && (
                  <div className="mt-2 flex border-t border-term-border/60 pt-2">
                    <OrderRowActions order={c.book} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {detail && <OrderDetailSheet c={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/** An executed order's sheet (the broker app's): what filled, at what, its IDs -- and Repeat Order,
 *  which opens the BUY / SELL sheet with this order's side, lots and price type filled in. */
function OrderDetailSheet({ c, onClose }: { c: OrderCard; onClose: () => void }) {
  const o = c.book || {};
  const [repeat, setRepeat] = useState(false);
  const ls = Number(o.ls) || 1;
  const mkt = /MKT/i.test(o.prctyp || "");
  if (repeat) {
    return (
      <PositionSheet
        r={{ tsym: o.tsym, exch: o.exch, netqty: 0, ls, lp: null, dname: c.name, prd: o.prd, s_prdt_ali: o.s_prdt_ali }}
        avg={0}
        pnl={0}
        onClose={onClose}
        init={{
          side: c.side,
          lots: Math.max(1, Math.round((c.qty ?? ls) / ls)),
          type: mkt ? "MKT" : "LMT",
          price: mkt ? null : Number(o.prc) || null,
        }}
      />
    );
  }
  const row = (k: string, v: ReactNode) => (
    <div className="flex items-baseline justify-between gap-3 border-b border-term-border/50 py-1.5 text-[12px]">
      <span className="text-term-dim">{k}</span>
      <span className="truncate text-right tabular-nums text-term-text">{v}</span>
    </div>
  );
  return (
    <div className="fixed inset-0 z-[55] flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-xl border border-term-border bg-term-panel p-3 shadow-2xl sm:rounded-xl"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="truncate text-[15px] font-semibold text-term-text">{c.name}</div>
        <div className="mt-1 flex items-center gap-2 text-[12px]">
          <span className="text-term-accent">{c.exch}</span>
          <span className={`rounded px-1.5 text-[11px] font-semibold ${c.side === "BUY" ? "bg-up/15 text-up" : "bg-down/15 text-down"}`}>{c.side}</span>
          <span className={`rounded px-1.5 text-[11px] font-medium ${statusCls(c.status)}`}>{c.status}</span>
        </div>

        {!isViewer() && (
          <button
            onClick={() => setRepeat(true)}
            className="mx-auto mt-3 block w-2/3 rounded-lg bg-term-accent py-2.5 text-[14px] font-bold text-white active:brightness-110"
          >
            Repeat Order
          </button>
        )}

        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          {(
            [
              ["Filled qty", c.filled != null && c.qty != null ? `${c.filled}/${c.qty}` : c.qty ?? "–"],
              ["Avg. price", c.avg != null && c.avg > 0 ? c.avg.toFixed(2) : "–"],
              ["Type", mkt ? "MKT" : o.prctyp || "LMT"],
            ] as [string, ReactNode][]
          ).map(([k, v]) => (
            <div key={k}>
              <div className="text-[11px] text-term-dim">{k}</div>
              <div className="tabular-nums text-[14px] font-semibold text-term-accent">{v}</div>
            </div>
          ))}
        </div>

        <div className="mt-3">
          {row("Status", c.status)}
          {row("Price", c.price)}
          {c.trg != null && c.trg > 0 && row("Trigger price", c.trg.toFixed(2))}
          {row("Validity / Product", `${o.ret || "DAY"} / ${c.prd}`)}
          {row("Time", o.norentm || c.time)}
          {o.exchordid && row("Exchange order ID", o.exchordid)}
          {o.norenordno && row("Order ID", o.norenordno)}
          {c.reason && row("Reason", <span className="text-down">{c.reason}</span>)}
        </div>
      </div>
    </div>
  );
}

/** everything beyond the broker app's plain position list, in one place */
function AdvancedTab({ paperMode }: { paperMode: boolean }) {
  const broker = useStore((s) => s.broker);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {!paperMode && broker?.authed && (
        <div className="flex items-center gap-2 border-b border-term-border bg-term-panel px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-term-dim">
            Profit guard · auto square-off
          </span>
          <AutoSquareOff />
        </div>
      )}
      <PortfolioSummary />
      <ShortGuard />
      <div className="flex min-h-[420px] flex-col">
        <ScenarioGrid />
      </div>
    </div>
  );
}

export function PositionsView({ initialTab }: { initialTab?: Tab } = {}) {
  const isMobile = useIsMobile();
  // Paper / Live is the header toggle: in Paper only paper data shows (no broker holdings,
  // no broker positions or Profit guard), in Live only the Flattrade side
  const orderMode = useStore((s) => s.orderMode);
  const paperCount = useStore((s) => s.paper?.positions.length ?? 0);
  const paperMode = isViewer() || orderMode !== "live";
  // Orders has its own entry everywhere (top nav on desktop, bottom tab on the phone), so it is
  // not repeated as a sub-tab here
  const tabs = TABS.filter(([k]) => k !== "orders" && !(paperMode && k === "holdings"));
  const [tabWanted, setTab] = useState<Tab>(initialTab && initialTab !== "orders" ? initialTab : "broker");
  const tab: Tab = tabs.some(([k]) => k === tabWanted) ? tabWanted : "broker";
  const [liveCount, setCount] = useState(0);
  const count = paperMode ? paperCount : liveCount;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* broker-app tabs: Positions (n) | Holdings | … with an underline */}
      <div className="flex shrink-0 border-b border-term-border bg-term-panel">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`relative flex flex-1 items-center justify-center gap-2 py-2.5 text-[15px] ${
              tab === k ? "text-term-accent" : "text-term-text hover:text-term-accent"
            }`}
          >
            {label}
            {k === "broker" && count > 0 && (
              <span className="tabular-nums flex h-6 min-w-[24px] items-center justify-center rounded-full bg-term-accent px-1.5 text-[13px] text-white">
                {count}
              </span>
            )}
            {tab === k && <span className="absolute inset-x-0 bottom-0 h-[3px] bg-term-accent" />}
          </button>
        ))}
      </div>
      {tab === "broker" &&
        (paperMode ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <PaperPositions />
          </div>
        ) : (
          <BrokerTab onCount={setCount} />
        ))}
      {tab === "holdings" && <HoldingsTab />}
      {tab === "advanced" && <AdvancedTab paperMode={paperMode} />}
    </div>
  );
}
