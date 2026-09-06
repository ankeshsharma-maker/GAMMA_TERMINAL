import { useState } from "react";
import { useStore } from "../store";
import { ago } from "../lib/format";

/** Manual "refetch the option chain now" button — the chain also updates
 *  live over the socket, this just forces an immediate pull. */
export function RefreshChainBtn() {
  const refreshChain = useStore((s) => s.refreshChain);
  const fetchedAt = useStore((s) => s.chain?.fetchedAt);
  const [busy, setBusy] = useState(false);

  return (
    <button
      onClick={() => {
        setBusy(true);
        refreshChain().finally(() => setBusy(false));
      }}
      disabled={busy}
      title={fetchedAt ? `chain updated ${ago(fetchedAt)}` : "refresh chain"}
      className="flex items-center gap-1 rounded border border-term-border px-1.5 py-0.5 text-2xs text-term-dim hover:border-term-accent hover:text-term-text disabled:opacity-40"
    >
      <span className={busy ? "inline-block animate-spin" : ""}>⟳</span>
      {busy ? "…" : "Refresh"}
    </button>
  );
}
