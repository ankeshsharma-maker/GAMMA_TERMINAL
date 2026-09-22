import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, signColor } from "../lib/format";

const rupee = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? "–" : `₹${Math.round(n).toLocaleString("en-IN")}`;

type GreekBucket = { delta: number; gamma: number; theta: number; vega: number; positions: number };
type GreekBySymbol = GreekBucket & { symbol: string };

function TH({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-term-dim ${right ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}
function TD({ children, tone = "text-term-text", title }: { children: React.ReactNode; tone?: string; title?: string }) {
  return (
    <td className={`num px-3 py-1.5 text-right text-sm font-semibold ${tone}`} title={title}>
      {children}
    </td>
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
        <div className="overflow-x-auto">
          <table className="grid-table w-full">
            <thead>
              <tr className="bg-term-panel">
                <TH>{greeksBySymbol.length > 1 ? "Symbol" : "Total"}</TH>
                <TH right>Margin free</TH>
                <TH right>Margin used</TH>
                <TH right>Deployed</TH>
                <TH right>Δ Delta</TH>
                <TH right>Γ Gamma</TH>
                <TH right>Θ Theta</TH>
                <TH right>V Vega</TH>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="px-3 py-1.5 text-sm font-semibold text-term-text">
                  {greeksBySymbol.length > 1 ? "All symbols" : "Portfolio"}
                </td>
                <TD tone={available != null && available < 0 ? "text-down" : "text-up"} title="Available margin, same figure as the Funds tab">
                  {rupee(available)}
                </TD>
                <TD tone={used ? "text-amber-400" : "text-term-text"}>{rupee(used)}</TD>
                <TD tone={deployedTone}>{pctDeployed != null ? `${nf(pctDeployed, 0)}%` : "–"}</TD>
                <TD tone={greeks ? signColor(greeks.delta) : "text-term-text"} title="Net delta across every open position">
                  {greeks ? nf(greeks.delta, 1) : "–"}
                </TD>
                <TD tone={greeks ? signColor(greeks.gamma) : "text-term-text"}>{greeks ? nf(greeks.gamma, 3) : "–"}</TD>
                <TD tone={greeks ? signColor(greeks.theta) : "text-term-text"} title="Positive = net premium seller, decaying in your favour">
                  {greeks ? nf(greeks.theta, 1) : "–"}
                </TD>
                <TD tone={greeks ? signColor(greeks.vega) : "text-term-text"}>{greeks ? nf(greeks.vega, 1) : "–"}</TD>
              </tr>
              {greeksBySymbol.length > 1 &&
                greeksBySymbol.map((g) => (
                  <tr key={g.symbol}>
                    <td className="px-3 py-1.5 text-sm font-semibold text-term-accent">{g.symbol}</td>
                    <TD tone="text-term-dim">–</TD>
                    <TD tone="text-term-dim">–</TD>
                    <TD tone="text-term-dim">–</TD>
                    <TD tone={signColor(g.delta)}>{nf(g.delta, 1)}</TD>
                    <TD tone={signColor(g.gamma)}>{nf(g.gamma, 3)}</TD>
                    <TD tone={signColor(g.theta)}>{nf(g.theta, 1)}</TD>
                    <TD tone={signColor(g.vega)}>{nf(g.vega, 1)}</TD>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
