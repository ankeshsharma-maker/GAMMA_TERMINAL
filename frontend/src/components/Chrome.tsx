import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The header block shared by the screens: an accent-tinted frame holding up to three rows --
 *  pickers, view tabs and a one-line status. See the .chrome classes in index.css. */
export function Chrome({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`chrome ${className}`}>{children}</div>;
}
export function ChromeRow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`chrome-row ${className}`}>{children}</div>;
}

export type ChromeTab<K extends string> = { key: K; label: string; short?: string; badge?: string | number };

/** View tabs that always fit one row: `main` are buttons, `more` collapse into a "More ▾" menu (the label of
 *  the open one replaces "More" so you can see where you are). */
export function ChromeTabs<K extends string>({
  main,
  more = [],
  value,
  onChange,
}: {
  main: ChromeTab<K>[];
  more?: ChromeTab<K>[];
  value: K;
  onChange: (k: K) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const inMore = more.find((m) => m.key === value);

  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const w = 190;
      setPos({ top: Math.round(r.bottom + 4), left: Math.round(Math.max(6, Math.min(r.right - w, window.innerWidth - w - 6))) });
    }
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
  }, [open]);
  useEffect(() => setOpen(false), [value]);

  return (
    <div className="chrome-tabs">
      {main.map((t) => (
        <button key={t.key} type="button" className={value === t.key ? "on" : ""} onClick={() => onChange(t.key)}>
          {t.label}
          {t.badge != null && t.badge !== "" && <span className="ml-1 opacity-80">{t.badge}</span>}
        </button>
      ))}
      {more.length > 0 && (
        <>
          <button ref={btnRef} type="button" className={inMore ? "on" : ""} onClick={() => setOpen((o) => !o)}>
            {inMore ? inMore.short ?? inMore.label : "More"} ▾
          </button>
          {open &&
            createPortal(
              <>
                <div className="fixed inset-0 z-[199]" onClick={() => setOpen(false)} />
                <div
                  ref={listRef}
                  className="fixed z-[200] w-[190px] rounded-xl border border-term-border bg-term-panel p-1 text-[13px] shadow-2xl"
                  style={{ top: pos.top, left: pos.left }}
                >
                  {more.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => {
                        onChange(m.key);
                        setOpen(false);
                      }}
                      className={`flex min-h-[40px] w-full items-center justify-between rounded-lg px-3 py-2 text-left font-semibold ${
                        value === m.key ? "bg-term-accent/20 text-term-text" : "text-term-dim hover:bg-term-border hover:text-term-text"
                      }`}
                    >
                      <span>{m.label}</span>
                      {value === m.key && <span className="text-term-accent">✓</span>}
                    </button>
                  ))}
                </div>
              </>,
              document.body
            )}
        </>
      )}
    </div>
  );
}
