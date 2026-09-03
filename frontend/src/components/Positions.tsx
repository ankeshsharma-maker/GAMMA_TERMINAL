import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, signColor, sk } from "../lib/format";
import { StopEditor } from "./StopEditor";

function MarginBar() {
  const broker = useStore((s) => s.broker);
  const funds = useStore((s) => s.brokerFunds);
  const paper = useStore((s) => s.paper);
  const orderMode = useStore((s) => s.orderMode);

  const live = orderMode === "live" && funds?.connected && funds.available != null;
  const avail = live ? funds!.available! : paper?.marginAvailable ?? null;
  const used = live ? funds!.used! : paper?.marginUsed ?? null;
  const total = live ? funds!.total ?? null : paper?.capital ?? null;
  const pct = total && used != null ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;

  return (
    <div className="border-b border-term-border bg-term-panel/40 px-3 py-1.5 text-2xs">
      <div className="flex items-center justify-between">
        <span className={live ? "text-up" : "text-term-dim"}>
          {live ? `◈ Flattrade ${broker?.clientId ?? ""}` : "Paper margin"}
        </span>
        <span className="num text-term-dim">
          used <span className="text-amber-400">₹{avail != null ? nf(used ?? 0, 0) : "–"}</span> /{" "}
          {total != null ? `₹${nf(total, 0)}` : "–"}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-term-border">
        <div className="h-full bg-amber-500" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-0.5 flex justify-between">
        <span className="num text-up">available ₹{avail != null ? nf(avail, 0) : "–"}</span>
        {funds?.error && <span className="text-down">{funds.error}</span>}
      </div>
    </div>
  );
}

function LiveOrderLog() {
  const orderMode = useStore((s) => s.orderMode);
  const broker = useStore((s) => s.broker);
  const [orders, setOrders] = useState<any[]>([]);
  useEffect(() => {
    if (orderMode !== "live" && !broker?.authed) return;
    let alive = true;
    const load = () =>
      api.liveOrderLog().then((d) => alive && setOrders(d.orders), () => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [orderMode, broker?.authed]);

  if (orders.length === 0) return null;
  return (
    <>
      <div className="border-t border-term-border px-3 py-1 text-2xs font-semibold uppercase text-down">
        Live Orders
      </div>
      <div className="max-h-40 overflow-y-auto">
        {orders.map((o, i) => (
          <div key={i} className="border-b border-term-border/40 px-3 py-1 text-[10px]">
            <div className="flex items-center justify-between">
              <span className={o.side === "BUY" ? "text-up" : "text-down"}>
                {o.side} {o.qtyLots}L {sk(o.strike)}
                {o.optionType}
              </span>
              <span
                className={
                  o.status === "PLACED" ? "text-up" : o.status === "REJECTED" ? "text-down" : "text-term-dim"
                }
              >
                {o.status}
              </span>
            </div>
            {o.error && <div className="text-down/80">{o.error}</div>}
            {o.orderId && <div className="num text-term-dim">#{o.orderId}</div>}
          </div>
        ))}
      </div>
    </>
  );
}

export function Positions() {
  const { paper, closePosition } = useStore();

  return (
    <div className="flex h-full flex-col bg-term-panel2">
      <MarginBar />
      <div className="flex items-center justify-between border-b border-term-border px-3 py-2">
        <span className="text-2xs font-semibold uppercase tracking-wide text-term-dim">
          Paper Positions
        </span>
        {paper && (
          <span className={`num text-xs font-semibold ${signColor(paper.total)}`}>
            ₹{nf(paper.total, 0)}
          </span>
        )}
      </div>

      {paper && (
        <div className="grid grid-cols-2 gap-px border-b border-term-border bg-term-border text-2xs">
          <div className="bg-term-panel2 px-3 py-1">
            <div className="text-term-dim">Realized</div>
            <div className={`num ${signColor(paper.realized)}`}>₹{nf(paper.realized, 0)}</div>
          </div>
          <div className="bg-term-panel2 px-3 py-1">
            <div className="text-term-dim">Unrealized</div>
            <div className={`num ${signColor(paper.unrealized)}`}>₹{nf(paper.unrealized, 0)}</div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {(!paper || paper.positions.length === 0) && (
          <div className="p-4 text-center text-2xs text-term-dim">
            No open positions. Hit B / S on the chain.
          </div>
        )}
        {paper?.positions.map((p) => (
          <div key={p.id} className="border-b border-term-border/50 px-3 py-1.5 text-2xs">
            <div className="flex items-center justify-between">
              <div className="flex flex-col leading-tight">
                <span className="font-medium">
                  {p.symbol} {sk(p.strike)} {p.optionType}
                </span>
                <span className="text-term-dim num">
                  {p.qty > 0 ? "LONG" : "SHORT"} {Math.abs(p.qty / p.lotSize)}L @ {nf(p.avgPrice)}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="num">{nf(p.ltp)}</div>
                  <div className={`num ${signColor(p.pnl)}`}>₹{nf(p.pnl, 0)}</div>
                </div>
                <button
                  onClick={() => closePosition(p.id)}
                  className="btn px-1.5 py-0.5 text-[10px]"
                  title="Square off"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="mt-0.5">
              <StopEditor p={p} />
            </div>
          </div>
        ))}
      </div>

      <LiveOrderLog />

      <div className="border-t border-term-border px-3 py-1 text-2xs font-semibold uppercase text-term-dim">
        Paper Order Log
      </div>
      <div className="h-40 overflow-y-auto">
        {paper?.orders.map((o) => (
          <div
            key={o.id}
            className="flex items-center justify-between border-b border-term-border/40 px-3 py-1 text-[10px]"
          >
            <span className={o.side === "BUY" ? "text-up" : "text-down"}>
              {o.side} {o.qtyLots}L
            </span>
            <span className="num text-term-dim">
              {o.symbol} {sk(o.strike)}
              {o.optionType}
            </span>
            <span className="num">{nf(o.price)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
