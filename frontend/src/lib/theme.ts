/** Terminal appearance — accent colour + dark background preset.
 *  Values are space-separated RGB channels (for Tailwind's `/opacity`).
 *  Persisted in localStorage; applied to :root as --term-* variables. */

export type Accent =
  | "blue" | "sky" | "cyan" | "teal" | "emerald" | "green" | "lime"
  | "amber" | "orange" | "rose" | "pink" | "fuchsia" | "violet" | "indigo";
export type Ground =
  | "light" | "mist" | "dusk" | "charcoal" | "black" | "slate" | "navy" | "ink" | "graphite" | "forest" | "plum";

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
  /** a light ground also swaps the text colours and flips data-light on <html> */
  text?: string;
  dim?: string;
  light?: boolean;
}[] = [
  { id: "light", label: "Light", bg: "203 211 223", panel: "225 231 240", panel2: "212 220 231", border: "128 142 164", text: "20 30 48", dim: "62 76 98", light: true },
  { id: "mist", label: "Mist", bg: "36 50 71", panel: "58 77 106", panel2: "46 62 87", border: "118 139 174", text: "245 248 252", dim: "212 221 235" },
  { id: "dusk", label: "Dusk", bg: "24 33 47", panel: "42 55 76", panel2: "31 42 60", border: "92 110 140", text: "240 245 250", dim: "190 202 220" },
  { id: "charcoal", label: "Charcoal", bg: "12 17 26", panel: "28 39 55", panel2: "19 27 39", border: "66 80 102" },
  { id: "black", label: "Black", bg: "6 9 14", panel: "22 31 45", panel2: "13 20 31", border: "55 68 88" },
  { id: "slate", label: "Slate", bg: "17 24 36", panel: "34 46 64", panel2: "25 34 50", border: "74 89 112" },
  { id: "navy", label: "Navy", bg: "10 16 32", panel: "26 38 66", panel2: "16 25 46", border: "62 80 118" },
  { id: "ink", label: "Ink", bg: "14 14 21", panel: "34 34 48", panel2: "22 22 32", border: "72 72 92" },
  { id: "graphite", label: "Graphite", bg: "18 20 23", panel: "40 43 50", panel2: "28 30 35", border: "80 85 95" },
  { id: "forest", label: "Forest", bg: "10 19 16", panel: "26 42 37", panel2: "16 28 24", border: "58 84 74" },
  { id: "plum", label: "Plum", bg: "18 13 24", panel: "42 32 54", panel2: "28 21 36", border: "84 66 102" },
];

const A_KEY = "gt.accent";
const G_KEY = "gt.ground";
const Z_KEY = "gt.uiZoom";

/** desktop interface scale (%). Chrome `zoom` — does NOT shift media queries,
 *  so the desktop layout rules still apply, it just renders tighter. */
export const UI_ZOOM_MIN = 80;
export const UI_ZOOM_MAX = 120;
export const UI_ZOOM_STEP = 5;
export const UI_ZOOM_DEFAULT = 85;
export const UI_ZOOMS = [80, 85, 90, 95, 100, 105, 110, 115, 120] as const;
export const getUiZoom = (): number => {
  const n = parseInt(get(Z_KEY) || String(UI_ZOOM_DEFAULT), 10);
  return (UI_ZOOMS as readonly number[]).includes(n) ? n : UI_ZOOM_DEFAULT;
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
  (ACCENTS.find((a) => a.id === get(A_KEY))?.id ?? "emerald") as Accent;
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
  root.setProperty("--term-text", g.text ?? "232 238 246");
  root.setProperty("--term-dim", g.dim ?? "160 174 194");
  document.documentElement.toggleAttribute("data-light", !!g.light);
  document.documentElement.classList.toggle("dark", !g.light);
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

/** chart grid / axis-border colours that read on the current background */
export const isLightGround = (): boolean => document.documentElement.hasAttribute("data-light");
export const chartGrid = (): string => (isLightGround() ? "#c3ccda" : "#141c27");
export const chartAxis = (): string => (isLightGround() ? "#aab5c7" : "#1e2733");
