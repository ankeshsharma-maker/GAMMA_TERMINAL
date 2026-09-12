import { useRef } from "react";

/** read a persisted panel width/size from localStorage, falling back to `d`. */
export const readNum = (k: string, d: number): number => {
  try {
    const v = parseFloat(localStorage.getItem(k) || "");
    return Number.isFinite(v) ? v : d;
  } catch {
    return d;
  }
};

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** vertical drag handle that resizes a neighbouring column. */
export function VSplit({
  onDrag,
  className = "",
}: {
  onDrag: (dx: number) => void;
  className?: string;
}) {
  const last = useRef<number | null>(null);
  const down = (e: React.MouseEvent) => {
    e.preventDefault();
    last.current = e.clientX;
    const move = (ev: MouseEvent) => {
      if (last.current == null) return;
      onDrag(ev.clientX - last.current);
      last.current = ev.clientX;
    };
    const up = () => {
      last.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
  };
  return (
    <div
      onMouseDown={down}
      className={`z-10 w-1 shrink-0 cursor-col-resize bg-term-border transition-colors hover:bg-term-accent ${className}`}
      title="Drag to resize panel"
    />
  );
}
