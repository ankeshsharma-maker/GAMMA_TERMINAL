import { useState } from "react";
import { useStore } from "../store";
import { nf } from "../lib/format";

const rupee = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? "–" : `₹${Math.round(n).toLocaleString("en-IN")}`;

/** prettify a raw Noren Limits key, e.g. "exposuremargin" -> "Exposure margin" */
const pretty = (k: string) =>
  k
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());

// Noren `Limits` fields worth surfacing, in a sensible order
const RAW_ORDER = [
  "cash",
  "payin",
  "payout",
  "brkcollamt",
  "collateral",
  "unclearedcash",
  "daycash",
  "marginused",
  "span",
  "spanused",
  "expo",
  "exposuremargin",
  "premium",
  "brokerage",
  "grexpo",
  "los",
];

function Card({
  label,
  value,
  tone = "",
  sub,
}: {
  label: string;
  value: string;
  tone?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-term-border bg-term-panel p-4">
      <div className="text-[11px] uppercase tracking-wide text-term-dim">{label}</div>
      <div className={`num mt-1 text-2xl font-semibold ${tone}`}>{value}</div>
      {sub && <div className="mt-0.5 text-2xs text-term-dim">{sub}</div>}
    </div>
  );
}

export function Funds() {
  const funds = useStore((s) => s.brokerFunds);
  const paper = useStore((s) => s.paper);
  const orderMode = useStore((s) => s.orderMode);
  const refreshBroker = useStore((s) => s.refreshBroker);
  const refreshPaper = useStore((s) => s.refreshPaper);
  const loadBrokerFunds = useStore((s) => s.loadBrokerFunds);
  const [busy, setBusy] = useState(false);

  const live = orderMode === "live" && funds?.connected && funds.available != null;
  const src = live ? "Flattrade (live)" : "Paper";

  const available = live ? funds!.available! : paper?.marginAvailable ?? null;
  const used = live ? funds!.used! : paper?.marginUsed ?? null;
  const total = live ? funds!.total! : paper ? paper.capital : null;

  const refresh = async () => {
    setBusy(true);
    try {
      if (live) await refreshBroker();
      else await loadBrokerFunds();
      await refreshPaper();
    } finally {
      setBusy(false);
    }
  };

  const rawEntries: [string, number][] = [];
  if (live && funds?.raw) {
    const r = funds.raw as Record<string, unknown>;
    const seen = new Set<string>();
    for (const k of RAW_ORDER) {
      const v = Number(r[k]);
      if (r[k] != null && r[k] !== "" && !Number.isNaN(v)) {
        rawEntries.push([k, v]);
        seen.add(k);
      }
    }
    for (const [k, val] of Object.entries(r)) {
      const v = Number(val);
      if (!seen.has(k) && val != null && val !== "" && !Number.isNaN(v) && Math.abs(v) > 0) {
        rawEntries.push([k, v]);
      }
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-base font-semibold">Funds &amp; Margin</h2>
        <span
          className={`rounded px-1.5 py-0.5 text-2xs ${
            live ? "bg-up/15 text-up" : "bg-term-border text-term-dim"
          }`}
        >
          {src}
        </span>
        <button className="btn ml-auto" onClick={refresh} disabled={busy}>
          {busy ? "…" : "⟳ refresh"}
        </button>
      </div>

      {orderMode === "live" && !funds?.connected && (
        <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-2xs text-amber-400">
          Broker not connected — showing paper figures. Connect Flattrade to see live margin.
        </div>
      )}
      {live && funds?.error && (
        <div className="mb-3 rounded border border-down/40 bg-down/10 px-3 py-2 text-2xs text-down">
          Broker funds error: {funds.error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card
          label="Available margin"
          value={rupee(available)}
          tone={available != null && available < 0 ? "text-down" : "text-up"}
        />
        <Card
          label="Used margin"
          value={rupee(used)}
          tone={used ? "text-amber-400" : ""}
        />
        <Card
          label={live ? "Total" : "Capital"}
          value={rupee(total)}
          sub={
            available != null && used != null
              ? `${nf((used / ((available ?? 0) + used || 1)) * 100, 1)}% deployed`
              : undefined
          }
        />
      </div>

      {!live && paper && (
        <div className="mt-4">
          <div className="mb-1.5 text-[11px] uppercase tracking-wide text-term-dim">
            Paper account
          </div>
          <table className="w-full max-w-md border border-term-border text-xs">
            <tbody>
              {(
                [
                  ["Starting capital", paper.capital],
                  ["Today's P&L", paper.todayPnl],
                  ["Total P&L", paper.total],
                  ["Realised P&L", paper.realized],
                  ["Unrealised P&L", paper.unrealized],
                  ["Margin used", paper.marginUsed],
                  ["Margin available", paper.marginAvailable],
                  ["Equity (capital + P&L)", paper.equity],
                ] as [string, number][]
              ).map(([k, v]) => (
                <tr key={k} className="border-b border-term-border/50 last:border-0">
                  <td className="px-3 py-1.5 text-term-dim">{k}</td>
                  <td
                    className={`num px-3 py-1.5 text-right ${
                      /P&L/.test(k) ? (v >= 0 ? "text-up" : "text-down") : "text-term-text"
                    }`}
                  >
                    {rupee(v)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-2xs text-term-dim">
            Short-option margin is estimated (≈11% of strike notional); it is not a real SPAN
            calculation.
          </p>
        </div>
      )}

      {live && rawEntries.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-[11px] uppercase tracking-wide text-term-dim">
            Flattrade limits (raw)
          </div>
          <table className="w-full max-w-md border border-term-border text-xs">
            <tbody>
              {rawEntries.map(([k, v]) => (
                <tr key={k} className="border-b border-term-border/50 last:border-0">
                  <td className="px-3 py-1.5 text-term-dim">{pretty(k)}</td>
                  <td className="num px-3 py-1.5 text-right text-term-text">{rupee(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
