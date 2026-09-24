import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, signColor } from "../lib/format";

/** big Greeks (theta / vega run into the thousands) drop the decimal so four fit a phone row */
const g1 = (v: number) => nf(v, Math.abs(v) >= 100 ? 0 : 1);
const rupee = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? "–" : `₹${Math.round(n).toLocaleString("en-IN")}`;

type GreekBucket = { delta: number; gamma: number; theta: number; vega: number; positions: number };
type GreekBySymbol = GreekBucket & { symbol: string };

/** one labelled figure -- tiles wrap into rows, so nothing scrolls sideways on a phone */
function Tile({ label, value, tone = "text-term-text", title }: { label: string; value: string; tone?: string; title?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-term-bg/50 px-2 py-1.5" title={title}>
      <div className="text-[10px] uppercase leading-tight tracking-wide text-term-dim">{label}</div>
      <div className={`truncate text-[15px] font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

/** Combined risk snapshot for whatever mode (paper/live) is currently active:
 *  margin available/used/% deployed (same figures Funds.tsx shows, read from
 *  the same store state so there's one source of truth) alongside net
 *  portfolio Greeks (same api.portfolioGreeks() the old broker-only card
 *  used, now covering paper positions too, with a per-symbol breakdown so a
 *  correlated multi-strike bet on one underlying doesn't hide behind a
 *  single calm-looking net number). Lives in the Positions > Advanced tab,
 *  as rows of tiles (margin, then Greeks) so a phone never scrolls sideways. */
export function PortfolioSummary() {
  const orderMode = useStore((s) => s.orderMode);
  const funds = useStore((s) => s.brokerFunds);
  const paper = useStore((s) => s.paper);
  const broker = useStore((s) => s.broker);

  const [greeks, setGreeks] = useState<GreekBucket | null>(null);
  const [greeksBySymbol, setGreeksBySymbol] = useState<GreekBySymbol[]>([]);

  const live = orderMode === "live" && !!funds?.connected && funds.available != null;

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.portfolioGreeks().then((d) => {
        if (!alive) return;
        setGreeks(live ? d.live : d.paper);
        setGreeksBySymbol(live ? d.liveBySymbol : d.paperBySymbol);
      }, () => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [live]);

  const available = live ? funds!.available! : paper?.marginAvailable ?? null;
  const used = live ? funds!.used! : paper?.marginUsed ?? null;
  const pctDeployed = available != null && used != null ? (used / ((available ?? 0) + used || 1)) * 100 : null;
  const deployedTone = pctDeployed == null ? "text-term-text" : pctDeployed >= 80 ? "text-down" : pctDeployed >= 50 ? "text-amber-400" : "text-up";
  const positions = greeks?.positions ?? 0;

  return (
    <section className="mx-3 mt-3 shrink-0 overflow-hidden rounded-lg border border-term-border">
      <div className="flex items-center justify-between bg-term-panel px-3 py-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-term-dim">Portfolio</span>
        <div className="flex items-center gap-2">
          <span className="text-2xs text-term-dim">
            {positions} open position{positions === 1 ? "" : "s"}
          </span>
          <span
            className={`rounded px-2 py-0.5 text-2xs font-bold ${live ? "bg-up/15 text-up" : "bg-term-border text-term-dim"}`}
          >
            {live ? "● LIVE" : "○ PAPER"}
          </span>
        </div>
      </div>

      {live && !broker?.authed ? (
        <div className="bg-amber-500/10 px-3 py-2 text-2xs text-amber-400">
          Live mode, but Flattrade isn't connected — connect it (header) to see live margin &amp; Greeks.
        </div>
      ) : (
        <div className="flex flex-col gap-2 p-2.5">
          {/* row 1: margin, split into available / used / how much is deployed */}
          <div className="grid grid-cols-3 gap-2">
            <Tile
              label="Margin available"
              value={rupee(available)}
              tone={available != null && available < 0 ? "text-down" : "text-up"}
              title="Available margin, same figure as the Funds tab"
            />
            <Tile label="Margin used" value={rupee(used)} tone={used ? "text-amber-400" : "text-term-text"} />
            <Tile label="Deployed" value={pctDeployed != null ? `${nf(pctDeployed, 0)}%` : "–"} tone={deployedTone} />
          </div>
          {pctDeployed != null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-term-border/60">
              <div
                className={`h-full rounded-full ${pctDeployed >= 80 ? "bg-down" : pctDeployed >= 50 ? "bg-amber-400" : "bg-up"}`}
                style={{ width: `${Math.min(100, Math.max(0, pctDeployed))}%` }}
              />
            </div>
          )}

          {/* row 2: net Greeks */}
          <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-term-dim">
            Greeks · {greeksBySymbol.length > 1 ? "all symbols" : "portfolio"}
          </div>
          <div className="grid grid-cols-4 gap-2">
            <Tile
              label="Δ Delta"
              value={greeks ? g1(greeks.delta) : "–"}
              tone={greeks ? signColor(greeks.delta) : undefined}
              title="Net delta across every open position"
            />
            <Tile label="Γ Gamma" value={greeks ? nf(greeks.gamma, 3) : "–"} tone={greeks ? signColor(greeks.gamma) : undefined} />
            <Tile
              label="Θ Theta"
              value={greeks ? g1(greeks.theta) : "–"}
              tone={greeks ? signColor(greeks.theta) : undefined}
              title="Positive = net premium seller, decaying in your favour"
            />
            <Tile label="V Vega" value={greeks ? g1(greeks.vega) : "–"} tone={greeks ? signColor(greeks.vega) : undefined} />
          </div>

          {/* per underlying, so a correlated bet on one symbol doesn't hide in the net */}
          {greeksBySymbol.length > 1 && (
            <table className="w-full table-fixed text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-term-dim">
                  <th className="w-[28%] py-1 text-left font-semibold">Symbol</th>
                  <th className="py-1 text-right font-semibold">Δ</th>
                  <th className="py-1 text-right font-semibold">Γ</th>
                  <th className="py-1 text-right font-semibold">Θ</th>
                  <th className="py-1 text-right font-semibold">V</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {greeksBySymbol.map((g) => (
                  <tr key={g.symbol} className="border-t border-term-border/50">
                    <td className="truncate py-1 font-semibold text-term-accent">{g.symbol}</td>
                    <td className={`py-1 text-right ${signColor(g.delta)}`}>{nf(g.delta, 1)}</td>
                    <td className={`py-1 text-right ${signColor(g.gamma)}`}>{nf(g.gamma, 3)}</td>
                    <td className={`py-1 text-right ${signColor(g.theta)}`}>{nf(g.theta, 1)}</td>
                    <td className={`py-1 text-right ${signColor(g.vega)}`}>{nf(g.vega, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
