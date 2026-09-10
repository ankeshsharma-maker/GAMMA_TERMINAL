/** Terminal appearance — accent colour + dark background preset.
 *  Values are space-separated RGB channels (for Tailwind's `/opacity`).
 *  Persisted in localStorage; applied to :root as --term-* variables. */

export type Accent =
  | "blue" | "sky" | "cyan" | "teal" | "emerald" | "green" | "lime"
  | "amber" | "orange" | "rose" | "pink" | "fuchsia" | "violet" | "indigo";
export type Ground =
  | "charcoal" | "black" | "slate" | "navy" | "ink" | "graphite" | "forest" | "plum";

export const ACCENTS: { id: Accent; label: string; rgb: string }[] = [
  { id: "blue", label: "Blue", rgb: "59 130 246" },
  { id: "sky", label: "Sky", rgb: "14 165 233" },
  { id: "cyan", label: "Cyan", rgb: "6 182 212" },
  { id: "teal", label: "Teal", rgb: "20 184 166" },
  { id: "emerald", label: "Emerald", rgb: "16 185 129" },
  { id: "green", label: "Green", rgb: "34 197 94" },
  { id: "lime", label: "Lime", rgb: "132 204 22" },
  { id: "amber", label: "Amber", rgb: "245 158 11" },
  { id: "orange", label: "Orange", rgb: "249 115 22" },
  { id: "rose", label: "Rose", rgb: "244 63 94" },
  { id: "pink", label: "Pink", rgb: "236 72 153" },
  { id: "fuchsia", label: "Fuchsia", rgb: "217 70 239" },
  { id: "violet", label: "Violet", rgb: "139 92 246" },
  { id: "indigo", label: "Indigo", rgb: "99 102 241" },
];

export const GROUNDS: {
  id: Ground;
  label: string;
  bg: string;
  panel: string;
  panel2: string;
  border: string;
}[] = [
  { id: "charcoal", label: "Charcoal", bg: "15 20 29", panel: "27 36 49", panel2: "21 29 41", border: "38 48 63" },
  { id: "black", label: "Black", bg: "8 11 17", panel: "21 28 40", panel2: "14 21 32", border: "26 35 49" },
  { id: "slate", label: "Slate", bg: "20 27 39", panel: "31 41 56", panel2: "26 34 48", border: "45 57 76" },
  { id: "navy", label: "Navy", bg: "12 19 36", panel: "23 33 58", panel2: "17 26 47", border: "36 49 82" },
  { id: "ink", label: "Ink", bg: "17 17 24", panel: "31 31 42", panel2: "23 23 33", border: "44 44 58" },
  { id: "graphite", label: "Graphite", bg: "22 24 27", panel: "36 39 44", panel2: "29 31 36", border: "52 56 63" },
  { id: "forest", label: "Forest", bg: "12 22 19", panel: "22 36 32", panel2: "17 29 25", border: "34 52 46" },
  { id: "plum", label: "Plum", bg: "22 16 28", panel: "38 29 47", panel2: "29 22 37", border: "54 42 66" },
];

const A_KEY = "gt.accent";
const G_KEY = "gt.ground";
const Z_KEY = "gt.uiZoom";

/** desktop interface scale (%). Chrome `zoom` — does NOT shift media queries,
 *  so the desktop layout rules still apply, it just renders tighter. */
export const UI_ZOOMS = [75, 80, 85, 90, 100, 110, 125] as const;
export const getUiZoom = (): number => {
  const n = parseInt(get(Z_KEY) || "85", 10);
  return (UI_ZOOMS as readonly number[]).includes(n) ? n : 85;
};
export function applyUiZoom(z = getUiZoom()): void {
  // only on the desktop terminal — the phone UI is already sized for its screen
  const on = window.matchMedia("(min-width: 901px)").matches;
  (document.documentElement.style as any).zoom = on ? String(z / 100) : "";
}
export function setUiZoom(z: number): void {
  try {
    localStorage.setItem(Z_KEY, String(z));
  } catch {
    /* ignore */
  }
  applyUiZoom(z);
}

const get = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

export const getAccent = (): Accent =>
  (ACCENTS.find((a) => a.id === get(A_KEY))?.id ?? "blue") as Accent;
export const getGround = (): Ground =>
  (GROUNDS.find((g) => g.id === get(G_KEY))?.id ?? "charcoal") as Ground;

export function applyTheme(accent = getAccent(), ground = getGround()): void {
  const root = document.documentElement.style;
  const a = ACCENTS.find((x) => x.id === accent) ?? ACCENTS[0];
  const g = GROUNDS.find((x) => x.id === ground) ?? GROUNDS[0];
  root.setProperty("--term-accent", a.rgb);
  root.setProperty("--term-bg", g.bg);
  root.setProperty("--term-panel", g.panel);
  root.setProperty("--term-panel2", g.panel2);
  root.setProperty("--term-border", g.border);
  // keep the browser/status-bar chrome in sync with the ground
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", `rgb(${g.bg.replace(/ /g, ",")})`);
}

export function setAccent(id: Accent): void {
  try {
    localStorage.setItem(A_KEY, id);
  } catch {
    /* ignore */
  }
  applyTheme(id, getGround());
}

export function setGround(id: Ground): void {
  try {
    localStorage.setItem(G_KEY, id);
  } catch {
    /* ignore */
  }
  applyTheme(getAccent(), id);
}
