import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { SelectMenu } from "./SelectMenu";

/** "08-Sep-2026" -> "Sep-2026" (month bucket key) */
const monthKey = (e: string) => {
  const p = e.split("-");
  return p.length === 3 ? `${p[1]}-${p[2]}` : e;
};

export function ExpiryTabs() {
  const { chain, expiry, selectExpiry, symbol, selectSymbol, symClass, symClassOk } = useStore();

  const [symChoices, setSymChoices] = useState<string[]>([]);
  useEffect(() => {
    api.symbols().then(
      (d) => setSymChoices([...new Set([...(d.indices ?? []), ...(d.fo ?? []), ...(d.defaults ?? [])])].sort()),
      () => {}
    );
  }, []);
  const symOptions = useMemo(
    () =>
      [...new Set([symbol, ...symChoices])]
        .filter(Boolean)
        .filter((s) => s === symbol || symClassOk(s))
        .sort(),
    [symbol, symChoices, symClass]
  );

  const symSelect = (
    <span className="shrink-0">
      <SelectMenu
        value={symbol}
        options={symOptions.map((s) => [s, s] as [string, string])}
        onChange={(v) => selectSymbol(v, true)}
        title="Underlying"
        width={150}
      />
    </span>
  );

  if (!chain) {
    return (
      <div className="flex items-center gap-1 border-b border-term-border bg-term-panel2 px-3 py-1.5">
        {symSelect}
        <span className="text-2xs text-term-dim">loading chain…</span>
      </div>
    );
  }

  const cur = expiry ?? chain.expiry;
  const all = chain.expiries;

  // individual tabs = every expiry in the same calendar month as the nearest one
  // (the front-month weeklies); everything later goes into the dropdown.
  const frontKey = all.length ? monthKey(all[0]) : "";
  let tabs = all.filter((e) => monthKey(e) === frontKey);
  let rest = all.filter((e) => monthKey(e) !== frontKey);
  if (tabs.length === 0) {
    tabs = all.slice(0, 6);
    rest = all.slice(6);
  }
  const restSelected = rest.includes(cur);

  return (
    <div className="flex items-center gap-1 border-b border-term-border bg-term-panel2 px-3 py-1.5">
      {symSelect}
      <span className="mx-0.5 h-4 w-px shrink-0 bg-term-border" />
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
          <span className="shrink-0">
            <SelectMenu
              value={restSelected ? cur : ""}
              options={[["Later ▾", ""], ...rest.map((e) => [e, e] as [string, string])]}
              onChange={(v) => v && selectExpiry(v)}
              title="Later monthly expiries"
              width={120}
            />
          </span>
        )}
      </div>
    </div>
  );
}
