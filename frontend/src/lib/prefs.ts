/** Small localStorage-backed user preferences (defaults surfaced in Settings). */

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

/* ---- trading defaults ---- */
export const getDefaultLots = () => {
  const n = parseInt(read("gt.defaultLots") || "1", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(999, n) : 1;
};
export const setDefaultLots = (n: number) =>
  write("gt.defaultLots", String(Math.max(1, Math.min(999, Math.round(n) || 1))));

export type Product = "NRML" | "MIS";
export const getDefaultProduct = (): Product =>
  read("gt.defaultProduct") === "MIS" ? "MIS" : "NRML";
export const setDefaultProduct = (p: Product) => write("gt.defaultProduct", p);

/* ---- chart defaults ---- */
export type DataSrc = "auto" | "broker" | "upstox";
export const getDataSrc = (): DataSrc => {
  const v = read("gt.dataSrc");
  return v === "broker" || v === "upstox" ? v : "auto";
};
export const setDataSrc = (v: DataSrc) => write("gt.dataSrc", v);

export const getIntervalS = () => {
  const n = parseInt(read("gt.intervalS") || "300", 10);
  return Number.isFinite(n) && n > 0 ? n : 300;
};
export const setIntervalS = (n: number) => write("gt.intervalS", String(n));

/* ---- security ---- */
/** auto-lock delay in minutes; 0 = never */
export const getAutolockMin = () => {
  const n = parseInt(read("gt.autolockMin") ?? "5", 10);
  return [0, 1, 5, 15].includes(n) ? n : 5;
};
export const setAutolockMin = (n: number) => write("gt.autolockMin", String(n));
