import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
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
import type { ShortGuardLeg } from "../types";

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
    return () => {
      alive = false;
      clearInterval(t);
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
          // the % the broker shows: LTP against the average price
          const pct = avg && lp != null ? ((lp - avg) / avg) * 100 : 0;
          const sel = selected.has(key);
          const open = openKey === key;
          const prd = r.s_prdt_ali ?? PRD[String(r.prd ?? "")] ?? r.prd ?? "NRML";
          return (
            <div
              key={key || i}
              onClick={() => setOpenKey(open ? null : key)}
              className={`cursor-pointer rounded-lg bg-term-panel px-4 py-2.5 ${
                sel ? "ring-1 ring-term-accent" : ""
              }`}
            >
              <div className="flex items-baseline justify-between gap-2 text-[14px]">
                <span className="flex items-center gap-2 text-term-text">
                  {prd} | {r.exch ?? "NFO"}
                  {/* exit right from the card -- no need to open it first */}
                  {!!qty && (
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
                <span className="truncate text-[16px] text-term-text">
                  {r.dname ?? r.tsym ?? r.symname ?? "—"}
                </span>
                <span className={`tabular-nums whitespace-nowrap text-[15px] ${signColor(pct)}`}>
                  ({nf(pct, 2)} %)
                </span>
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-2 text-[14px]">
                <span className="tabular-nums flex gap-4 whitespace-nowrap">
                  <span className={qty > 0 ? "text-up" : qty < 0 ? "text-down" : "text-term-dim"}>
                    Qty : {qty}
                  </span>
                  <span>
                    <span className="text-term-dim">Price : </span>
                    <span className="text-term-text">{avg.toFixed(2)}</span>
                  </span>
                </span>
                <span className="tabular-nums whitespace-nowrap">
                  <span className="text-term-dim">LTP </span>
                  <span className="text-term-text">{lp != null ? lp.toFixed(2) : "–"}</span>
                </span>
              </div>

              {(() => {
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
              {!!qty && (
                <div className="mt-1.5 flex" onClick={(e) => e.stopPropagation()}>
                  <LegBracketBadge r={r} bracket={findBracket(r, legRules)} onChanged={loadLegRules} />
                </div>
              )}
              {open && (
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
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(String(order.prc ?? ""));
  const [qty, setQty] = useState(String(order.qty ?? ""));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"cancelled" | "modified" | null>(null);

  const cancel = async () => {
    if (!window.confirm(`Cancel order ${order.norenordno} — ${order.tsym}?`)) return;
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

  const modify = async () => {
    const p = price ? Number(price) : undefined;
    const q = qty ? Number(qty) : undefined;
    if (p == null && q == null) return alert("Change price or qty first");
    setBusy(true);
    try {
      await api.brokerOrderModify(order.norenordno, { price: p, qty: q });
      setDone("modified");
      setOpen(false);
    } catch (e: any) {
      alert(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  if (done) return <span className="text-[10px] text-term-dim">{done}…</span>;

  if (!open) {
    return (
      <span className="flex items-center gap-1">
        <button
          disabled={busy}
          onClick={() => setOpen(true)}
          className="rounded border border-term-dim/70 px-1.5 py-0.5 text-[10px] text-term-dim hover:text-term-text disabled:opacity-40"
        >
          Modify
        </button>
        <button
          disabled={busy}
          onClick={cancel}
          className="rounded border border-down/50 px-1.5 py-0.5 text-[10px] text-down hover:bg-down/10 disabled:opacity-40"
        >
          {busy ? "…" : "Cancel"}
        </button>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1">
      <input
        value={price}
        onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))}
        placeholder="price"
        className="num w-14 rounded border border-term-border bg-term-bg px-1 py-0.5 text-[10px] text-term-text outline-none focus:border-term-accent"
      />
      <input
        value={qty}
        onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ""))}
        placeholder="qty"
        className="num w-12 rounded border border-term-border bg-term-bg px-1 py-0.5 text-[10px] text-term-text outline-none focus:border-term-accent"
      />
      <button
        disabled={busy}
        onClick={modify}
        className="rounded bg-term-accent px-1.5 py-0.5 text-[10px] font-semibold text-white disabled:opacity-40"
      >
        {busy ? "…" : "Update"}
      </button>
      <button onClick={() => setOpen(false)} className="px-1 text-[10px] text-term-dim hover:text-term-text">
        ✕
      </button>
    </span>
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
  const [src, setSrc] = useState<"live" | "paper">(orderMode === "live" ? "live" : "paper");
  // the order mode arrives after the first render -- follow it
  useEffect(() => setSrc(orderMode === "live" ? "live" : "paper"), [orderMode]);
  const [book, setBook] = useState<any[]>([]);
  const [liveLog, setLiveLog] = useState<any[]>([]);
  const [tab, setTab] = useState<"open" | "done">("open");
  const [openKey, setOpenKey] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.liveOrderLog().then((d) => alive && setLiveLog(d.orders || []), () => {});
      if (broker?.authed) api.brokerOrders().then((d) => alive && setBook(d.orders || []), () => {});
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [broker?.authed]);

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
            ["open", "Open", openCards.length],
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
          <div className="seg text-[11px]">
            {(isViewer() ? (["paper"] as const) : (["live", "paper"] as const)).map((s) => (
              <button key={s} onClick={() => setSrc(s)} className={src === s ? "on" : ""}>
                {s === "live" ? "Live" : "Paper"}
              </button>
            ))}
          </div>
          <span className="truncate">
            {src === "live"
              ? broker?.authed
                ? "Flattrade"
                : "Flattrade not connected — orders GammaTerminal sent"
              : "paper orders this session"}
          </span>
          {tab === "open" && openCards.length > 0 && (
            <span className="ml-auto whitespace-nowrap">tap to modify / cancel</span>
          )}
        </div>

        {shown.length === 0 && (
          <div className="rounded-lg bg-term-panel px-3 py-6 text-center text-xs text-term-dim">
            {tab === "open" ? "No open orders." : "No executed orders today."}
          </div>
        )}

        <div className="grid gap-2 lg:grid-cols-2 2xl:grid-cols-3">
          {shown.map((c) => {
            const expanded = openKey === c.key && c.open && !!c.book?.norenordno;
            return (
              <div
                key={c.key}
                onClick={() => c.open && setOpenKey(expanded ? null : c.key)}
                className={`rounded-lg bg-term-panel px-4 py-2.5 ${c.open ? "cursor-pointer" : ""}`}
              >
                <div className="flex items-center justify-between gap-2 text-[14px]">
                  <span className="text-term-text">
                    <span className={c.side === "BUY" ? "text-up" : "text-down"}>{c.side}</span> | {c.prd} | {c.exch}
                  </span>
                  <span className={`whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-medium ${statusCls(c.status)}`}>
                    {c.status}
                  </span>
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-2">
                  <span className="truncate text-[16px] text-term-text">{c.name}</span>
                  <span className="whitespace-nowrap text-[13px] tabular-nums text-term-dim">{c.time}</span>
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-2 text-[14px]">
                  <span className="flex gap-4 whitespace-nowrap tabular-nums">
                    <span>
                      <span className="text-term-dim">Qty : </span>
                      <span className="text-term-text">
                        {c.filled != null && c.qty != null
                          ? `${c.filled}/${c.qty}`
                          : c.qty ?? (c.lots ? `${c.lots} lot${c.lots > 1 ? "s" : ""}` : "–")}
                      </span>
                    </span>
                    <span>
                      <span className="text-term-dim">Price : </span>
                      <span className="text-term-text">{c.price}</span>
                    </span>
                  </span>
                  <span className="whitespace-nowrap tabular-nums">
                    {c.trg != null && c.trg > 0 ? (
                      <>
                        <span className="text-term-dim">Trg </span>
                        <span className="text-term-text">{c.trg.toFixed(2)}</span>
                      </>
                    ) : c.avg != null && c.avg > 0 ? (
                      <>
                        <span className="text-term-dim">Avg </span>
                        <span className="text-term-text">{c.avg.toFixed(2)}</span>
                      </>
                    ) : null}
                  </span>
                </div>
                {c.reason && <div className="mt-1 text-[12px] leading-snug text-down/90">{c.reason}</div>}
                {expanded && (
                  <div
                    className="mt-2 flex justify-end border-t border-term-border/60 pt-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <OrderRowActions order={c.book} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** everything beyond the broker app's plain position list, in one place */
function AdvancedTab() {
  const broker = useStore((s) => s.broker);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {broker?.authed && (
        <div className="flex items-center gap-2 border-b border-term-border bg-term-panel px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-term-dim">
            Auto square-off
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
  // the mobile app has a dedicated Orders bottom-tab, so drop the sub-tab here
  const tabs = isMobile ? TABS.filter(([k]) => k !== "orders") : TABS;
  const [tab, setTab] = useState<Tab>(
    initialTab && (initialTab !== "orders" || !isMobile) ? initialTab : "broker"
  );
  const [count, setCount] = useState(0);
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
      {tab === "broker" && <BrokerTab onCount={setCount} />}
      {tab === "holdings" && <HoldingsTab />}
      {tab === "orders" && <OrdersTab />}
      {tab === "advanced" && <AdvancedTab />}
    </div>
  );
}
