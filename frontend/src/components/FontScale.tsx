import { useEffect, useState } from "react";

/* user text-size control (A- / A+), persisted, applied to <html> */
const FONT_LS = "ui.fontScale";
const FONT_MIN = 0.8;
const FONT_MAX = 1.4;

export function applyFontScale() {
  let v = 1;
  try {
    v = parseFloat(localStorage.getItem(FONT_LS) || "1") || 1;
  } catch {
    /* ignore */
  }
  v = Math.min(FONT_MAX, Math.max(FONT_MIN, v));
  document.documentElement.style.setProperty("--ui-font-scale", String(v));
  return v;
}

export function FontScale() {
  const [scale, setScale] = useState(applyFontScale);
  useEffect(() => {
    try {
      localStorage.setItem(FONT_LS, String(scale));
    } catch {
      /* ignore */
    }
    document.documentElement.style.setProperty("--ui-font-scale", String(scale));
  }, [scale]);
  const step = (d: number) =>
    setScale((p) => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round((p + d) * 100) / 100)));
  return (
    <div
      className="flex items-center overflow-hidden rounded border border-term-border text-2xs"
      title="Text size"
    >
      <button
        onClick={() => step(-0.1)}
        disabled={scale <= FONT_MIN + 1e-6}
        className="px-1.5 py-1 text-term-dim hover:bg-term-border hover:text-term-text disabled:opacity-30"
      >
        A−
      </button>
      <button
        onClick={() => setScale(1)}
        title="Reset text size"
        className="border-x border-term-border px-1.5 py-1 text-[10px] text-term-dim hover:bg-term-border hover:text-term-text"
      >
        {Math.round(scale * 100)}%
      </button>
      <button
        onClick={() => step(0.1)}
        disabled={scale >= FONT_MAX - 1e-6}
        className="px-1.5 py-1 font-semibold text-term-dim hover:bg-term-border hover:text-term-text disabled:opacity-30"
      >
        A+
      </button>
    </div>
  );
}
