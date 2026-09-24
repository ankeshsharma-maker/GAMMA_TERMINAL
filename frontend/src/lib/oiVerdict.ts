import { sk } from "./format";

/** Inputs for the OI read: the chain's PCR / max pain / spot, the biggest call
 *  and put OI strikes (resistance / floor) and how much call / put OI was
 *  added (+) or cut (−) over the window being read. */
export interface OIInputs {
  pcr: number | null;
  maxPain: number | null;
  spot: number;
  strikeStep: number;
  resistance: number | null;
  floor: number | null;
  ceAdd: number;
  ceCut: number;
  peAdd: number;
  peCut: number;
}

export interface OIVerdict {
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  score: number;
  pros: string[];
  cons: string[];
}

/** The OI tab's bullish / bearish score -- shared with the Home dashboard so
 *  the two can't disagree. Each rule adds or takes points; ±2 or more tips it. */
export function scoreOI(x: OIInputs): OIVerdict {
  let score = 0;
  const pros: string[] = [];
  const cons: string[] = [];
  const putBuild = x.peAdd;
  const callBuild = x.ceAdd;
  const callUnwind = -x.ceCut;
  const putUnwind = -x.peCut;

  if (x.pcr != null) {
    if (x.pcr >= 1.2) { score += 2; pros.push(`PCR ${x.pcr.toFixed(2)} (put-heavy)`); }
    else if (x.pcr <= 0.8) { score -= 2; cons.push(`PCR ${x.pcr.toFixed(2)} (call-heavy)`); }
  }
  if (putBuild > callBuild * 1.15 && putBuild > 0) {
    score += 2; pros.push("Put writing > Call writing — support building");
  } else if (callBuild > putBuild * 1.15 && callBuild > 0) {
    score -= 2; cons.push("Call writing > Put writing — resistance building");
  }
  if (callUnwind > putUnwind * 1.25 && callUnwind > 0) {
    score += 1; pros.push("Call OI unwinding — resistance easing");
  } else if (putUnwind > callUnwind * 1.25 && putUnwind > 0) {
    score -= 1; cons.push("Put OI unwinding — support easing");
  }
  if (x.maxPain) {
    if (x.spot < x.maxPain * 0.997) { score += 1; pros.push(`Spot under Max Pain ${sk(x.maxPain)}`); }
    else if (x.spot > x.maxPain * 1.003) { score -= 1; cons.push(`Spot over Max Pain ${sk(x.maxPain)}`); }
  }
  if (x.floor && x.resistance) {
    const room = (x.resistance - x.spot) - (x.spot - x.floor);
    if (room > (x.strikeStep || 50)) { score += 1; pros.push(`More room to the wall (${sk(x.resistance)}) than the floor (${sk(x.floor)})`); }
    else if (room < -(x.strikeStep || 50)) { score -= 1; cons.push(`Closer to the wall (${sk(x.resistance)}) than the floor (${sk(x.floor)})`); }
  }
  const bias = score >= 2 ? "BULLISH" : score <= -2 ? "BEARISH" : "NEUTRAL";
  return { bias, score, pros, cons };
}
