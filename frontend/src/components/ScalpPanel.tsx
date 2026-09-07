import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, signColor, sk } from "../lib/format";

const n = (v: unknown): number | null => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

export function ScalpPanel() {
  const {
    symbol,
    chain,
    watch,
    orderMode,
    scalpLots,
    setScalpLots,
    quickTrade,
    quickTradeAt,
  } = useStore();
  const broker = useStore((s) => s.broker);

  const wq = watch.find((w) => w.symbol === symbol);
  const atm = chain?.atmStrike ?? wq?.atmStrike;
  const expiry = chain?.expiry ?? wq?.expiry;

  // quick strike picker — default ATM, follows the chain as spot moves
  const strikes = useMemo(() => chain?.rows.map((r) => r.strike) ?? [], [chain]);
  const step = strikes.length > 1 ? Math.abs(strikes[1] - strikes[0]) : 0;
  const [pick, setPick] = useState<number>(0);
  useEffect(() => {
    if (atm) setPick(atm);
  }, [atm, symbol, expiry]);
  const offset = atm && step ? Math.round((pick - atm) / step) : 0;
  const fire = (ot: "CE" | "PE", side: "BUY" | "SELL") => {
    if (expiry && pick) quickTradeAt(symbol, expiry, pick, ot, side, scalpLots);
    else quickTrade(symbol, ot, side, scalpLots);
  };

  // ---- live P&L straight from the broker position book (5s poll) ----
  const [brokerRows, setBrokerRows] = useState<any[]>([]);
  const [feedErr, setFeedErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const loadRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!broker?.authed) {
      setBrokerRows([]);
      return;
    }
    let alive = true;
    const load = () =>
      api.brokerPositions().then(
        (d) => alive && (setBrokerRows(d.positions || []), setFeedErr(null)),
        (e) => alive && setFeedErr(String(e?.message || e))
      );
    loadRef.current = load;
    load();
    const t = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [broker?.authed]);

  const mtmOf = (r: any) => n(r.urmtom) ?? n(r.mtm) ?? 0;
  const rpnlOf = (r: any) => n(r.rpnl) ?? 0;
  const open = brokerRows.filter((r) => (n(r.netqty) ?? 0) !== 0 || rpnlOf(r) !== 0);
  const sameSym = (r: any) =>
    String(r.symname ?? "").toUpperCase() === symbol.toUpperCase() ||
    String(r.tsym ?? "").toUpperCase().startsWith(symbol.toUpperCase());
  const myRows = open.filter(sameSym);

  const totMtm = open.reduce((s, r) => s + mtmOf(r), 0);
  const totRpnl = open.reduce((s, r) => s + rpnlOf(r), 0);
  const totToday = totMtm + totRpnl;
  const symMtm = myRows.reduce((s, r) => s + mtmOf(r), 0);
  const symRpnl = myRows.reduce((s, r) => s + rpnlOf(r), 0);
  const myOpen = myRows.filter((r) => (n(r.netqty) ?? 0) !== 0);

  const withBusy = async (key: string, fn: () => Promise<unknown>) => {
    setBusy((b) => new Set(b).add(key));
    try {
      await fn();
      loadRef.current();
    } catch (e: any) {
      alert(String(e?.message || e));
    } finally {
      setBusy((b) => {
        const nx = new Set(b);
        nx.delete(key);
        return nx;
      });
    }
  };
  const squareOff = (r: any) => {
    const qty = n(r.netqty) ?? 0;
    if (!qty) return;
    if (!window.confirm(`Square off ${r.tsym} — real MARKET order for ${Math.abs(qty)} qty. Continue?`))
      return;
    withBusy(String(r.tsym), () =>
      api.brokerSquareOff({ tsym: r.tsym, exch: r.exch || "NFO", qty, prd: r.prd })
    );
  };
  const squareOffSym = () => {
    const targets = myOpen;
    if (!targets.length) return;
    if (
      !window.confirm(
        `Square off all ${targets.length} open ${symbol} position(s) — ${targets.length} real MARKET order(s) now. Continue?`
      )
    )
      return;
    withBusy(`all-${symbol}`, async () => {
      for (const r of targets)
        await api.brokerSquareOff({
          tsym: r.tsym,
          exch: r.exch || "NFO",
          qty: n(r.netqty) ?? 0,
          prd: r.prd,
        });
    });
  };

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
      onClick={() => fire(ot, side)}
      className={`flex flex-col items-center rounded-md py-1.5 font-bold leading-tight transition-colors ${cls}`}
    >
      <span className="text-xs">{label}</span>
      <span className="text-[9px] font-normal opacity-70">
        {pick ? `${nf(pick, 0)} ${ot}` : ot} × {scalpLots}
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

      {/* live P&L straight from the broker position book */}
      <div className="flex items-center justify-between gap-2 border-b border-term-border bg-term-panel px-3 py-1.5">
        <div className="flex flex-col leading-tight">
          <span className="text-[9px] uppercase tracking-wide text-term-dim">
            Broker live P&amp;L ({open.length})
          </span>
          <span className={`num text-sm font-bold ${signColor(totMtm)}`}>₹{nf(totMtm, 0)}</span>
        </div>
        {broker?.authed && (
          <span className="num text-[10px] text-term-dim">
            realised{" "}
            <span className={signColor(totRpnl)}>₹{nf(totRpnl, 0)}</span> · today{" "}
            <span className={signColor(totToday)}>₹{nf(totToday, 0)}</span>
          </span>
        )}
        <button
          onClick={squareOffSym}
          disabled={myOpen.length === 0}
          className="shrink-0 rounded bg-down px-2 py-1 text-[10px] font-bold text-white disabled:opacity-30"
        >
          Flatten {symbol}
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
        {[1, 2, 5, 10].map((lotN) => (
          <button
            key={lotN}
            onClick={() => setScalpLots(lotN)}
            className={`rounded border px-1.5 py-0.5 ${
              scalpLots === lotN ? "border-term-accent bg-term-accent/20 text-term-text" : "border-term-border text-term-dim"
            }`}
          >
            {lotN}
          </button>
        ))}
      </div>

      {/* quick strike picker */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-term-border px-3 py-2 text-2xs">
        <span className="text-term-dim">Strike</span>
        {strikes.length > 0 ? (
          <>
            <button
              className="btn px-2 py-0.5"
              onClick={() => step && setPick((k) => k - step)}
              disabled={!step}
            >
              −
            </button>
            <select
              value={pick || ""}
              onChange={(e) => setPick(Number(e.target.value))}
              className="num rounded border border-term-border bg-term-bg px-1.5 py-0.5 font-semibold text-term-text"
            >
              {strikes.map((k) => (
                <option key={k} value={k}>
                  {sk(k)}
                  {k === atm ? "  (ATM)" : ""}
                </option>
              ))}
            </select>
            <button
              className="btn px-2 py-0.5"
              onClick={() => step && setPick((k) => k + step)}
              disabled={!step}
            >
              +
            </button>
            {atm && (
              <span className="rounded bg-term-bg px-1.5 py-0.5 text-[10px] text-term-dim">
                {offset === 0 ? "ATM" : offset > 0 ? `ATM +${offset}` : `ATM ${offset}`}
              </span>
            )}
            {atm && pick !== atm && (
              <button
                onClick={() => setPick(atm)}
                className="text-[10px] text-term-accent hover:underline"
              >
                reset ATM
              </button>
            )}
          </>
        ) : (
          <span className="text-term-dim">chain loading — trades use ATM</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 p-3">
        <BigBtn label="BUY CALL" ot="CE" side="BUY" cls="bg-up/20 text-up hover:bg-up/30" />
        <BigBtn label="BUY PUT" ot="PE" side="BUY" cls="bg-down/20 text-down hover:bg-down/30" />
        <BigBtn
          label="SELL CALL"
          ot="CE"
          side="SELL"
          cls="border border-down/40 text-down/90 hover:bg-down/10"
        />
        <BigBtn
          label="SELL PUT"
          ot="PE"
          side="SELL"
          cls="border border-up/40 text-up/90 hover:bg-up/10"
        />
      </div>

      <div className="flex items-center justify-between border-y border-term-border px-3 py-1.5 text-2xs">
        <span className="font-semibold uppercase text-term-dim">
          Position ({myOpen.length})
        </span>
        <span className="num font-semibold">
          <span className={signColor(symMtm)}>₹{nf(symMtm, 0)}</span>
          {symRpnl !== 0 && (
            <span className="ml-1 text-[10px] text-term-dim">
              · rlz <span className={signColor(symRpnl)}>₹{nf(symRpnl, 0)}</span>
            </span>
          )}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {!broker?.authed && (
          <div className="p-4 text-center text-2xs text-term-dim">
            Connect Flattrade (header) to see the live broker P&amp;L feed.
          </div>
        )}
        {broker?.authed && feedErr && (
          <div className="p-4 text-center text-2xs text-down">{feedErr}</div>
        )}
        {broker?.authed && !feedErr && myRows.length === 0 && (
          <div className="p-4 text-center text-2xs text-term-dim">
            No {symbol} positions at the broker today.
          </div>
        )}
        {broker?.authed && !feedErr && myRows.length > 0 && (
          <table className="w-full border-separate border-spacing-0 border border-term-border text-2xs [&_td]:border-b [&_td]:border-r [&_td]:border-term-border/50 [&_td]:px-1.5 [&_td]:py-1 [&_td:last-child]:border-r-0 [&_th]:border-b [&_th]:border-r [&_th]:border-term-border [&_th]:px-1.5 [&_th]:py-1 [&_th:last-child]:border-r-0">
            <thead className="sticky top-0 bg-term-panel text-[10px] uppercase text-term-dim">
              <tr>
                <th className="text-left font-medium">Instrument</th>
                <th className="text-right font-medium">Qty</th>
                <th className="text-right font-medium">Avg</th>
                <th className="text-right font-medium">LTP</th>
                <th className="text-right font-medium">MTM</th>
                <th className="text-right font-medium">Realised</th>
                <th className="font-medium" />
              </tr>
            </thead>
            <tbody>
              {myRows.map((r) => {
                const qty = n(r.netqty) ?? 0;
                const lot = n(r.ls) ?? n(r.lotsize) ?? 0;
                const lots = lot ? Math.abs(qty / lot) : Math.abs(qty);
                const mtm = mtmOf(r);
                const rp = rpnlOf(r);
                const key = String(r.tsym ?? r.symname ?? Math.random());
                return (
                  <tr key={key} className={qty === 0 ? "text-term-dim" : ""}>
                    <td className="num whitespace-nowrap">{r.dname ?? r.tsym}</td>
                    <td className="num text-right">
                      {qty === 0 ? (
                        "—"
                      ) : (
                        <span className={qty > 0 ? "text-up" : "text-down"}>
                          {qty > 0 ? "L" : "S"}
                          {lots || Math.abs(qty)}
                        </span>
                      )}
                    </td>
                    <td className="num text-right">
                      {qty === 0
                        ? "—"
                        : nf(n(r.netavgprc) ?? n(r.daybuyavgprc) ?? n(r.daysellavgprc))}
                    </td>
                    <td className="num text-right">{nf(n(r.lp))}</td>
                    <td className={`num text-right ${signColor(mtm)}`}>₹{nf(mtm, 0)}</td>
                    <td
                      className={`num text-right ${rp !== 0 ? signColor(rp) : "text-term-dim"}`}
                    >
                      {rp >= 0 ? "+" : ""}₹{nf(rp, 0)}
                    </td>
                    <td className="text-center">
                      <button
                        onClick={() => squareOff(r)}
                        disabled={!qty || busy.has(key)}
                        className="rounded bg-term-border px-2 py-0.5 text-[10px] hover:bg-term-panel disabled:opacity-25"
                      >
                        {busy.has(key) ? "…" : "Exit"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-term-panel font-semibold">
              <tr>
                <td className="num">Total</td>
                <td />
                <td />
                <td />
                <td className={`num text-right ${signColor(symMtm)}`}>₹{nf(symMtm, 0)}</td>
                <td className={`num text-right ${signColor(symRpnl)}`}>
                  {symRpnl >= 0 ? "+" : ""}₹{nf(symRpnl, 0)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {myOpen.length > 0 && (
        <button
          onClick={squareOffSym}
          disabled={busy.has(`all-${symbol}`)}
          className="btn btn-sell m-2 py-2 font-semibold disabled:opacity-40"
        >
          Square off all {symbol}
        </button>
      )}
    </div>
  );
}
