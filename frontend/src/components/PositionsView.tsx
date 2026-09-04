import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, signColor, hhmm, sk } from "../lib/format";
import { StopEditor } from "./StopEditor";

type Tab = "paper" | "broker" | "holdings" | "orders";
const TABS: [Tab, string][] = [
  ["paper", "Paper"],
  ["broker", "Broker Positions"],
  ["holdings", "Holdings"],
  ["orders", "Orders"],
];

const n = (v: any) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

function Tile({ label, value, cls = "" }: { label: string; value: React.ReactNode; cls?: string }) {
  return (
    <div className="rounded border border-term-border bg-term-panel px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-term-dim">{label}</div>
      <div className={`num text-base font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

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

// ---------------- Paper ----------------
function PaperTab() {
  const { paper, closePosition } = useStore();
  if (!paper) return <Empty>loading…</Empty>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
        <Tile label="Today's P&L" value={`₹${nf(paper.todayPnl, 0)}`} cls={signColor(paper.todayPnl)} />
        <Tile label="Realized" value={`₹${nf(paper.realized, 0)}`} cls={signColor(paper.realized)} />
        <Tile label="Unrealized" value={`₹${nf(paper.unrealized, 0)}`} cls={signColor(paper.unrealized)} />
        <Tile label="Total P&L" value={`₹${nf(paper.total, 0)}`} cls={signColor(paper.total)} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 pt-0">
        <table className="w-full border-separate border-spacing-0 border border-term-border text-xs">
          <thead className="sticky top-0 z-10 bg-term-panel text-[10px] uppercase text-term-dim">
            <tr>
              <TH>Contract</TH>
              <TH>Side</TH>
              <TH>Qty</TH>
              <TH>Avg</TH>
              <TH>LTP</TH>
              <TH>P&L</TH>
              <TH>Stop-loss</TH>
              <TH> </TH>
            </tr>
          </thead>
          <tbody>
            {paper.positions.length === 0 && (
              <tr>
                <td colSpan={8} className="border-b border-term-border">
                  <Empty>No open paper positions. Use B / S on the chain or Execute a strategy.</Empty>
                </td>
              </tr>
            )}
            {paper.positions.map((p) => (
              <tr key={p.id}>
                <TD cls="num font-medium">
                  {p.symbol} {sk(p.strike)} {p.optionType}
                  <span className="ml-2 text-[10px] text-term-dim">{p.expiry}</span>
                </TD>
                <TD cls={p.qty > 0 ? "text-up" : "text-down"}>{p.qty > 0 ? "LONG" : "SHORT"}</TD>
                <TD cls="num">
                  {Math.abs(p.qty / p.lotSize)}L ({Math.abs(p.qty)})
                </TD>
                <TD cls="num">{nf(p.avgPrice)}</TD>
                <TD cls="num">{nf(p.ltp)}</TD>
                <TD cls={`num ${signColor(p.pnl)}`}>₹{nf(p.pnl, 0)}</TD>
                <TD>
                  <StopEditor p={p} />
                </TD>
                <TD>
                  <button className="btn px-2 py-0.5 text-[10px]" onClick={() => closePosition(p.id)}>
                    Square off
                  </button>
                </TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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

  useEffect(() => {
    if (!broker?.authed) return;
    let alive = true;
    const load = () =>
      api.brokerPositions().then(
        (d) => alive && (setRows(d.positions || []), setErr(null)),
        (e) => alive && setErr(String(e.message || e))
      );
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
  if (rows.length === 0) return <Empty>No open broker positions.</Empty>;

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

  const stCls = (s: string) =>
    /complete|placed|filled/i.test(s) ? "text-up" : /reject/i.test(s) ? "text-down" : "text-term-dim";

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

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="px-3 py-1.5 text-[10px] font-semibold uppercase text-term-dim">
        Session order history
      </div>
      {log.length === 0 ? (
        <Empty>No orders this session.</Empty>
      ) : (
        <table className="w-full border-separate border-spacing-0 border border-term-border text-xs">
          <thead className="sticky top-0 z-10 bg-term-panel text-[10px] uppercase text-term-dim">
            <tr>
              <TH>Time</TH>
              <TH>Contract</TH>
              <TH>Side</TH>
              <TH>Qty</TH>
              <TH>Mode</TH>
              <TH>Status</TH>
              <TH>Ref / reason</TH>
            </tr>
          </thead>
          <tbody>
            {log.map((o, i) => (
              <tr key={i}>
                <TD cls="num text-term-dim">{hhmm(o.ts)}</TD>
                <TD cls="num">
                  {o.symbol} {sk(o.strike)}
                  {o.optionType}
                </TD>
                <TD cls={o.side === "BUY" ? "text-up" : "text-down"}>{o.side}</TD>
                <TD cls="num">
                  {o.qtyLots}L {o.qty ? `(${o.qty})` : ""}
                </TD>
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
          {book.length === 0 ? (
            <Empty>Order book empty.</Empty>
          ) : (
            <table className="w-full border-separate border-spacing-0 border border-term-border text-xs">
              <thead className="sticky top-0 z-10 bg-term-panel text-[10px] uppercase text-term-dim">
                <tr>
                  <TH>Symbol</TH>
                  <TH>Side</TH>
                  <TH>Qty</TH>
                  <TH>Price</TH>
                  <TH>Status</TH>
                  <TH>Reason</TH>
                </tr>
              </thead>
              <tbody>
                {book.map((o, i) => (
                  <tr key={i}>
                    <TD cls="num">{o.tsym}</TD>
                    <TD cls={o.trantype === "B" ? "text-up" : "text-down"}>
                      {o.trantype === "B" ? "BUY" : "SELL"}
                    </TD>
                    <TD cls="num">{o.qty}</TD>
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

export function PositionsView() {
  const [tab, setTab] = useState<Tab>("paper");
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
      {tab === "paper" && <PaperTab />}
      {tab === "broker" && <BrokerTab />}
      {tab === "holdings" && <HoldingsTab />}
      {tab === "orders" && <OrdersTab />}
    </div>
  );
}
