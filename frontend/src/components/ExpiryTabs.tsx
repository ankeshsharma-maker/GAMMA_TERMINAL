import { useStore } from "../store";

const N_TABS = 6;

export function ExpiryTabs() {
  const { chain, expiry, selectExpiry } = useStore();
  if (!chain) return null;

  const cur = expiry ?? chain.expiry;
  const tabs = chain.expiries.slice(0, N_TABS);
  const rest = chain.expiries.slice(N_TABS);
  const restSelected = rest.includes(cur);

  return (
    <div className="flex items-center gap-1 border-b border-term-border bg-term-panel2 px-3 py-1.5">
      <div className="flex flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((e) => (
          <button
            key={e}
            onClick={() => selectExpiry(e)}
            className={`shrink-0 rounded px-2 py-1 text-2xs num transition-colors ${
              cur === e
                ? "bg-term-accent text-white"
                : "bg-term-panel text-term-dim hover:bg-term-border"
            }`}
          >
            {e}
          </button>
        ))}

        {rest.length > 0 && (
          <select
            value={restSelected ? cur : ""}
            onChange={(e) => e.target.value && selectExpiry(e.target.value)}
            className={`shrink-0 rounded border px-1.5 py-1 text-2xs num outline-none ${
              restSelected
                ? "border-term-accent bg-term-accent text-white"
                : "border-term-border bg-term-panel text-term-dim"
            }`}
            title="Further-out monthly expiries"
          >
            <option value="">Monthly ▾</option>
            {rest.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
