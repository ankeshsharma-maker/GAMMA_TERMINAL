import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { api, type BrokerBracket } from "../lib/api";
import { nf, signColor, hhmm, sk } from "../lib/format";
import { StopEditor } from "./StopEditor";
import { useLiveMtm } from "../lib/useLiveMtm";
import { useIsMobile } from "../lib/useIsMobile";
import { LegBracketBadge, findBracket, type LegRule } from "./LegBracketBadge";

type Tab = "broker" | "holdings" | "orders";
const TABS: [Tab, string][] = [
  ["broker", "Broker Positions"],
  ["holdings", "Holdings"],
  ["orders", "Orders"],
];

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
function BrokerTab() {
  const broker = useStore((s) => s.broker);
  const { mark } = useLiveMtm();
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lots, setLots] = useState(1);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const loadRef = useRef<() => void>(() => {});

  // portfolio-level auto square-off bracket
  const [bracket, setBracket] = useState<BrokerBracket | null>(null);
  const [slAmt, setSlAmt] = useState("");
  const [tgtAmt, setTgtAmt] = useState("");
  const [bBasis, setBBasis] = useState<"today" | "mtm">("today");

  // per-position target/SL brackets (leg rules attached to an already-open position)
  const [legRules, setLegRules] = useState<LegRule[]>([]);
  const loadLegRules = () =>
    api.legRules().then((d) => setLegRules((d.rules || []) as LegRule[]), () => {});

  // portfolio-level net Greeks across every open live position
  const [greeks, setGreeks] = useState<{ delta: number; gamma: number; theta: number; vega: number } | null>(
    null
  );

  useEffect(() => {
    if (!broker?.authed) return;
    let alive = true;
    const load = () => {
      api.brokerPositions().then(
        (d) => alive && (setRows(d.positions || []), setErr(null)),
        (e) => alive && setErr(String(e.message || e))
      );
      api.brokerBracket().then((b) => alive && setBracket(b), () => {});
      api.portfolioGreeks().then((d) => alive && setGreeks(d.live), () => {});
      loadLegRules();
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

  const armBracket = async () => {
    const sl = parseFloat(slAmt) || 0;
    const tgt = parseFloat(tgtAmt) || 0;
    if (sl <= 0 && tgt <= 0) return;
    const lbl = bBasis === "today" ? "today's P&L" : "open MTM";
    const cond = `${sl > 0 ? `≤ −₹${nf(sl, 0)}` : ""}${sl > 0 && tgt > 0 ? " or " : ""}${
      tgt > 0 ? `≥ +₹${nf(tgt, 0)}` : ""
    }`;
    if (
      !window.confirm(
        `Auto square-off: flatten ALL broker positions with MARKET orders when ${lbl} is ${cond}.\nRuns on the server. Arm it now?`
      )
    )
      return;
    try {
      setBracket(
        await api.brokerBracketSet({
          enabled: true,
          slAmount: sl,
          targetAmount: tgt,
          basis: bBasis,
        })
      );
    } catch (e: any) {
      alert(String(e?.message || e));
    }
  };
  const disarmBracket = async () => {
    try {
      setBracket(await api.brokerBracketClear());
    } catch (e: any) {
      alert(String(e?.message || e));
    }
  };

  const trade = (r: any, side: "BUY" | "SELL") => {
    if (
      !window.confirm(`${side} ${lots} lot(s) of ${r.tsym} — real LIVE MARKET order. Continue?`)
    )
      return;
    withBusy(r.tsym, () =>
      api.brokerOrderTsym({ tsym: r.tsym, exch: r.exch || "NFO", side, lots, prd: r.prd })
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      {/* summary header */}
      <div className="mb-2 grid grid-cols-3 gap-2">
        {([
          ["Realised", totalRealized],
          ["MTM · vs entry", totalToday],
          ["P&L · prev close", totalDay],
        ] as const).map(([label, val]) => (
          <div key={label} className="rounded border border-term-border bg-term-bg/40 px-3 py-1.5">
            <div className="text-[9px] uppercase tracking-wide text-term-dim">{label}</div>
            <div className={`num text-base font-bold ${signColor(val)}`}>₹{nf(val, 0)}</div>
          </div>
        ))}
      </div>

      {/* portfolio auto square-off */}
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded border border-term-border bg-term-bg/40 px-2 py-1.5 text-2xs">
        <span className="font-semibold uppercase tracking-wide text-term-dim">⛨ Auto square-off</span>
        <div className="seg">
          {(["today", "mtm"] as const).map((b) => (
            <button key={b} onClick={() => setBBasis(b)} className={bBasis === b ? "on" : ""}>
              {b === "today" ? "Today P&L" : "MTM"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-term-dim">
          SL ₹
          <input
            value={slAmt}
            onChange={(e) => setSlAmt(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder="0"
            className="num w-20 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-term-text outline-none focus:border-down"
          />
        </label>
        <label className="flex items-center gap-1 text-term-dim">
          Target ₹
          <input
            value={tgtAmt}
            onChange={(e) => setTgtAmt(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder="0"
            className="num w-20 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-term-text outline-none focus:border-up"
          />
        </label>
        {bracket?.enabled ? (
          <button onClick={disarmBracket} className="btn ml-auto font-semibold text-amber-400">
            Disarm
          </button>
        ) : (
          <button
            onClick={armBracket}
            disabled={!parseFloat(slAmt) && !parseFloat(tgtAmt)}
            className="btn btn-sell ml-auto font-semibold disabled:opacity-40"
          >
            Arm
          </button>
        )}
        <span className="w-full text-[10px] text-term-dim">
          {bracket?.enabled
            ? `ARMED — flattens ALL when ${
                bracket.basis === "today" ? "today's P&L" : "MTM"
              } ${bracket.slAmount > 0 ? `≤ −₹${nf(bracket.slAmount, 0)}` : ""}${
                bracket.slAmount > 0 && bracket.targetAmount > 0 ? " or " : ""
              }${bracket.targetAmount > 0 ? `≥ +₹${nf(bracket.targetAmount, 0)}` : ""}${
                bracket.lastPnl != null ? ` · now ₹${nf(bracket.lastPnl, 0)}` : ""
              }`
            : bracket?.triggeredAt
            ? `⚠ ${bracket.lastReason}`
            : "server-side: MARKET-flattens every position when the P&L threshold is crossed (works with the app closed)."}
        </span>
      </div>

      <div className="mb-2 flex items-center gap-2 text-2xs">
        <span className="text-term-dim">Lots</span>
        <button className="btn px-1.5 py-0.5" onClick={() => setLots((l) => Math.max(1, l - 1))}>
          −
        </button>
        <span className="num w-5 text-center">{lots}</span>
        <button className="btn px-1.5 py-0.5" onClick={() => setLots((l) => l + 1)}>
          +
        </button>
        <button
          className="btn btn-sell ml-auto font-semibold disabled:opacity-40"
          disabled={withPnl.every((w) => (n(w.r.netqty) ?? 0) === 0)}
          onClick={squareOffAll}
          title="Flatten every open position in one click, no selection needed"
        >
          ⚡ Square off ALL
        </button>
        <button
          className="btn btn-sell disabled:opacity-40"
          disabled={selected.size === 0}
          onClick={squareOffSelected}
        >
          Square off selected ({selected.size})
        </button>
      </div>
      {/* select-all + count */}
      {withPnl.length > 0 && (
        <label className="mb-1 flex items-center gap-1.5 px-1 text-[10px] text-term-dim">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          {withPnl.length} position{withPnl.length > 1 ? "s" : ""} · tap a card to select
        </label>
      )}

      <div className="overflow-hidden rounded-lg border border-term-border">
        {withPnl.length === 0 && (
          <div className="px-3 py-6 text-center text-2xs text-term-dim">
            No open broker positions.
          </div>
        )}
        {withPnl.map(({ r, today, key }, i) => {
          const qty = n(r.netqty) ?? 0;
          const isBusy = busy.has(r.tsym);
          const avg = n(r.netavgprc) ?? n(r.daybuyavgprc) ?? n(r.daysellavgprc);
          const sel = selected.has(key);
          return (
            <div
              key={i}
              onClick={() => key && toggleOne(key)}
              className={`cursor-pointer border-b border-term-border/50 px-3 py-2 last:border-b-0 ${
                sel ? "bg-term-accent/10" : "hover:bg-term-panel/50"
              }`}
            >
              <div className="flex items-center justify-between text-[10px] text-term-dim">
                <span className="num">
                  Qty. <span className="text-term-text">{qty}</span> · Avg.{" "}
                  <span className="text-term-text">₹{nf(avg ?? 0, 2)}</span>
                </span>
                <span className="rounded bg-term-border/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-term-dim">
                  {r.prd ?? "NRML"}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between">
                <span className="num text-sm font-semibold text-term-text">
                  {r.dname ?? r.tsym ?? r.symname ?? "—"}
                </span>
                <span className={`num text-base font-bold ${signColor(today)}`}>
                  {nf(today, 2)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[10px] text-term-dim">
                <span className="uppercase tracking-wide">
                  {(r.exch ?? "NFO")} · MKT · DAY
                </span>
                <span className="num">
                  LTP <span className="text-term-text">{nf(n(r.lp), 2)}</span>
                </span>
              </div>

              {!!qty && (
                <div className="mt-1" onClick={(e) => e.stopPropagation()}>
                  <LegBracketBadge
                    r={r}
                    bracket={findBracket(r, legRules)}
                    onChanged={loadLegRules}
                  />
                </div>
              )}

              <div
                className="mt-1.5 flex items-center gap-1.5"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  disabled={isBusy}
                  onClick={() => trade(r, "BUY")}
                  className="rounded bg-up/15 px-2 py-0.5 text-[10px] font-bold text-up hover:bg-up/30 disabled:opacity-40"
                  title={`Buy ${lots} lot(s) live`}
                >
                  Buy
                </button>
                <button
                  disabled={isBusy}
                  onClick={() => trade(r, "SELL")}
                  className="rounded bg-down/15 px-2 py-0.5 text-[10px] font-bold text-down hover:bg-down/30 disabled:opacity-40"
                  title={`Sell ${lots} lot(s) live`}
                >
                  Sell
                </button>
                <button
                  disabled={isBusy || !qty}
                  onClick={() => squareOff(r)}
                  className="ml-auto rounded border border-down/50 px-2 py-0.5 text-[10px] font-semibold text-down hover:bg-down/10 disabled:opacity-30"
                  title="Flatten this position with an opposite-side MARKET order"
                >
                  {isBusy ? "…" : "Square off"}
                </button>
              </div>
            </div>
          );
        })}
        {withPnl.length > 0 && (
          <div className="flex items-center justify-between bg-term-panel2 px-3 py-2 text-2xs font-semibold">
            <span className="flex items-center gap-1.5 uppercase text-term-dim">
              Total
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  broker?.wsConnected ? "bg-up" : "bg-amber-500 animate-pulse"
                }`}
                title={
                  broker?.wsConnected
                    ? "Live tick feed connected — MTM re-marks on every tick"
                    : "Live tick feed down — MTM is on the ~4s REST poll instead of tick-by-tick (Flattrade WS disconnected, e.g. another session using the same login)"
                }
              />
            </span>
            <span className="num flex gap-3">
              <span className={signColor(totalMtm)}>MTM ₹{nf(totalMtm, 0)}</span>
              <span className={signColor(totalRealized)}>Rlz ₹{nf(totalRealized, 0)}</span>
              <span className={signColor(totalToday)}>P&amp;L ₹{nf(totalToday, 0)}</span>
            </span>
          </div>
        )}
        {withPnl.length > 0 && greeks && (
          <div
            className="flex items-center justify-between bg-term-panel2 px-3 py-1.5 text-2xs"
            title="Net Greeks summed across every open live position, from each leg's current per-unit Greek × its signed quantity"
          >
            <span className="uppercase text-term-dim">Net Greeks</span>
            <span className="num flex gap-3">
              <span className={signColor(greeks.delta)}>Δ {nf(greeks.delta, 1)}</span>
              <span className={signColor(greeks.gamma)}>Γ {nf(greeks.gamma, 3)}</span>
              <span className={signColor(greeks.theta)}>Θ {nf(greeks.theta, 1)}</span>
              <span className={signColor(greeks.vega)}>V {nf(greeks.vega, 1)}</span>
            </span>
          </div>
        )}
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
          className="rounded border border-term-border px-1.5 py-0.5 text-[10px] text-term-dim hover:text-term-text disabled:opacity-40"
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

export function OrdersTab() {
  const broker = useStore((s) => s.broker);
  const paper = useStore((s) => s.paper);
  const orderMode = useStore((s) => s.orderMode);
  const [src, setSrc] = useState<"live" | "paper">(orderMode === "live" ? "live" : "paper");
  const [book, setBook] = useState<any[]>([]);
  const [liveLog, setLiveLog] = useState<any[]>([]);
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

  const [filter, setFilter] = useState<"all" | "open" | "executed" | "cancelled">("all");

  const stCls = (s: string) =>
    /complete|placed|filled/i.test(s) ? "text-up" : /reject|cancel/i.test(s) ? "text-down" : "text-term-dim";

  const stBucket = (s: string): "open" | "executed" | "cancelled" | "other" => {
    if (/complete|filled|placed|traded/i.test(s)) return "executed";
    if (/cancel|reject/i.test(s)) return "cancelled";
    if (/open|pending|trigger|received/i.test(s)) return "open";
    return "other";
  };
  const passFilter = (s: string) => filter === "all" || stBucket(s || "") === filter;

  const tsOf = (o: any): number => {
    const raw = o?.ts ?? o?.time ?? o?.norentm ?? o?.exch_tm ?? o?.orderTime;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const d = raw ? new Date(raw) : null;
    return d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
  };

  // unified session order history: live-routed + paper
  const log = [
    ...liveLog.map((o) => ({ ...o, _ms: tsOf(o) })),
    ...(paper?.orders ?? []).map((o) => ({
      _ms: tsOf(o),
      ts: o.ts,
      symbol: o.symbol,
      strike: o.strike,
      optionType: o.optionType,
      side: o.side,
      qtyLots: o.qtyLots,
      qty: o.qty,
      mode: "paper",
      status: "FILLED",
      orderId: `@${nf(o.price)}`,
    })),
  ].sort((a, b) => b._ms - a._ms);

  const isPaper = (o: any) => (o.mode || "").toLowerCase() === "paper";
  const shownLog = log.filter(
    (o) => passFilter(o.status || "") && (src === "paper" ? isPaper(o) : !isPaper(o))
  );
  const shownBook = book.filter((o) => passFilter(o.status || ""));

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
        <div className="seg text-[11px]">
          {(["live", "paper"] as const).map((s) => (
            <button key={s} onClick={() => setSrc(s)} className={src === s ? "on" : ""}>
              {s === "live" ? "Live" : "Paper"}
            </button>
          ))}
        </div>
        <span className="text-[10px] font-semibold uppercase text-term-dim">
          {src === "live" ? "Live" : "Paper"} orders · placed &amp; status
        </span>
        <div className="seg ml-auto text-[10px]">
          {(["all", "open", "executed", "cancelled"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={filter === f ? "on" : ""}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {shownLog.length === 0 ? (
        <Empty>
          {src === "live"
            ? filter === "all"
              ? "No live orders this session."
              : `No ${filter} live orders.`
            : filter === "all"
            ? "No paper orders this session."
            : `No ${filter} paper orders.`}
        </Empty>
      ) : (
        <table className="grid-table text-xs">
          <thead className="sticky top-0 z-10 bg-term-panel text-[10px] uppercase text-term-dim">
            <tr>
              <TH>Time</TH>
              <TH>Contract</TH>
              <TH>Side</TH>
              <TH>Lots</TH>
              <TH>Total Qty</TH>
              <TH>Mode</TH>
              <TH>Status</TH>
              <TH>Ref / reason</TH>
            </tr>
          </thead>
          <tbody>
            {shownLog.map((o, i) => (
              <tr key={i}>
                <TD cls="num text-term-dim">{o._ms ? hhmm(o._ms) : "–"}</TD>
                <TD cls="num">
                  {o.symbol} {sk(o.strike)}
                  {o.optionType}
                </TD>
                <TD cls={o.side === "BUY" ? "text-up" : "text-down"}>{o.side}</TD>
                <TD cls="num">{o.qtyLots ?? "–"}</TD>
                <TD cls="num font-medium text-term-text">{o.qty ?? "–"}</TD>
                <TD cls="text-term-dim">{o.mode}</TD>
                <TD cls={stCls(o.status || "")}>{o.status}</TD>
                <TD cls="text-[10px] text-term-dim">{o.error || o.orderId || o.tsym || ""}</TD>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {src === "live" && broker?.authed && (
        <>
          <div className="mt-2 px-3 py-1.5 text-[10px] font-semibold uppercase text-term-dim">
            Flattrade order book
          </div>
          {shownBook.length === 0 ? (
            <Empty>{filter === "all" ? "Order book empty." : `No ${filter} orders.`}</Empty>
          ) : (
            <table className="grid-table text-xs">
              <thead className="sticky top-0 z-10 bg-term-panel text-[10px] uppercase text-term-dim">
                <tr>
                  <TH>Symbol</TH>
                  <TH>Side</TH>
                  <TH>Total Qty</TH>
                  <TH>Price</TH>
                  <TH>Status</TH>
                  <TH>Reason</TH>
                  <TH>Action</TH>
                </tr>
              </thead>
              <tbody>
                {shownBook.map((o, i) => (
                  <tr key={i}>
                    <TD cls="num">{o.tsym}</TD>
                    <TD cls={o.trantype === "B" ? "text-up" : "text-down"}>
                      {o.trantype === "B" ? "BUY" : "SELL"}
                    </TD>
                    <TD cls="num font-medium text-term-text">{o.qty}</TD>
                    <TD cls="num">{nf(n(o.prc))}</TD>
                    <TD cls={stCls(o.status || "")}>{o.status}</TD>
                    <TD cls="text-[10px] text-term-dim">{o.rejreason || ""}</TD>
                    <TD>
                      {stBucket(o.status || "") === "open" && o.norenordno ? (
                        <OrderRowActions order={o} />
                      ) : (
                        <span className="text-term-dim">—</span>
                      )}
                    </TD>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
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
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded px-2.5 py-1 ${
              tab === k ? "bg-term-accent text-white" : "text-term-dim hover:bg-term-border"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "broker" && <BrokerTab />}
      {tab === "holdings" && <HoldingsTab />}
      {tab === "orders" && <OrdersTab />}
    </div>
  );
}
