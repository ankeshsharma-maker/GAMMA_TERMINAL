import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** One compact icon button in the header that opens a small portalled panel
 *  of arbitrary content (toggle buttons, actions) — lets a handful of
 *  low-frequency controls live behind a single trigger instead of eating
 *  header width themselves. Positioning/portal mechanics mirror SelectMenu. */
export function HeaderMenu({
  icon,
  title,
  children,
  width = 220,
}: {
  icon: ReactNode;
  title?: string;
  children: ReactNode;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const left = r.right - width;
      setPos({
        top: Math.round(r.bottom + 4),
        left: Math.round(Math.max(4, Math.min(left, window.innerWidth - width - 4))),
      });
    };
    place();
    const close = () => setOpen(false);
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
        className={`rounded border px-1.5 py-1 text-2xs ${
          open
            ? "border-term-accent/50 bg-term-accent/15 text-term-text"
            : "border-term-border text-term-dim hover:text-term-text"
        }`}
      >
        {icon}
      </button>
      {open &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[199]" onClick={() => setOpen(false)} />
            <div
              className="fixed z-[200] flex flex-col gap-0.5 rounded-lg border border-term-border bg-term-panel p-1.5 text-2xs shadow-2xl"
              style={{ top: pos.top, left: pos.left, width }}
              onClickCapture={() => setOpen(false)}
            >
              {children}
            </div>
          </>,
          document.body
        )}
    </span>
  );
}

/** A full-width row button inside a HeaderMenu panel. */
export function MenuRow({
  onClick,
  active,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left ${
        active ? "bg-term-accent/15 text-term-text" : "text-term-dim hover:bg-term-border hover:text-term-text"
      }`}
    >
      {children}
    </button>
  );
}
