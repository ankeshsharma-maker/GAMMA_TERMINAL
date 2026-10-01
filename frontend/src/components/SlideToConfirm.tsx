import { useRef, useState, type ReactNode } from "react";

/** Drag the thumb across to confirm -- replaces a tap button so an order can't go out on a stray touch.
 *  Release before the end and it springs back; keyboard users get Enter / Space on the thumb. */
export function SlideToConfirm({
  onConfirm,
  busy = false,
  tone = "accent",
  children,
}: {
  onConfirm: () => void;
  busy?: boolean;
  tone?: "up" | "down" | "accent";
  children: ReactNode;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  const [drag, setDrag] = useState(false);
  const start = useRef(0);
  const dragging = useRef(false);
  const xRef = useRef(0);
  const move = (v: number) => {
    xRef.current = v;
    setX(v);
  };
  const THUMB = 52;
  const max = () => Math.max(1, (trackRef.current?.clientWidth ?? 280) - THUMB - 8);
  const C = {
    up: { thumb: "bg-up", track: "bg-up/25 border-up/60", fill: "bg-up/35", text: "text-up" },
    down: { thumb: "bg-down", track: "bg-down/25 border-down/60", fill: "bg-down/35", text: "text-down" },
    accent: { thumb: "bg-term-accent", track: "bg-term-accent/25 border-term-accent/60", fill: "bg-term-accent/35", text: "text-term-accent" },
  }[tone];

  const finish = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setDrag(false);
    if (xRef.current >= max() * 0.88 && !busy) {
      move(max());
      onConfirm();
      window.setTimeout(() => move(0), 700);
    } else move(0);
  };

  return (
    <div
      ref={trackRef}
      className={`relative mt-3 flex h-[56px] select-none items-center justify-center overflow-hidden rounded-xl border ${C.track} ${C.text} ${busy ? "opacity-60" : ""}`}
      style={{ touchAction: "none" }}
    >
      <div className={`absolute inset-y-0 left-0 ${C.fill}`} style={{ width: x + THUMB + 4 }} />
      <span className="relative z-10 text-[14px] font-bold text-term-text" style={{ opacity: 1 - Math.min(1, x / (max() * 0.7)) }}>
        {busy ? "…" : children} {!busy && <span aria-hidden>›››</span>}
      </span>
      <button
        type="button"
        role="slider"
        aria-label="Slide to confirm"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((x / max()) * 100)}
        disabled={busy}
        onPointerDown={(e) => {
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* synthetic pointer */
          }
          start.current = e.clientX - xRef.current;
          dragging.current = true;
          setDrag(true);
        }}
        onPointerMove={(e) => {
          if (dragging.current) move(Math.max(0, Math.min(max(), e.clientX - start.current)));
        }}
        onPointerUp={finish}
        onPointerCancel={() => {
          dragging.current = false;
          setDrag(false);
          move(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!busy) onConfirm();
          }
        }}
        className={`absolute left-1 top-1 z-20 flex h-[46px] w-[52px] items-center justify-center rounded-lg ${C.thumb} text-[22px] font-bold text-white shadow-md`}
        style={{ transform: `translateX(${x}px)`, transition: drag ? "none" : "transform 0.2s" }}
      >
        ➜
      </button>
    </div>
  );
}
