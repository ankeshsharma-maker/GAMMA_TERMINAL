import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { api, type BrokerBracket } from "../lib/api";
import { nf, signColor, hhmm, sk } from "../lib/format";
import { StopEditor } from "./StopEditor";

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

  useEffect(() => {
    if (!broker?.authed) return;
    let alive = true;
    const load = () => {
      api.brokerPositions().then(
        (d) => alive && (setRows(d.positions || []), setErr(null)),
        (e) => alive && setErr(String(e.message || e))
      );
      api.brokerBracket().then((b) => alive && setBracket(b), () => {});
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
  const withPnl = rows.map((r) => {
    const mtm = n(r.urmtom) ?? n(r.mtm) ?? 0;
    const rpnl = n(r.rpnl) ?? 0;
    totalMtm += mtm;
    totalRealized += rpnl;
    return { r, mtm, rpnl, today: mtm + rpnl, key: String(r.tsym ?? r.symname ?? "") };
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
          ["Realised P&L", totalRealized],
          ["MTM (open)", totalMtm],
          ["Today's P&L", totalToday],
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
      <table className="w-full border-separate border-spacing-0 border border-term-border text-xs">
        <thead className="sticky top-0 z-10 bg-term-panel text-[10px] uppercase text-term-dim">
          <tr>
            <th className="border-b border-r border-term-border px-2 py-1.5">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            </th>
            <TH>Symbol</TH>
            <TH>Product</TH>
            <TH>Net Qty</TH>
            <TH>Avg</TH>
            <TH>LTP</TH>
            <TH>MTM</TH>
            <TH>Realized</TH>
            <TH>Today's P&L</TH>
            <TH>Trade</TH>
            <TH> </TH>
          </tr>
        </thead>
        <tbody>
          {withPnl.length === 0 && (
            <tr>
              <TD cls="text-center text-term-dim">
                <span className="block py-3">No open broker positions.</span>
              </TD>
              <td colSpan={10} />
            </tr>
          )}
          {withPnl.map(({ r, mtm, rpnl, today, key }, i) => {
            const qty = n(r.netqty) ?? 0;
            const isBusy = busy.has(r.tsym);
            return (
              <tr key={i}>
                <td className="border-b border-r border-term-border/50 px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    onChange={() => toggleOne(key)}
                    disabled={!key}
                  />
                </td>
                <TD cls="num font-medium">{r.tsym ?? r.symname ?? "—"}</TD>
                <TD cls="text-term-dim">{r.prd ?? "—"}</TD>
                <TD cls={`num ${qty > 0 ? "text-up" : qty < 0 ? "text-down" : ""}`}>{qty}</TD>
                <TD cls="num">{nf(n(r.netavgprc) ?? n(r.daybuyavgprc))}</TD>
                <TD cls="num">{nf(n(r.lp))}</TD>
                <TD cls={`num ${signColor(mtm)}`}>₹{nf(mtm, 0)}</TD>
                <TD cls={`num ${signColor(rpnl)}`}>₹{nf(rpnl, 0)}</TD>
                <TD cls={`num ${signColor(today)}`}>₹{nf(today, 0)}</TD>
                <TD>
                  <div className="flex gap-0.5">
                    <button
                      disabled={isBusy}
                      onClick={() => trade(r, "BUY")}
                      className="rounded bg-up/15 px-1.5 text-[10px] font-bold text-up hover:bg-up/30 disabled:opacity-40"
                      title={`Buy ${lots} lot(s) live`}
                    >
                      B
                    </button>
                    <button
                      disabled={isBusy}
                      onClick={() => trade(r, "SELL")}
                      className="rounded bg-down/15 px-1.5 text-[10px] font-bold text-down hover:bg-down/30 disabled:opacity-40"
                      title={`Sell ${lots} lot(s) live`}
                    >
                      S
                    </button>
                  </div>
                </TD>
                <TD>
                  <button
                    disabled={isBusy || !qty}
                    onClick={() => squareOff(r)}
                    className="btn px-1.5 py-0.5 text-[10px] hover:text-down disabled:opacity-40"
                    title="Flatten this position with an opposite-side MARKET order"
                  >
                    {isBusy ? "…" : "Square off"}
                  </button>
                </TD>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="bg-term-panel2 font-semibold">
            <TD>{" "}</TD>
            <TD cls="font-semibold">TOTAL</TD>
            <TD>{" "}</TD>
            <TD>{" "}</TD>
            <TD>{" "}</TD>
            <TD>{" "}</TD>
            <TD cls={`num ${signColor(totalMtm)}`}>₹{nf(totalMtm, 0)}</TD>
            <TD cls={`num ${signColor(totalRealized)}`}>₹{nf(totalRealized, 0)}</TD>
            <TD cls={`num ${signColor(totalToday)}`}>₹{nf(totalToday, 0)}</TD>
            <TD>{" "}</TD>
            <TD>{" "}</TD>
          </tr>
        </tfoot>
      </table>
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
      <table className="w-full border-separate border-spacing-0 border border-term-border text-xs">
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
function OrdersTab() {
  const broker = useStore((s) => s.broker);
  const paper = useStore((s) => s.paper);
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

  // unified session order history: live-routed + paper
  const log = [
    ...liveLog,
    ...(paper?.orders ?? []).map((o) => ({
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
  ].sort((a, b) => b.ts - a.ts);

  const shownLog = log.filter((o) => passFilter(o.status || ""));
  const shownBook = book.filter((o) => passFilter(o.status || ""));

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase text-term-dim">Session order history</span>
        <div className="seg ml-auto text-[10px]">
          {(["all", "open", "executed", "cancelled"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={filter === f ? "on" : ""}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {shownLog.length === 0 ? (
        <Empty>{filter === "all" ? "No orders this session." : `No ${filter} orders.`}</Empty>
      ) : (
        <table className="w-full border-separate border-spacing-0 border border-term-border text-xs">
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
                <TD cls="num text-term-dim">{hhmm(o.ts)}</TD>
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

      {broker?.authed && (
        <>
          <div className="mt-2 px-3 py-1.5 text-[10px] font-semibold uppercase text-term-dim">
            Flattrade order book
          </div>
          {shownBook.length === 0 ? (
            <Empty>{filter === "all" ? "Order book empty." : `No ${filter} orders.`}</Empty>
          ) : (
            <table className="w-full border-separate border-spacing-0 border border-term-border text-xs">
              <thead className="sticky top-0 z-10 bg-term-panel text-[10px] uppercase text-term-dim">
                <tr>
                  <TH>Symbol</TH>
                  <TH>Side</TH>
                  <TH>Total Qty</TH>
                  <TH>Price</TH>
                  <TH>Status</TH>
                  <TH>Reason</TH>
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
  const [tab, setTab] = useState<Tab>(initialTab ?? "broker");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs">
        {TABS.map(([k, label]) => (
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
