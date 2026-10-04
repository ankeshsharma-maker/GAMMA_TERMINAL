import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { nf } from "../lib/format";
import type { Chain, ChainRow, Leg } from "../types";
import { Chips } from "./StockScanTable";

const INDICES = ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY"] as const;
const money = (v: number) => `${v < 0 ? "-" : ""}₹${Math.round(Math.abs(v)).toLocaleString("en-IN")}`;
const MON: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** the expiry's last moment: 15:30 IST on its date ("06-Oct-2026" or "2026-10-06") */
function expiryMs(s: string): number | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (m) return Date.UTC(+m[3], MON[m[2]], +m[1], 10, 0, 0); // 15:30 IST = 10:00 UTC
  const i = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return i ? Date.UTC(+i[1], +i[2] - 1, +i[3], 10, 0, 0) : null;
}
function left(ms: number): string {
  if (ms <= 0) return "expired";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** One option, split into what it is worth right now (intrinsic) and what you pay for time (time value), the clock to its expiry, and what
 *  delta / gamma / theta say about the next move -- plus the same split for every strike around the money. Live from the option chain. */
export function OptionClock({ initialSymbol }: { initialSymbol: string }) {
  const [symbol, setSymbol] = useState<string>(INDICES.includes(initialSymbol as any) ? initialSymbol : "NIFTY");
  const [side, setSide] = useState<"P" | "C">("P");
  const [expiry, setExpiry] = useState("");
  const [strike, setStrike] = useState<number | null>(null);
  const [pos, setPos] = useState<"sell" | "buy">("sell");
  const [chain, setChain] = useState<Chain | null>(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    let inflight = false;
    const load = () => {
      if (document.hidden || inflight) return;
      inflight = true;
      api
        .chain(symbol, expiry || undefined)
        .then((c) => {
          if (!live) return;
          setChain(c);
          setErr("");
        })
        .catch((e) => live && setErr(String(e?.message || e)))
        .finally(() => (inflight = false));
    };
    load();
    const t = setInterval(load, 8000);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", load);
    };
  }, [symbol, expiry]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000); // the countdown
    return () => clearInterval(t);
  }, []);

  const spot = chain ? (chain.liveSpot?.ltp ?? chain.spot) : 0;
  const lot = chain?.lotSize ?? 0;
  const call = side === "C";
  const legOf = (r: ChainRow): Leg => (call ? r.call : r.put);
  const rows = useMemo(() => {
    if (!chain) return [] as ChainRow[];
    return chain.rows.filter((r) => legOf(r).ltp > 0 && Math.abs(r.strike - spot) / spot <= 0.025);
  }, [chain, side, spot]); // eslint-disable-line react-hooks/exhaustive-deps
  const sel = useMemo(() => {
    if (!rows.length) return null;
    const target = strike ?? chain?.atmStrike ?? spot;
    return rows.reduce((a, b) => (Math.abs(b.strike - target) < Math.abs(a.strike - target) ? b : a));
  }, [rows, strike, chain, spot]);

  const exp = chain ? expiryMs(chain.expiry) : null;
  const msLeft = exp != null ? exp - now : 0;

  const calc = (r: ChainRow) => {
    const l = legOf(r);
    const intrinsic = Math.max(0, call ? spot - r.strike : r.strike - spot);
    const tv = Math.max(0, l.ltp - intrinsic);
    return { l, intrinsic, tv, tvPct: l.ltp > 0 ? (tv / l.ltp) * 100 : 0 };
  };

  const S = sel ? calc(sel) : null;
  /** price after the index moves by `pct` % (delta + gamma, floored at the intrinsic value) or a day passes (theta) */
  const after = (pct: number | "day") => {
    if (!sel || !S) return 0;
    const { l } = S;
    if (pct === "day") {
      const intr = Math.max(0, call ? spot - sel.strike : sel.strike - spot);
      return Math.max(l.ltp + (l.theta || 0), intr);
    }
    const dS = spot * (pct / 100);
    const intr = Math.max(0, call ? spot + dS - sel.strike : sel.strike - (spot + dS));
    return Math.max(l.ltp + l.delta * dS + 0.5 * l.gamma * dS * dS, intr);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-term-bg">
      <div className="space-y-2 border-b border-term-border bg-term-panel2 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Chips<string> items={INDICES.map((i) => [i, i] as [string, string])} value={symbol} onChange={(v) => { setSymbol(v); setExpiry(""); setStrike(null); setChain(null); }} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-term-dim">
          <Chips<"P" | "C"> items={[["P", "Put"], ["C", "Call"]]} value={side} onChange={(v) => { setSide(v); setStrike(null); }} />
          {chain?.expiries && chain.expiries.length > 1 && (
            <select
              value={expiry || chain.expiry}
              onChange={(e) => { setExpiry(e.target.value); setStrike(null); }}
              className="rounded border border-term-dim/70 bg-term-panel px-2 py-1 text-[12px] text-term-text"
            >
              {chain.expiries.slice(0, 6).map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          )}
          <Chips<"sell" | "buy"> items={[["sell", "I'm selling it"], ["buy", "I'm buying it"]]} value={pos} onChange={setPos} />
        </div>
        {chain && (
          <div className="text-[11px] text-term-dim">
            {chain.symbol} <b className="text-term-text">{nf(spot, 2)}</b> · expiry <b className="text-term-text">{chain.expiry}</b> at 15:30 · tap a strike in the table to look at it
          </div>
        )}
      </div>

      {err ? (
        <div className="p-4 text-center text-[12px] text-down">{err}</div>
      ) : !chain || !sel || !S ? (
        <div className="p-6 text-center text-[12px] text-term-dim">Loading the option chain…</div>
      ) : (
        <>
          <div className="mx-3 mt-3 rounded-md border border-term-border bg-term-panel px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-3 text-[12px] text-term-dim">
              <span className="text-[15px] font-bold text-term-text">{nf(sel.strike, 0)} {call ? "CALL" : "PUT"}</span>
              <span>
                price <b className="text-term-text">{nf(S.l.ltp, 2)}</b>
                {lot ? <> ({money(S.l.ltp * lot)} a lot)</> : null}
              </span>
              <span>{call ? (spot > sel.strike ? "in the money" : "out of the money") : spot < sel.strike ? "in the money" : "out of the money"} by {nf(Math.abs(spot - sel.strike), 0)} pts</span>
            </div>
            {/* the price, split */}
            <div className="mt-2 flex h-3 overflow-hidden rounded bg-term-border/40" title="intrinsic value | time value">
              <div className="bg-up/70" style={{ width: `${S.l.ltp > 0 ? (S.intrinsic / S.l.ltp) * 100 : 0}%` }} />
              <div className="bg-amber-400/70" style={{ width: `${S.tvPct}%` }} />
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="rounded border border-up/40 bg-up/10 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-term-dim">Intrinsic value</div>
                <div className="text-[18px] font-bold text-up">{nf(S.intrinsic, 2)}</div>
                <div className="text-[10px] leading-snug text-term-dim">
                  {S.intrinsic > 0
                    ? `What it is worth right now if it expired this second${lot ? ` (${money(S.intrinsic * lot)} a lot)` : ""}.`
                    : `Nothing: the strike is ${nf(Math.abs(spot - sel.strike), 0)} points ${call ? "above" : "below"} the index, so all of the price is time value.`}
                </div>
              </div>
              <div className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-term-dim">Time value</div>
                <div className="text-[18px] font-bold text-amber-400">
                  {nf(S.tv, 2)} <span className="text-[12px] font-semibold">({nf(S.tvPct, 0)}%)</span>
                </div>
                <div className="text-[10px] leading-snug text-term-dim">
                  The part paid for the time left. It melts to zero by expiry: the seller's income, the buyer's cost{lot ? ` (${money(S.tv * lot)} a lot)` : ""}.
                </div>
              </div>
              <div className="rounded border border-term-border bg-term-panel2 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-term-dim">Time to expiry</div>
                <div className="text-[18px] font-bold text-term-text">{left(msLeft)}</div>
                <div className="text-[10px] leading-snug text-term-dim">Until 15:30 on {chain.expiry}.{S.l.theta ? ` It loses about ${nf(Math.abs(S.l.theta), 2)} a day (${nf(S.tv > 0 ? (Math.abs(S.l.theta) / S.tv) * 100 : 0, 0)}% of its time value).` : ""}</div>
              </div>
            </div>
          </div>

          <div className="mx-3 mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-md border border-term-border bg-term-panel px-3 py-2 text-[11px] leading-snug text-term-dim">
              <div className="font-bold text-term-text">Delta {nf(S.l.delta, 2)}</div>
              For every ₹1 the index moves, this option moves about ₹{nf(Math.abs(S.l.delta), 2)}. The market gives it about a <b className="text-term-text">{nf(Math.abs(S.l.delta) * 100, 0)}%</b> chance of finishing in the
              money.
            </div>
            <div className="rounded-md border border-term-border bg-term-panel px-3 py-2 text-[11px] leading-snug text-term-dim">
              <div className="font-bold text-term-text">Gamma {nf(S.l.gamma, 4)}</div>
              How fast delta grows: after a 1% index move ({nf(spot * 0.01, 0)} pts) delta becomes about{" "}
              <b className="text-term-text">{nf(Math.min(1, Math.abs(S.l.delta) + S.l.gamma * spot * 0.01), 2)}</b>
              . The nearer the expiry and the closer to the money, the faster — a seller's loss speeds up.
            </div>
            <div className="rounded-md border border-term-border bg-term-panel px-3 py-2 text-[11px] leading-snug text-term-dim">
              <div className="font-bold text-term-text">Theta {nf(S.l.theta, 2)} a day</div>
              Time melts about ₹{nf(Math.abs(S.l.theta), 2)} off the price each day{lot ? ` (${money(Math.abs(S.l.theta) * lot)} a lot)` : ""}, which {pos === "sell" ? "you collect" : "you pay"} if the index doesn't move.
            </div>
          </div>

          <div className="mx-3 mt-3 shrink-0 overflow-x-auto rounded-md border border-term-border">
            <table className="w-full min-w-[420px] text-right text-[12px]">
              <thead className="bg-term-panel text-[10px] uppercase tracking-wide text-term-dim">
                <tr className="border-b border-term-border">
                  <th className="px-2 py-1.5 text-left font-semibold">If the index…</th>
                  <th className="px-1 font-semibold">Option would be</th>
                  <th className="px-2 font-semibold">{pos === "sell" ? "You (selling)" : "You (buying)"}</th>
                </tr>
              </thead>
              <tbody>
                {([-1, -0.5, 0.5, 1, "day"] as const).map((m) => {
                  const p = after(m);
                  const diff = (pos === "sell" ? S.l.ltp - p : p - S.l.ltp) * (lot || 1);
                  return (
                    <tr key={String(m)} className="border-b border-term-border/50 text-term-text">
                      <td className="px-2 py-1.5 text-left">
                        {m === "day" ? "stays here and a day passes" : `moves ${m > 0 ? "+" : ""}${m}% (${m > 0 ? "+" : "-"}${nf(Math.abs(spot * (m / 100)), 0)} pts)`}
                      </td>
                      <td className="px-1">{nf(p, 2)}</td>
                      <td className={`px-2 font-bold ${diff >= 0 ? "text-up" : "text-down"}`}>
                        {diff >= 0 ? "+" : ""}
                        {money(diff)}
                        {lot ? "" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-3 pb-2 pt-1 text-[10px] leading-snug text-term-dim">
            Estimated with delta + gamma (and theta for the day), per lot. It assumes the market's volatility doesn't change and the move is quick — a good guide for a normal move, rougher for a
            big one.
          </div>

          <div className="mx-3 mb-3 shrink-0 overflow-x-auto rounded-md border border-term-border">
            <table className="w-full min-w-[560px] text-right text-[12px]">
              <thead className="bg-term-panel text-[10px] uppercase tracking-wide text-term-dim">
                <tr className="border-b border-term-border">
                  <th className="px-2 py-1.5 text-left font-semibold">Strike</th>
                  <th className="px-1 font-semibold">Price</th>
                  <th className="px-1 font-semibold">Intrinsic</th>
                  <th className="px-1 font-semibold">Time value</th>
                  <th className="px-1 font-semibold">Delta</th>
                  <th className="px-1 font-semibold">Gamma</th>
                  <th className="px-2 font-semibold">Theta / day</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const c = calc(r);
                  return (
                    <tr
                      key={r.strike}
                      onClick={() => setStrike(r.strike)}
                      className={`cursor-pointer border-b border-term-border/50 text-term-text hover:bg-term-border/30 ${r.strike === sel.strike ? "bg-term-accent/15" : ""}`}
                    >
                      <td className="px-2 py-1.5 text-left font-semibold">{nf(r.strike, 0)}</td>
                      <td className="px-1">{nf(c.l.ltp, 2)}</td>
                      <td className="px-1 text-up">{nf(c.intrinsic, 2)}</td>
                      <td className="px-1 text-amber-400">{nf(c.tv, 2)} <span className="text-term-dim">({nf(c.tvPct, 0)}%)</span></td>
                      <td className="px-1">{nf(c.l.delta, 2)}</td>
                      <td className="px-1">{nf(c.l.gamma, 4)}</td>
                      <td className="px-2">{nf(c.l.theta, 2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
