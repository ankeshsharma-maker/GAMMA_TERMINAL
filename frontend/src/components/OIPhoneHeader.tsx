import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { SelectMenu } from "./SelectMenu";
import { Chrome, ChromeRow, ChromeTabs } from "./Chrome";

export type OiView = "chart" | "insights" | "chain" | "walls" | "gex" | "dex" | "pcr" | "history";

const MAIN: { key: OiView; label: string }[] = [
  { key: "chart", label: "Chart" },
  { key: "insights", label: "Insights" },
  { key: "chain", label: "Chain" },
  { key: "walls", label: "Walls" },
];
const MORE: { key: OiView; label: string; short: string }[] = [
  { key: "gex", label: "Weekly GEX", short: "GEX" },
  { key: "dex", label: "Dealer exposure", short: "Dealer" },
  { key: "pcr", label: "PCR vs price", short: "PCR" },
  { key: "history", label: "History (daily)", short: "History" },
];

/** The phone's OI header, shared by every OI view: row 1 = what you look at (symbol, expiry, ΔOI window, ⚙),
 *  row 2 = which view (Chart | Insights | Chain | Walls | More ▾), row 3 = that view's status / controls. */
export function OIPhoneHeader({
  active,
  onView,
  tf,
  onGear,
  gearOn,
  children,
}: {
  active: OiView;
  onView: (v: OiView) => void;
  /** the ΔOI window picker of the host view (omitted where it does not apply) */
  tf?: ReactNode;
  onGear?: () => void;
  gearOn?: boolean;
  /** row 3 */
  children?: ReactNode;
}) {
  const { chain, symbol, expiry, selectExpiry, selectSymbol, symClass, symClassOk } = useStore();
  const [choices, setChoices] = useState<string[]>([]);
  useEffect(() => {
    api.symbols().then(
      (d) => setChoices([...new Set([...(d.indices ?? []), ...(d.fo ?? []), ...(d.defaults ?? [])])].sort()),
      () => {}
    );
  }, []);
  const symOptions = useMemo(
    () =>
      [...new Set([symbol, ...choices])]
        .filter(Boolean)
        .filter((s) => s === symbol || symClassOk(s))
        .sort()
        .map((s) => [s, s] as [string, string]),
    [choices, symbol, symClass, symClassOk]
  );
  const exp = expiry ?? chain?.expiry ?? "";

  return (
    <Chrome>
      <ChromeRow>
        <span className="pick p-0 border-0 bg-transparent">
          <SelectMenu value={symbol} options={symOptions} onChange={(v) => selectSymbol(v, true)} title="Underlying" width={150} />
        </span>
        {chain && chain.expiries.length > 0 && (
          <span className="pick p-0 border-0 bg-transparent">
            <SelectMenu
              value={exp}
              options={chain.expiries.map((e) => [e, e] as [string, string])}
              onChange={selectExpiry}
              title="Expiry"
              width={130}
            />
          </span>
        )}
        {tf}
        {onGear && (
          <button
            type="button"
            onClick={onGear}
            className={`ml-auto shrink-0 rounded border px-2 py-0.5 text-2xs font-semibold ${
              gearOn ? "border-term-accent bg-term-accent/20 text-term-text" : "border-term-accent/50 text-term-text"
            }`}
            title="Filters, strikes shown, OI totals"
          >
            ⚙ {gearOn ? "▴" : "▾"}
          </button>
        )}
      </ChromeRow>
      <ChromeTabs<OiView> main={MAIN.map((m) => ({ key: m.key, label: m.label }))} more={MORE} value={active} onChange={onView} />
      {children && <ChromeRow>{children}</ChromeRow>}
    </Chrome>
  );
}
