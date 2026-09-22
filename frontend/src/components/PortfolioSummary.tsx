import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, signColor } from "../lib/format";

const rupee = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? "–" : `₹${Math.round(n).toLocaleString("en-IN")}`;

type GreekBucket = { delta: number; gamma: number; theta: number; vega: number; positions: number };
type GreekBySymbol = GreekBucket & { symbol: string };

function Tile({
  label,
  value,
  tone = "text-term-text",
  title,
}: {
  label: string;
  value: string;
  tone?: string;
  title?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center justify-center gap-1 bg-term-panel px-2 py-2.5" title={title}>
      <span className="text-[9px] uppercase tracking-wide text-term-dim">{label}</span>
      <span className={`num truncate text-sm font-bold ${tone}`}>{value}</span>
    </div>
  );
}

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
        <div className="grid grid-cols-2 gap-px bg-term-border/70 min-[560px]:grid-cols-4 min-[901px]:grid-cols-7">
          <Tile
            label="Margin free"
            value={rupee(available)}
            tone={available != null && available < 0 ? "text-down" : "text-up"}
            title="Available margin, same figure as the Funds tab"
          />
          <Tile label="Margin used" value={rupee(used)} tone={used ? "text-amber-400" : "text-term-text"} />
          <Tile
            label="Deployed"
            value={pctDeployed != null ? `${nf(pctDeployed, 0)}%` : "–"}
            tone={deployedTone}
          />
          <Tile
            label="Δ Delta"
            value={greeks ? nf(greeks.delta, 1) : "–"}
            tone={greeks ? signColor(greeks.delta) : "text-term-text"}
            title="Net delta across every open position (per-leg delta × signed quantity)"
          />
          <Tile
            label="Γ Gamma"
            value={greeks ? nf(greeks.gamma, 3) : "–"}
            tone={greeks ? signColor(greeks.gamma) : "text-term-text"}
          />
          <Tile
            label="Θ Theta"
            value={greeks ? nf(greeks.theta, 1) : "–"}
            tone={greeks ? signColor(greeks.theta) : "text-term-text"}
            title="Positive = net premium seller, decaying in your favour"
          />
          <Tile
            label="V Vega"
            value={greeks ? nf(greeks.vega, 1) : "–"}
            tone={greeks ? signColor(greeks.vega) : "text-term-text"}
          />
        </div>
      )}

      {greeksBySymbol.length > 1 && (
        <div className="border-t border-term-border bg-term-panel/60 px-3 py-2">
          <div className="mb-1.5 text-[9px] uppercase tracking-wide text-term-dim">By symbol</div>
          <div className="flex flex-wrap gap-2">
            {greeksBySymbol.map((g) => (
              <div
                key={g.symbol}
                className="flex items-center gap-2.5 rounded border border-term-accent/30 px-2 py-1 text-2xs"
                title={`Net Greeks for ${g.symbol} alone`}
              >
                <span className="font-semibold text-term-accent">{g.symbol}</span>
                <span className="num flex gap-2">
                  <span className={signColor(g.delta)}>Δ {nf(g.delta, 1)}</span>
                  <span className={signColor(g.theta)}>Θ {nf(g.theta, 1)}</span>
                  <span className={signColor(g.vega)}>V {nf(g.vega, 1)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
