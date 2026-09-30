import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Drop-down with a tick-list: the button shows a label + how many are on, the list stays open
 *  while several items are toggled. Portalled to <body> like SelectMenu, so a small pane never
 *  clips it. Closes on outside-click, scroll or resize. */
export function MultiSelectMenu<K extends string>({
  label,
  options,
  active,
  onToggle,
  title,
  width = 150,
}: {
  label: string;
  options: readonly (readonly [K, string])[];
  active: Partial<Record<K, boolean>>;
  onToggle: (k: K) => void;
  title?: string;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const count = options.filter(([k]) => active[k]).length;

  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r)
      setPos({
        top: Math.round(r.bottom + 4),
        left: Math.round(Math.max(4, Math.min(r.left, window.innerWidth - width - 4))),
      });
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
  }, [open, width]);

  return (
    <span className="relative inline-flex">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={title}
        className={`flex items-center gap-1 rounded border px-2 py-0.5 text-2xs font-semibold ${
          open || count > 0
            ? "border-term-accent/50 bg-term-accent/15 text-term-text"
            : "border-term-dim/70 text-term-dim hover:bg-term-border hover:text-term-text"
        }`}
      >
        <span>{label}</span>
        {count > 0 && <span className="num text-term-accent">{count}</span>}
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
              {options.map(([k, lbl]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => onToggle(k)}
                  className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left ${
                    active[k]
                      ? "bg-term-accent/15 text-term-text"
                      : "text-term-dim hover:bg-term-border hover:text-term-text"
                  }`}
                >
                  <span>{lbl}</span>
                  <span className={active[k] ? "text-term-accent" : "opacity-30"}>{active[k] ? "☑" : "☐"}</span>
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </span>
  );
}
