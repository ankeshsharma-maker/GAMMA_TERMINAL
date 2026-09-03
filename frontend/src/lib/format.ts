export const nf = (n: number | null | undefined, d = 2): string =>
  n === null || n === undefined || Number.isNaN(n)
    ? "–"
    : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

export const compact = (n: number | null | undefined): string => {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  const abs = Math.abs(n);
  if (abs >= 1e7) return (n / 1e7).toFixed(2) + "Cr";
  if (abs >= 1e5) return (n / 1e5).toFixed(2) + "L";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
};

/** strike price with no thousands separators, e.g. 23900 not 23,900 */
export const sk = (n: number | null | undefined): string =>
  n === null || n === undefined || Number.isNaN(n) ? "–" : String(Math.round(n));

export const signColor = (n: number | null | undefined): string =>
  n === null || n === undefined || n === 0
    ? "text-term-dim"
    : n > 0
    ? "text-up"
    : "text-down";

export const pct = (n: number | null | undefined): string =>
  n === null || n === undefined || Number.isNaN(n) ? "–" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;

export const hhmm = (epoch?: number | null): string =>
  epoch
    ? new Date(epoch * 1000).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "–";

export const ago = (epoch?: number | null): string => {
  if (!epoch) return "–";
  const s = Math.max(0, Math.round(Date.now() / 1000 - epoch));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};
