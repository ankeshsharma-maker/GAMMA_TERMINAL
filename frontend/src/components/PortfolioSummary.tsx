import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, signColor } from "../lib/format";

const rupee = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? "–" : `₹${Math.round(n).toLocaleString("en-IN")}`;

type GreekBucket = { delta: number; gamma: number; theta: number; vega: number; positions: number };
type GreekBySymbol = GreekBucket & { symbol: string };

/** Combined risk snapshot for whatever mode (paper/live) is currently active:
 *  margin available/used/% deployed (same figures Funds.tsx shows, read from
 *  the same store state so there's one source of truth) alongside net
 *  portfolio Greeks (same api.portfolioGreeks() the old broker-only card
 *  used, now covering paper positions too, with a per-symbol breakdown so a
 *  correlated multi-strike bet on one underlying doesn't hide behind a
 *  single calm-looking net number). Shown above every Positions sub-tab. */
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

  if (live && !broker?.authed) {
    return (
      <div className="border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-2xs text-amber-400">
        Live mode, but Flattrade isn't connected — connect it (header) to see live margin &amp; Greeks.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs">
      <span
        className={`rounded px-1.5 py-0.5 text-2xs font-semibold ${live ? "bg-up/15 text-up" : "bg-term-border text-term-dim"}`}
      >
        {live ? "LIVE" : "PAPER"}
      </span>

      <span className="flex items-center gap-1.5" title="Available / used margin, same figures as the Funds tab">
        <span className="text-term-dim">Margin</span>
        <span className={`num font-semibold ${available != null && available < 0 ? "text-down" : "text-up"}`}>
          {rupee(available)} free
        </span>
        <span className="num text-term-dim">/ {rupee(used)} used</span>
        {pctDeployed != null && (
          <span className={`num ${pctDeployed >= 80 ? "text-down" : pctDeployed >= 50 ? "text-amber-400" : "text-term-dim"}`}>
            ({nf(pctDeployed, 0)}%)
          </span>
        )}
      </span>

      {greeks && greeks.positions > 0 && (
        <span
          className="flex items-center gap-2"
          title="Net Greeks summed across every open position, from each leg's current per-unit Greek × its signed quantity"
        >
          <span className="text-term-dim">Net Greeks</span>
          <span className="num flex gap-2.5">
            <span className={signColor(greeks.delta)}>Δ {nf(greeks.delta, 1)}</span>
            <span className={signColor(greeks.gamma)}>Γ {nf(greeks.gamma, 3)}</span>
            <span className={signColor(greeks.theta)}>Θ {nf(greeks.theta, 1)}</span>
            <span className={signColor(greeks.vega)}>V {nf(greeks.vega, 1)}</span>
          </span>
        </span>
      )}

      {greeksBySymbol.length > 1 &&
        greeksBySymbol.map((g) => (
          <span
            key={g.symbol}
            className="flex items-center gap-1.5 rounded border border-term-accent/30 px-1.5 py-0.5"
            title={`Net Greeks for ${g.symbol} alone`}
          >
            <span className="font-semibold text-term-accent">{g.symbol}</span>
            <span className="num flex gap-2">
              <span className={signColor(g.delta)}>Δ{nf(g.delta, 1)}</span>
              <span className={signColor(g.theta)}>Θ{nf(g.theta, 1)}</span>
            </span>
          </span>
        ))}

      {greeks && greeks.positions === 0 && <span className="text-term-dim">No open positions</span>}
    </div>
  );
}
