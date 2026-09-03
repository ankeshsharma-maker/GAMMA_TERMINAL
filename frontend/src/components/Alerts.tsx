import { useStore } from "../store";
import { hhmm } from "../lib/format";

const sevStyle: Record<string, string> = {
  critical: "border-l-down bg-down/10 text-down",
  warning: "border-l-amber-500 bg-amber-500/10 text-amber-400",
  info: "border-l-term-accent bg-term-accent/10 text-term-accent",
};

export function Alerts({ compact = false }: { compact?: boolean }) {
  const alerts = useStore((s) => s.alerts);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-y border-term-border px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-term-dim">
        Alert Feed {alerts.length > 0 && <span className="text-term-text">({alerts.length})</span>}
      </div>
      <div className={`overflow-y-auto ${compact ? "max-h-40" : "flex-1"}`}>
        {alerts.length === 0 && (
          <div className="p-3 text-2xs text-term-dim">No alerts. Thresholds fire on IV pops, straddle expansion, and rising blast scores.</div>
        )}
        {alerts.map((a, i) => (
          <div
            key={a.ts + a.kind + i}
            className={`border-b border-term-border/40 border-l-2 px-3 py-1.5 text-2xs ${
              sevStyle[a.severity] ?? ""
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold">{a.symbol}</span>
              <span className="num text-term-dim">{hhmm(a.ts)}</span>
            </div>
            <div className="text-term-text/90">{a.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
