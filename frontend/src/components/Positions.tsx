import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, signColor, sk } from "../lib/format";
import { StopEditor } from "./StopEditor";
import { isViewer } from "../lib/auth";
import { useLiveMtm } from "../lib/useLiveMtm";

function PnlTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-term-panel2 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-term-dim">{label}</div>
      <div className={`num text-sm font-semibold ${signColor(value)}`}>
        {value >= 0 ? "+" : ""}
        ₹{nf(value, 0)}
      </div>
    </div>
  );
}

function LiveOrderLog() {
  const orderMode = useStore((s) => s.orderMode);
  const broker = useStore((s) => s.broker);
  const [orders, setOrders] = useState<any[]>([]);
  useEffect(() => {
    if (orderMode !== "live") return;
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
        <table className="grid-table text-[10px]">
          <thead className="sticky top-0 bg-term-panel2 text-term-dim">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Side / qty</th>
              <th className="px-2 py-1 text-left font-medium">Contract</th>
              <th className="px-2 py-1 text-left font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o, i) => (
              <tr key={i} className="border-b border-term-border/40 align-top">
                <td className={`num px-2 py-1 ${o.side === "BUY" ? "text-up" : "text-down"}`}>
                  {o.side} {o.qtyLots}L
                </td>
                <td className="num px-2 py-1">
                  {sk(o.strike)}
                  {o.optionType}
                </td>
                <td className="px-2 py-1">
                  <div
                    className={
                      o.status === "PLACED"
                        ? "text-up"
                        : o.status === "REJECTED"
                        ? "text-down"
                        : "text-term-dim"
                    }
                  >
                    {o.status}
                  </div>
                  {o.error && <div className="text-down/80">{o.error}</div>}
                  {o.orderId && <div className="num text-term-dim">#{o.orderId}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const numOf = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Live mode: the Flattrade book only (read-only here; square off / manage in the Positions tab) */
function LivePositionsPane() {
  const broker = useStore((s) => s.broker);
  const { mark } = useLiveMtm();
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!broker?.authed) {
      setRows([]);
      return;
    }
    let alive = true;
    const load = () =>
      api.brokerPositions().then(
        (d) => alive && (setRows(d.positions || []), setErr(null)),
        (e) => alive && setErr(String(e?.message || e))
      );
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [broker?.authed]);

  const mtmOf = (r: any) => mark(r) ?? numOf(r.urmtom ?? r.mtm);
  const open = rows.filter((r) => numOf(r.netqty) !== 0 || numOf(r.rpnl) !== 0);
  const mtm = open.reduce((a, r) => a + mtmOf(r), 0);
  const rpnl = open.reduce((a, r) => a + numOf(r.rpnl), 0);

  return (
    <div className="flex h-full flex-col bg-term-panel2">
      <div className="grid grid-cols-2 gap-px border-b border-term-border bg-term-border">
        <PnlTile label="MTM" value={mtm} />
        <PnlTile label="Today's P&L" value={mtm + rpnl} />
      </div>
      <div className="flex items-center gap-2 border-b border-term-border px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide">
        <span className="rounded bg-down px-1.5 py-0.5 text-[10px] text-white">LIVE</span>
        <span className="text-term-dim">Flattrade positions</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {!broker?.authed && (
          <div className="p-4 text-center text-2xs text-term-dim">Connect Flattrade (header) to see live positions.</div>
        )}
        {broker?.authed && err && <div className="p-4 text-center text-2xs text-down">{err}</div>}
        {broker?.authed && !err && open.length === 0 && (
          <div className="p-4 text-center text-2xs text-term-dim">No open live positions today.</div>
        )}
        {broker?.authed && !err && open.length > 0 && (
          <table className="grid-table text-[10px]">
            <thead className="sticky top-0 bg-term-panel2 text-term-dim">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Contract</th>
                <th className="px-2 py-1 text-right font-medium">LTP</th>
                <th className="px-2 py-1 text-right font-medium">MTM</th>
              </tr>
            </thead>
            <tbody>
              {open.map((r, i) => {
                const qty = numOf(r.netqty);
                const lot = numOf(r.ls ?? r.lotsize);
                return (
                  <tr key={String(r.tsym ?? i)} className="border-b border-term-border/50 align-top">
                    <td className="px-2 py-1.5">
                      <div className="font-medium">{r.dname ?? r.tsym}</div>
                      <div className="num text-term-dim">
                        {qty === 0 ? "flat" : `${qty > 0 ? "LONG" : "SHORT"} ${lot ? Math.abs(qty / lot) : Math.abs(qty)}${lot ? "L" : ""}`}
                      </div>
                    </td>
                    <td className="num px-2 py-1.5 text-right">{nf(numOf(r.lp))}</td>
                    <td className={`num px-2 py-1.5 text-right ${signColor(mtmOf(r))}`}>{nf(mtmOf(r), 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <LiveOrderLog />
    </div>
  );
}

/** Paper mode: this session's paper positions only; Live mode: the Flattrade book only */
export function Positions({ embedded = false }: { embedded?: boolean } = {}) {
  const orderMode = useStore((s) => s.orderMode);
  if (!isViewer() && orderMode === "live") return <LivePositionsPane />;
  return <PaperPositionsPane embedded={embedded} />;
}

function PaperPositionsPane({ embedded = false }: { embedded?: boolean }) {
  const { paper, closePosition } = useStore();

  return (
    <div className="flex h-full flex-col bg-term-panel2">
      {paper && (
        <div className="grid grid-cols-2 gap-px border-b border-term-border bg-term-border">
          <PnlTile label="Today's P&L" value={paper.todayPnl} />
          <PnlTile label="Total P&L" value={paper.total} />
        </div>
      )}
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

      {!embedded && (
        <div className="flex items-center gap-2 border-b border-term-border px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide">
          <span className="rounded bg-term-accent px-1.5 py-0.5 text-[10px] text-white">PAPER</span>
          <span className="text-term-dim">Simulated positions</span>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {(!paper || paper.positions.length === 0) && (
          <div className="p-4 text-center text-2xs text-term-dim">
            No open positions. Hit B / S on the chain.
          </div>
        )}
        {paper && paper.positions.length > 0 && (
          <table className="grid-table text-[10px]">
            <thead className="sticky top-0 bg-term-panel2 text-term-dim">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Contract</th>
                <th className="px-2 py-1 text-right font-medium">LTP</th>
                <th className="px-2 py-1 text-right font-medium">P&L</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {paper.positions.map((p) => (
                <tr key={p.id} className="border-b border-term-border/50 align-top">
                  <td className="px-2 py-1.5">
                    <div className="font-medium">
                      {p.symbol} {sk(p.strike)} {p.optionType}
                    </div>
                    <div className="num text-term-dim">
                      {p.qty > 0 ? "LONG" : "SHORT"} {Math.abs(p.qty / p.lotSize)}L @ {nf(p.avgPrice)}
                    </div>
                    <div className="mt-0.5">
                      {!isViewer() && <StopEditor p={p} />}
                    </div>
                  </td>
                  <td className="num px-2 py-1.5 text-right">{nf(p.ltp)}</td>
                  <td className={`num px-2 py-1.5 text-right ${signColor(p.pnl)}`}>{nf(p.pnl, 0)}</td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      onClick={() => closePosition(p.id)}
                      className="btn px-1.5 py-0.5 text-[10px]"
                      title="Square off"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
