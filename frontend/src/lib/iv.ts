// ATM-IV regime helper — where does the current IV sit within the session's
// own IV range (a lightweight IV-rank / IV-percentile).

export type IvRegime = {
  label: "LOW" | "NORMAL" | "ELEVATED" | "HIGH";
  pctile: number | null; // 0..100 within the provided window
  cls: string; // tailwind text colour
  hint: string;
};

/** IV percentile of `cur` within `series` (e.g. session ATM-IV snapshots). */
export function ivRegime(series: (number | null | undefined)[], cur: number | null | undefined): IvRegime {
  const vals = series.filter((v): v is number => typeof v === "number" && isFinite(v) && v > 0);
  if (cur == null || !isFinite(cur) || vals.length < 5) {
    return { label: "NORMAL", pctile: null, cls: "text-term-dim", hint: "collecting IV history…" };
  }
  const below = vals.filter((v) => v <= cur).length;
  const pctile = Math.round((below / vals.length) * 100);
  if (pctile >= 80)
    return {
      label: "HIGH",
      pctile,
      cls: "text-down",
      hint: "IV rich — favours selling premium / credit spreads",
    };
  if (pctile >= 60)
    return {
      label: "ELEVATED",
      pctile,
      cls: "text-amber-400",
      hint: "IV a bit rich — lean to selling premium",
    };
  if (pctile <= 20)
    return {
      label: "LOW",
      pctile,
      cls: "text-up",
      hint: "IV cheap — favours buying premium / debit spreads",
    };
  return { label: "NORMAL", pctile, cls: "text-term-text", hint: "no clear IV edge either way" };
}

/** Does a strategy's net vega sit the right way for the current IV regime? */
export function ivFit(regime: IvRegime, netVega: number): { txt: string; cls: string } {
  const high = regime.label === "HIGH" || regime.label === "ELEVATED";
  const low = regime.label === "LOW";
  if (Math.abs(netVega) < 1) return { txt: "vega-neutral", cls: "text-term-dim" };
  if (high && netVega < 0) return { txt: "aligned — short vega into high IV", cls: "text-up" };
  if (low && netVega > 0) return { txt: "aligned — long vega into low IV", cls: "text-up" };
  if (high && netVega > 0) return { txt: "caution — long vega into high IV", cls: "text-down" };
  if (low && netVega < 0) return { txt: "caution — short vega into low IV", cls: "text-down" };
  return { txt: "IV-neutral setup", cls: "text-term-dim" };
}
