import { useEffect, useState } from "react";
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
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead className="sticky top-0 bg-term-panel text-[10px] uppercase text-term-dim">
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
                <td colSpan={8}>
                  <Empty>No open paper positions. Use B / S on the chain or Execute a strategy.</Empty>
                </td>
              </tr>
            )}
            {paper.positions.map((p) => (
              <tr key={p.id} className="border-b border-term-border/40">
                <td className="num px-3 py-1.5 font-medium">
                  {p.symbol} {sk(p.strike)} {p.optionType}
                  <span className="ml-2 text-[10px] text-term-dim">{p.expiry}</span>
                </td>
                <td className={`px-3 py-1.5 ${p.qty > 0 ? "text-up" : "text-down"}`}>
                  {p.qty > 0 ? "LONG" : "SHORT"}
                </td>
                <td className="num px-3 py-1.5">{Math.abs(p.qty / p.lotSize)}L ({Math.abs(p.qty)})</td>
                <td className="num px-3 py-1.5">{nf(p.avgPrice)}</td>
                <td className="num px-3 py-1.5">{nf(p.ltp)}</td>
                <td className={`num px-3 py-1.5 ${signColor(p.pnl)}`}>₹{nf(p.pnl, 0)}</td>
                <td className="px-3 py-1.5">
                  <StopEditor p={p} />
                </td>
                <td className="px-3 py-1.5">
                  <button className="btn px-2 py-0.5 text-[10px]" onClick={() => closePosition(p.id)}>
                    Square off
                  </button>
                </td>
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
  useEffect(() => {
    if (!broker?.authed) return;
    let alive = true;
    const load = () =>
      api.brokerPositions().then(
        (d) => alive && (setRows(d.positions || []), setErr(null)),
        (e) => alive && setErr(String(e.message || e))
      );
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

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead className="sticky top-0 bg-term-panel text-[10px] uppercase text-term-dim">
          <tr>
            <TH>Symbol</TH>
            <TH>Product</TH>
            <TH>Net Qty</TH>
            <TH>Avg</TH>
            <TH>LTP</TH>
            <TH>MTM</TH>
            <TH>Realized</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const qty = n(r.netqty) ?? 0;
            const mtm = n(r.urmtom) ?? n(r.mtm);
            const rpnl = n(r.rpnl);
            return (
              <tr key={i} className="border-b border-term-border/40">
                <td className="num px-3 py-1.5 font-medium">{r.tsym ?? r.symname ?? "—"}</td>
                <td className="px-3 py-1.5 text-term-dim">{r.prd ?? "—"}</td>
                <td className={`num px-3 py-1.5 ${qty > 0 ? "text-up" : qty < 0 ? "text-down" : ""}`}>{qty}</td>
                <td className="num px-3 py-1.5">{nf(n(r.netavgprc) ?? n(r.daybuyavgprc))}</td>
                <td className="num px-3 py-1.5">{nf(n(r.lp))}</td>
                <td className={`num px-3 py-1.5 ${signColor(mtm)}`}>{mtm != null ? `₹${nf(mtm, 0)}` : "—"}</td>
                <td className={`num px-3 py-1.5 ${signColor(rpnl)}`}>{rpnl != null ? `₹${nf(rpnl, 0)}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
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
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead className="sticky top-0 bg-term-panel text-[10px] uppercase text-term-dim">
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
              <tr key={i} className="border-b border-term-border/40">
                <td className="num px-3 py-1.5 font-medium">{sym}</td>
                <td className="num px-3 py-1.5">{qty}</td>
                <td className="num px-3 py-1.5">{nf(avg)}</td>
                <td className="num px-3 py-1.5">{nf(ltp)}</td>
                <td className={`num px-3 py-1.5 ${signColor(pnl)}`}>{pnl != null ? `₹${nf(pnl, 0)}` : "—"}</td>
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
