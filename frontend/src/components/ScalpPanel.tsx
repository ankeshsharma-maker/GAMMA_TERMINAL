import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, signColor, sk } from "../lib/format";
import { useIsMobile } from "../lib/useIsMobile";
import { useLiveMtm } from "../lib/useLiveMtm";
import { RuleOrder } from "./RuleOrder";

const n = (v: unknown): number | null => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

export function ScalpPanel() {
  const {
    symbol,
    chain,
    watch,
    scalpLots,
    setScalpLots,
    quickTrade,
    quickTradeAt,
  } = useStore();
  const broker = useStore((s) => s.broker);
  const isMobile = useIsMobile();
  const { mark } = useLiveMtm();

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

  // one-tap ATM / OTM strike jump — CE OTM is above spot, PE OTM below
  const [sideHint, setSideHint] = useState<"CE" | "PE" | null>(null);
  const quickPick = (off: number, ot: "CE" | "PE") => {
    if (!atm) return;
    if (off === 0) {
      setPick(atm);
      setSideHint(null);
      return;
    }
    const target = ot === "CE" ? atm + off * step : atm - off * step;
    const near = strikes.length
      ? strikes.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a), strikes[0])
      : target;
    setPick(near || target);
    setSideHint(ot);
  };
  const QCHIPS: [string, number, "CE" | "PE"][] = [
    ["PE OTM2", 2, "PE"],
    ["PE OTM1", 1, "PE"],
    ["ATM", 0, "CE"],
    ["CE OTM1", 1, "CE"],
    ["CE OTM2", 2, "CE"],
  ];

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

  const mtmOf = (r: any) => mark(r) ?? n(r.urmtom) ?? n(r.mtm) ?? 0;
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
      className={`flex items-baseline justify-center gap-1.5 rounded py-1 font-bold leading-none transition-colors ${cls} ${
        sideHint === ot ? "ring-2 ring-term-accent" : ""
      }`}
    >
      <span className="text-[11px]">{label}</span>
      <span className="text-[8px] font-normal opacity-70">
        {pick ? `${nf(pick, 0)} ${ot}` : ot}×{scalpLots}
      </span>
    </button>
  );

  return (
    <div className={`flex flex-col bg-term-panel2 ${isMobile ? "" : "h-full"}`}>
      {/* live P&L straight from the broker position book */}
      <div className="flex items-end gap-4 border-b border-term-border bg-term-panel px-3 py-1.5">
        <div className="flex flex-col leading-tight">
          <span className="text-[9px] uppercase tracking-wide text-term-dim">
            MTM ({open.length})
          </span>
          <span className={`num text-sm font-bold ${signColor(totMtm)}`}>₹{nf(totMtm, 0)}</span>
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-[9px] uppercase tracking-wide text-term-dim">P&amp;L</span>
          <span className={`num text-sm font-bold ${signColor(totToday)}`}>₹{nf(totToday, 0)}</span>
        </div>
        {broker?.authed && (
          <div className="flex flex-col leading-tight">
            <span className="text-[9px] uppercase tracking-wide text-term-dim">Realised</span>
            <span className={`num text-sm font-bold ${signColor(totRpnl)}`}>₹{nf(totRpnl, 0)}</span>
          </div>
        )}
        <button
          onClick={squareOffSym}
          disabled={myOpen.length === 0}
          className={`ml-auto shrink-0 rounded-md border px-3 py-1.5 text-xs font-bold uppercase tracking-wide ${
            myOpen.length === 0
              ? "cursor-not-allowed border-term-border bg-term-border/30 text-term-dim"
              : "animate-pulse border-red-400 bg-red-600 text-white shadow-sm ring-2 ring-red-400/50 hover:animate-none hover:bg-red-700"
          }`}
        >
          Square off{myOpen.length > 0 ? ` (${myOpen.length})` : ""}
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

      {/* one-tap ATM / OTM shortcuts */}
      {atm && step ? (
        <div className="flex items-center gap-1 border-b border-term-border px-3 py-1.5">
          <span className="mr-0.5 text-[10px] uppercase tracking-wide text-term-dim">Quick</span>
          {QCHIPS.map(([lbl, n, ot]) => {
            const strike = n === 0 ? atm : ot === "CE" ? atm + n * step : atm - n * step;
            const active = Math.round(pick) === Math.round(strike);
            return (
              <button
                key={lbl}
                onClick={() => quickPick(n, ot)}
                title={`${sk(strike)} ${n === 0 ? "" : ot}`.trim()}
                className={`flex-1 rounded border px-1 py-1 text-[10px] font-semibold leading-tight ${
                  active
                    ? "border-term-accent bg-term-accent/20 text-term-text"
                    : n === 0
                    ? "border-term-border bg-term-bg/60 text-term-text"
                    : ot === "CE"
                    ? "border-up/40 text-up hover:bg-up/10"
                    : "border-down/40 text-down hover:bg-down/10"
                }`}
              >
                {lbl}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* quick strike picker */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-term-border px-3 py-2 text-2xs">
        <span className="text-term-dim">Strike</span>
        {strikes.length > 0 ? (
          <>
            <button
              className="btn px-2 py-0.5"
              onClick={() => { if (step) { setPick((k) => k - step); setSideHint(null); } }}
              disabled={!step}
            >
              −
            </button>
            <select
              value={pick || ""}
              onChange={(e) => { setPick(Number(e.target.value)); setSideHint(null); }}
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
              onClick={() => { if (step) { setPick((k) => k + step); setSideHint(null); } }}
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

      <div className="grid grid-cols-2 gap-1.5 px-2 py-1.5">
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

      <RuleOrder
        symbol={symbol}
        expiry={expiry}
        strike={pick || atm || 0}
        strikes={strikes}
        step={step}
        atm={atm}
        lots={scalpLots}
      />

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

      <div className={`p-2 ${isMobile ? "overflow-x-auto" : "min-h-0 flex-1 overflow-auto"}`}>
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
          <table className="w-full min-w-[480px] border-separate border-spacing-0 overflow-hidden rounded border border-term-border text-2xs [&_td]:border-b [&_td]:border-r [&_td]:border-term-border/40 [&_td]:px-1.5 [&_td]:py-1 [&_td:last-child]:border-r-0 [&_th]:border-b [&_th]:border-r [&_th]:border-term-border [&_th]:px-1.5 [&_th]:py-1 [&_th:last-child]:border-r-0 [&_tr:last-child_td]:border-b-0">
            <thead className="sticky top-0 z-10 bg-term-panel2 text-[9px] uppercase tracking-wide text-term-dim">
              <tr>
                <th className="text-left font-semibold">Instrument</th>
                <th className="text-right font-semibold">Qty</th>
                <th className="text-right font-semibold">Avg</th>
                <th className="text-right font-semibold">LTP</th>
                <th className="text-right font-semibold">Unrealised</th>
                <th className="text-right font-semibold">Realised</th>
                <th className="text-right font-semibold">Net MTM</th>
                <th className="font-semibold" />
              </tr>
            </thead>
            <tbody>
              {myRows.map((r) => {
                const qty = n(r.netqty) ?? 0;
                const lot = n(r.ls) ?? n(r.lotsize) ?? 0;
                const lots = lot ? Math.abs(qty / lot) : Math.abs(qty);
                const unl = mtmOf(r); // urmtom = unrealised mark-to-market
                const rp = rpnlOf(r);
                const net = unl + rp;
                const key = String(r.tsym ?? r.symname ?? Math.random());
                const money = (v: number, dim = false) =>
                  v === 0 && dim ? (
                    <span className="text-term-dim">₹0</span>
                  ) : (
                    <span className={signColor(v)}>
                      {v >= 0 ? "+" : ""}₹{nf(v, 0)}
                    </span>
                  );
                return (
                  <tr key={key} className={qty === 0 ? "text-term-dim" : "odd:bg-term-bg/20"}>
                    <td className="num whitespace-nowrap">{r.dname ?? r.tsym}</td>
                    <td className="num text-right">
                      {qty === 0 ? (
                        "flat"
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
                    <td className="num text-right">{money(unl, qty === 0)}</td>
                    <td className="num text-right">{money(rp, true)}</td>
                    <td className="num text-right font-semibold">{money(net)}</td>
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
            <tfoot className="bg-term-panel2 font-semibold">
              <tr>
                <td className="num uppercase text-term-dim">Total</td>
                <td />
                <td />
                <td />
                <td className={`num text-right ${signColor(symMtm)}`}>
                  {symMtm >= 0 ? "+" : ""}₹{nf(symMtm, 0)}
                </td>
                <td className={`num text-right ${signColor(symRpnl)}`}>
                  {symRpnl >= 0 ? "+" : ""}₹{nf(symRpnl, 0)}
                </td>
                <td className={`num text-right ${signColor(symMtm + symRpnl)}`}>
                  {symMtm + symRpnl >= 0 ? "+" : ""}₹{nf(symMtm + symRpnl, 0)}
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
