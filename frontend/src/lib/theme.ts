/** Terminal appearance — accent colour + dark background preset.
 *  Values are space-separated RGB channels (for Tailwind's `/opacity`).
 *  Persisted in localStorage; applied to :root as --term-* variables. */

export type Accent = "blue" | "teal" | "amber" | "violet" | "green";
export type Ground = "charcoal" | "black" | "slate";

export const ACCENTS: { id: Accent; label: string; rgb: string }[] = [
  { id: "blue", label: "Blue", rgb: "59 130 246" },
  { id: "teal", label: "Teal", rgb: "20 184 166" },
  { id: "violet", label: "Violet", rgb: "139 92 246" },
  { id: "amber", label: "Amber", rgb: "245 158 11" },
  { id: "green", label: "Green", rgb: "34 197 94" },
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
];

const A_KEY = "gt.accent";
const G_KEY = "gt.ground";

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
