import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** ƒx-style single-select: a button showing the current label that opens a
 *  click-to-pick list (✓ on the active row). The list is portalled to <body>
 *  with fixed positioning so it never gets clipped by a scrolling panel.
 *  Closes on outside-click, pick, scroll or resize. */
export function SelectMenu<T extends string | number>({
  value,
  options,
  onChange,
  title,
  align = "left",
  width = 130,
  highlightValue,
}: {
  value: T | undefined | null;
  options: readonly (readonly [string, T])[];
  onChange: (v: T) => void;
  title?: string;
  align?: "left" | "right";
  width?: number;
  /** option to scroll into view and mark (e.g. the ATM strike) whenever the menu opens. */
  highlightValue?: T | null;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const cur =
    options.find(([, v]) => v === value)?.[0] ?? (value == null ? "" : String(value));

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const left = align === "right" ? r.right - width : r.left;
      setPos({
        top: Math.round(r.bottom + 4),
        left: Math.round(Math.max(4, Math.min(left, window.innerWidth - width - 4))),
      });
    };
    place();
    // scroll doesn't bubble, but a capture-phase listener on window still fires
    // for a scroll inside the list itself -- ignore those, only close when
    // something outside the list (e.g. a parent panel) scrolls under it.
    const close = (e: Event) => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, align, width]);

  // bring the highlighted option (e.g. ATM) into view by default instead of
  // opening at the top of a long list
  useLayoutEffect(() => {
    if (!open || highlightValue == null) return;
    const id = requestAnimationFrame(() => {
      highlightRef.current?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(id);
  }, [open, highlightValue]);

  return (
    <span className="relative inline-flex">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={title}
        className={`flex items-center gap-1 rounded border px-2 py-0.5 text-2xs font-semibold ${
          open
            ? "border-term-accent/50 bg-term-accent/15 text-term-text"
            : "border-term-border text-term-dim hover:bg-term-border hover:text-term-text"
        }`}
      >
        <span className="truncate" style={{ maxWidth: width }}>
          {cur}
        </span>
        <span className="text-[8px] opacity-70">▾</span>
      </button>
      {open &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[199]" onClick={() => setOpen(false)} />
            <div
              ref={listRef}
              className="fixed z-[200] max-h-[60vh] overflow-y-auto rounded-lg border border-term-border bg-term-panel p-1 text-2xs shadow-2xl"
              style={{ top: pos.top, left: pos.left, width }}
            >
              {options.map(([lbl, v]) => {
                const isHighlight = highlightValue != null && v === highlightValue;
                return (
                  <button
                    key={String(v)}
                    ref={isHighlight ? highlightRef : undefined}
                    type="button"
                    onClick={() => {
                      onChange(v);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left ${
                      v === value
                        ? "bg-term-accent/15 text-term-text"
                        : isHighlight
                        ? "bg-amber-500/10 text-term-text"
                        : "text-term-dim hover:bg-term-border hover:text-term-text"
                    }`}
                  >
                    <span>{lbl}</span>
                    {v === value && <span className="text-term-accent">✓</span>}
                  </button>
                );
              })}
            </div>
          </>,
          document.body
        )}
    </span>
  );
}
