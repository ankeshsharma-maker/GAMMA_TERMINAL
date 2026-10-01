/** Terminal appearance — accent colour + dark background preset.
 *  Values are space-separated RGB channels (for Tailwind's `/opacity`).
 *  Persisted in localStorage; applied to :root as --term-* variables. */

export type Accent =
  | "blue" | "sky" | "cyan" | "teal" | "emerald" | "green" | "lime"
  | "amber" | "orange" | "rose" | "pink" | "fuchsia" | "violet" | "indigo"
  | "steel" | "dustyteal" | "sage" | "mutedgold" | "terracotta" | "dustyrose" | "mutedviolet" | "taupe" | "slateblue" | "sand"
  | "gold" | "coral" | "red" | "crimson" | "purple" | "mint" | "silver" | "brown";
export type Ground =
  | "light" | "cream" | "sage" | "sky" | "mist" | "dusk" | "wine" | "olive" | "coffee" | "ocean" | "charcoal" | "black" | "slate" | "navy" | "ink" | "graphite" | "forest" | "plum";

export const ACCENTS: { id: Accent; label: string; rgb: string; dark?: boolean }[] = [
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
  { id: "steel", label: "Steel blue", rgb: "111 143 176", dark: true },
  { id: "dustyteal", label: "Dusty teal", rgb: "95 158 160", dark: true },
  { id: "sage", label: "Sage", rgb: "143 169 136", dark: true },
  { id: "mutedgold", label: "Muted gold", rgb: "200 169 97", dark: true },
  { id: "terracotta", label: "Terracotta", rgb: "194 124 94", dark: true },
  { id: "dustyrose", label: "Dusty rose", rgb: "185 128 140", dark: true },
  { id: "mutedviolet", label: "Muted violet", rgb: "154 143 191", dark: true },
  { id: "taupe", label: "Taupe", rgb: "168 159 145", dark: true },
  { id: "slateblue", label: "Slate", rgb: "125 147 168", dark: true },
  { id: "sand", label: "Sand", rgb: "181 164 120", dark: true },
  { id: "gold", label: "Gold", rgb: "234 179 8" },
  { id: "coral", label: "Coral", rgb: "251 113 85" },
  { id: "red", label: "Red", rgb: "239 68 68" },
  { id: "crimson", label: "Crimson", rgb: "190 24 60" },
  { id: "purple", label: "Purple", rgb: "168 85 247" },
  { id: "mint", label: "Mint", rgb: "110 231 183" },
  { id: "silver", label: "Silver", rgb: "176 186 201" },
  { id: "brown", label: "Brown", rgb: "180 120 80" },
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
  { id: "cream", label: "Cream", bg: "222 214 196", panel: "240 234 220", panel2: "230 223 207", border: "158 146 120", text: "40 33 22", dim: "92 82 62", light: true },
  { id: "sage", label: "Sage", bg: "202 214 204", panel: "225 234 226", panel2: "212 223 214", border: "128 148 132", text: "22 38 28", dim: "62 84 68", light: true },
  { id: "sky", label: "Sky", bg: "200 214 232", panel: "224 234 247", panel2: "211 223 239", border: "126 148 182", text: "18 32 56", dim: "58 78 112", light: true },
  { id: "mist", label: "Mist", bg: "36 50 71", panel: "58 77 106", panel2: "46 62 87", border: "118 139 174", text: "245 248 252", dim: "212 221 235" },
  { id: "dusk", label: "Dusk", bg: "24 33 47", panel: "42 55 76", panel2: "31 42 60", border: "92 110 140", text: "240 245 250", dim: "190 202 220" },
  { id: "wine", label: "Wine", bg: "44 22 32", panel: "70 40 54", panel2: "56 31 43", border: "130 84 102", text: "248 238 242", dim: "214 190 200" },
  { id: "olive", label: "Olive", bg: "36 40 22", panel: "58 64 36", panel2: "46 51 29", border: "112 122 76", text: "246 248 238", dim: "206 214 184" },
  { id: "coffee", label: "Coffee", bg: "40 30 24", panel: "64 50 40", panel2: "52 40 32", border: "126 104 86", text: "250 244 238", dim: "214 200 186" },
  { id: "ocean", label: "Ocean", bg: "12 38 48", panel: "24 62 78", panel2: "17 49 62", border: "66 118 138", text: "238 248 252", dim: "184 214 226" },
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
  root.setProperty("--term-on-accent", a.dark ? "12 17 26" : "255 255 255");
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
