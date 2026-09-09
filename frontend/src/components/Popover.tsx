import { useState } from "react";

export type PanelKind = null | "controls" | "info";

/** Shared "slim bar + popover" pattern used across the dense views.
 *  A view keeps `const [panel, setPanel] = usePanel()`, renders <PanelButtons>
 *  in its slim bar and <Popover> for whichever panel is open. */
export function usePanel() {
  return useState<PanelKind>(null);
}

export function PanelButtons({
  panel,
  setPanel,
  info = true,
  label = "Controls",
}: {
  panel: PanelKind;
  setPanel: (p: PanelKind) => void;
  info?: boolean;
  label?: string;
}) {
  const cls = (on: boolean) =>
    `rounded border px-2 py-0.5 font-semibold ${
      on
        ? "border-term-accent text-term-accent"
        : "border-term-border text-term-dim hover:text-term-text"
    }`;
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => setPanel(panel === "controls" ? null : "controls")}
        className={cls(panel === "controls")}
        title="Controls"
      >
        ⚙ {label}
      </button>
      {info && (
        <button
          onClick={() => setPanel(panel === "info" ? null : "info")}
          className={cls(panel === "info")}
          title="Legend & details"
        >
          ⓘ
        </button>
      )}
    </div>
  );
}

/** Floating panel anchored under the slim bar. Closes on outside-click.
 *  Must sit inside a `position: relative` bar. */
export function Popover({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-2 top-full z-50 mt-1 max-h-[72vh] w-[280px] max-w-[92vw] space-y-1.5 overflow-y-auto rounded-lg border border-term-border bg-term-panel p-3 text-2xs shadow-2xl">
        <div className="flex items-center justify-between">
          <span className="font-semibold uppercase tracking-wide text-term-dim">{title}</span>
          <button onClick={onClose} className="text-term-dim hover:text-term-text">
            ✕
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

/** one labelled control row inside a Popover */
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-term-dim">{label}</span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}
