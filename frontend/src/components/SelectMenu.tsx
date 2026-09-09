import { useState } from "react";

/** ƒx-style single-select: a button showing the current label that opens a
 *  click-to-pick list (✓ on the active row). Closes on outside-click or pick. */
export function SelectMenu<T extends string | number>({
  value,
  options,
  onChange,
  title,
  align = "left",
  width = 130,
}: {
  value: T;
  options: readonly (readonly [string, T])[];
  onChange: (v: T) => void;
  title?: string;
  align?: "left" | "right";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const cur = options.find(([, v]) => v === value)?.[0] ?? String(value);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={title}
        className={`flex items-center gap-1 rounded border px-2 py-0.5 text-2xs font-semibold ${
          open
            ? "border-term-accent/50 bg-term-accent/15 text-term-text"
            : "border-term-border text-term-dim hover:bg-term-border hover:text-term-text"
        }`}
      >
        {cur}
        <span className="text-[8px] opacity-70">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className={`absolute ${
              align === "right" ? "right-0" : "left-0"
            } top-full z-50 mt-1 max-h-[60vh] overflow-y-auto rounded-lg border border-term-border bg-term-panel p-1 text-2xs shadow-2xl`}
            style={{ width }}
          >
            {options.map(([lbl, v]) => (
              <button
                key={String(v)}
                type="button"
                onClick={() => {
                  onChange(v);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left ${
                  v === value
                    ? "bg-term-accent/15 text-term-text"
                    : "text-term-dim hover:bg-term-border hover:text-term-text"
                }`}
              >
                <span>{lbl}</span>
                {v === value && <span className="text-term-accent">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
