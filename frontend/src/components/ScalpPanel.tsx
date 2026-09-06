import { useStore } from "../store";
import { nf, signColor, sk } from "../lib/format";
import { StopEditor } from "./StopEditor";

export function ScalpPanel() {
  const { symbol, chain, watch, paper, orderMode, scalpLots, setScalpLots, quickTrade, closePosition } =
    useStore();

  const wq = watch.find((w) => w.symbol === symbol);
  const atm = chain?.atmStrike ?? wq?.atmStrike;
  const expiry = chain?.expiry ?? wq?.expiry;

  const allPos = paper?.positions ?? [];
  const myPos = allPos.filter((p) => p.symbol === symbol);
  const pnl = myPos.reduce((s, p) => s + p.pnl, 0);
  const livePnl = allPos.reduce((s, p) => s + p.pnl, 0);

  const BigBtn = ({
    label,
    ot,
    side,
    cls,
  }: {
    label: string;
    ot: "CE" | "PE";
    side: "BUY" | "SELL";
    cls: string;
  }) => (
    <button
      onClick={() => quickTrade(symbol, ot, side, scalpLots)}
      className={`flex flex-col items-center rounded-md py-1.5 font-bold leading-tight transition-colors ${cls}`}
    >
      <span className="text-xs">{label}</span>
      <span className="text-[9px] font-normal opacity-70">
        {atm ? `${nf(atm, 0)} ${ot}` : ot} × {scalpLots}
      </span>
    </button>
  );

  return (
    <div className="flex h-full flex-col bg-term-panel2">
      <div className="border-b border-term-border px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">{symbol}</span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
              orderMode === "live" ? "bg-down text-white" : "bg-term-accent/20 text-term-accent"
            }`}
          >
            {orderMode === "live" ? "LIVE" : "PAPER"}
          </span>
        </div>
        <div className="num mt-0.5 text-2xs text-term-dim">
          ATM {atm ? nf(atm, 0) : "–"} · {expiry ?? "–"} · spot {nf(chain?.liveSpot?.ltp ?? chain?.spot)}
        </div>
      </div>

      {/* live P&L across all open positions + one-tap flatten */}
      <div className="flex items-center justify-between gap-2 border-b border-term-border bg-term-panel px-3 py-1.5">
        <div className="flex flex-col leading-tight">
          <span className="text-[9px] uppercase tracking-wide text-term-dim">Live P&amp;L ({allPos.length})</span>
          <span className={`num text-sm font-bold ${signColor(livePnl)}`}>₹{nf(livePnl, 0)}</span>
        </div>
        {paper && (
          <span className="num text-[10px] text-term-dim">
            day <span className={signColor(paper.todayPnl)}>₹{nf(paper.todayPnl, 0)}</span> · total{" "}
            <span className={signColor(paper.total)}>₹{nf(paper.total, 0)}</span>
          </span>
        )}
        <button
          onClick={() => {
            if (allPos.length && window.confirm(`Square off all ${allPos.length} open position(s)?`))
              allPos.forEach((p) => closePosition(p.id));
          }}
          disabled={allPos.length === 0}
          className="shrink-0 rounded bg-down px-2 py-1 text-[10px] font-bold text-white disabled:opacity-30"
        >
          Square off ALL
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-term-border px-3 py-2 text-2xs">
        <span className="text-term-dim">Lots</span>
        <button className="btn px-2 py-0.5" onClick={() => setScalpLots(scalpLots - 1)}>
          −
        </button>
        <span className="num w-6 text-center text-sm font-semibold">{scalpLots}</span>
        <button className="btn px-2 py-0.5" onClick={() => setScalpLots(scalpLots + 1)}>
          +
        </button>
        {[1, 2, 5, 10].map((n) => (
          <button
            key={n}
            onClick={() => setScalpLots(n)}
            className={`rounded border px-1.5 py-0.5 ${
              scalpLots === n ? "border-term-accent bg-term-accent/20 text-term-text" : "border-term-border text-term-dim"
            }`}
          >
            {n}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 p-3">
        <BigBtn label="BUY CALL" ot="CE" side="BUY" cls="bg-up/20 text-up hover:bg-up/30" />
        <BigBtn label="BUY PUT" ot="PE" side="BUY" cls="bg-down/20 text-down hover:bg-down/30" />
        <BigBtn
          label="SELL CALL"
          ot="CE"
          side="SELL"
          cls="border border-up/40 text-up/80 hover:bg-up/10"
        />
        <BigBtn
          label="SELL PUT"
          ot="PE"
          side="SELL"
          cls="border border-down/40 text-down/80 hover:bg-down/10"
        />
      </div>

      <div className="flex items-center justify-between border-y border-term-border px-3 py-1.5 text-2xs">
        <span className="font-semibold uppercase text-term-dim">
          {symbol} positions ({myPos.length})
        </span>
        <span className={`num font-semibold ${signColor(pnl)}`}>₹{nf(pnl, 0)}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {myPos.length === 0 && (
          <div className="p-4 text-center text-2xs text-term-dim">
            No open {symbol} positions. Hit a button above.
          </div>
        )}
        {myPos.map((p) => (
          <div key={p.id} className="border-b border-term-border/50 px-3 py-1.5 text-2xs">
            <div className="flex items-center justify-between">
              <div className="flex flex-col leading-tight">
                <span className="num font-medium">
                  {sk(p.strike)} {p.optionType} {p.qty > 0 ? "L" : "S"}
                  {Math.abs(p.qty / p.lotSize)}
                </span>
                <span className="num text-term-dim">
                  @ {nf(p.avgPrice)} → {nf(p.ltp)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`num ${signColor(p.pnl)}`}>₹{nf(p.pnl, 0)}</span>
                <button
                  onClick={() => closePosition(p.id)}
                  className="rounded bg-term-border px-2 py-0.5 text-[10px] hover:bg-term-panel"
                >
                  Exit
                </button>
              </div>
            </div>
            <div className="mt-0.5">
              <StopEditor p={p} />
            </div>
          </div>
        ))}
      </div>

      {myPos.length > 0 && (
        <button
          onClick={() => myPos.forEach((p) => closePosition(p.id))}
          className="btn btn-sell m-2 py-2 font-semibold"
        >
          Square off all {symbol}
        </button>
      )}
    </div>
  );
}
