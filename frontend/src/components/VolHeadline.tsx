import type { ReactNode } from "react";
import { nf } from "../lib/format";
import type { VolatilityData } from "../types";
import { barMax, barPct, EVEN_ZONE, ivBasis, rangeBar, skewRead, verdictOf, type Skew } from "../lib/volTiles";

/** The Vol tab's headline panel: the spot and front expiry on top, then three readings that each draw what they say --
 *  implied vs realized as two bars on one scale, the skew as a tilt gauge, the expected range as a band around spot. */

const IV = "#38bdf8";
const RV = "#f59e0b";
const PUTS = "#f87171";
const CALLS = "#4ade80";
const EVEN = "#94a3b8";

const pctFmt = (v: number) => `${nf(v, 1)}%`;
const signed = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${nf(v, d)}`;

export const VERDICT_STYLE = {
  expensive: { word: "EXPENSIVE", cls: "border-amber-500/50 bg-amber-500/15 text-amber-300" },
  cheap: { word: "CHEAP", cls: "border-emerald-500/50 bg-emerald-500/15 text-emerald-300" },
  fair: { word: "FAIR", cls: "border-term-border bg-term-bg text-term-text" },
} as const;

function Block({ title, className = "", children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <div className={`min-w-0 bg-term-panel px-3 py-3 ${className}`}>
      <h3 className="mb-2.5 text-[10px] font-bold uppercase tracking-wide text-term-dim">{title}</h3>
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-snug text-term-dim">{children}</p>;
}

/** label on the left, the number on the right, and a bar under both; `tick` marks a second figure on the same scale */
function BarRow({
  label,
  title,
  value,
  max,
  color,
  tick,
  tickTitle,
  sub,
  warn,
}: {
  label: string;
  title?: string;
  value: number | null;
  max: number;
  color: string;
  tick?: number | null;
  tickTitle?: string;
  sub?: ReactNode;
  warn?: boolean;
}) {
  return (
    <div title={title}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-[11px] text-term-dim">{label}</span>
        <span className="num text-lg font-semibold leading-none text-term-text">{value != null ? pctFmt(value) : "–"}</span>
      </div>
      <div className="relative mt-1.5 h-2 rounded-full bg-term-border/50">
        {value != null && <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${barPct(value, max)}%`, background: color }} />}
        {tick != null && (
          <div className="absolute -inset-y-[3px] w-0.5 rounded bg-term-text" style={{ left: `${barPct(tick, max)}%` }} title={tickTitle} />
        )}
      </div>
      {sub && <div className={`mt-1 text-[10px] leading-snug ${warn ? "text-amber-400" : "text-term-dim"}`}>{sub}</div>}
    </div>
  );
}

const SIDE_COLOR = { puts: PUTS, calls: CALLS, even: EVEN } as const;

/** A tilt gauge: the centre is "puts and calls cost the same"; the fill runs from there to the marker. */
function SkewGauge({ skew }: { skew: Skew }) {
  const color = SIDE_COLOR[skew.side];
  return (
    <div className="relative mt-2 h-2 rounded-full bg-term-border/80">
      <div className="absolute inset-y-0 bg-term-dim/30" style={{ left: `${EVEN_ZONE[0]}%`, width: `${EVEN_ZONE[1] - EVEN_ZONE[0]}%` }} title="About even" />
      <div className="absolute inset-y-0 rounded-full" style={{ left: `${Math.min(50, skew.pos)}%`, width: `${Math.abs(skew.pos - 50)}%`, background: color, opacity: 0.85 }} />
      <div className="absolute -inset-y-[3px] left-1/2 w-px bg-term-dim/70" />
      <div
        className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-term-panel"
        style={{ left: `${skew.pos}%`, background: color }}
      />
    </div>
  );
}

export function VolHeadline({ data }: { data: VolatilityData }) {
  const front = data.term.find((t) => t.atmIV != null) ?? data.term[0];
  const rv = data.rv;
  const rv20 = rv?.available ? rv.rv20 ?? null : null;
  const today = rv?.today?.rv ?? null;
  const basis = ivBasis(data);
  const max = barMax(data.iv30, rv20, today);
  const vrp = data.vrp;
  const tone = vrp ? data.summary?.verdict ?? verdictOf(vrp.ratio) : null;
  const skew = skewRead(front?.rr25, front?.atmIV);
  const range = rangeBar(data.spot, front?.sigmaMovePct);

  return (
    <section className="mx-3 mt-3 shrink-0 overflow-hidden rounded-lg border border-term-border">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-px bg-term-border/70 min-[560px]:grid-cols-2 min-[901px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
        {/* who and when */}
        <div className="col-span-full flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 bg-term-panel px-3 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-term-dim">{data.symbol}</span>
            <span className="num text-xl font-semibold leading-none text-term-text">{nf(data.spot, 1)}</span>
          </div>
          {front && (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[11px] text-term-dim" title="The nearest expiry: the ATM IV, skew and range below are read from it">
              <span>
                Front expiry <span className="num text-term-text">{front.expiry}</span> · {nf(front.dte, 0)}d
              </span>
              {front.atmIV != null && (
                <span>
                  ATM IV <span className="num font-semibold text-term-text">{pctFmt(front.atmIV)}</span>
                </span>
              )}
            </div>
          )}
        </div>

        {/* implied vs realized */}
        <Block title="Implied vs realized" className="min-[560px]:col-span-2 min-[901px]:col-span-1">
          <div className="space-y-3">
            <BarRow
              label={basis.label}
              title="ATM IV interpolated to a 30-day horizon (in total variance) across the expiries below"
              value={data.iv30}
              max={max}
              color={IV}
              sub={basis.note}
              warn={basis.warn}
            />
            <BarRow
              label="20-day realized"
              title="Close-to-close realized volatility over the last 20 trading days, annualized"
              value={rv20}
              max={max}
              color={RV}
              tick={today}
              tickTitle={today != null ? `Today ${pctFmt(today)} (5-minute bars)` : undefined}
              sub={
                today != null ? (
                  <>
                    <span className="mr-1 inline-block h-2.5 w-0.5 rounded bg-term-text align-middle" />
                    today {pctFmt(today)} (5m)
                  </>
                ) : rv?.available ? null : (
                  "not available yet"
                )
              }
            />
          </div>
          {vrp && tone && (
            <div
              className={`mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md border px-2.5 py-1.5 ${VERDICT_STYLE[tone].cls}`}
              title="IV divided by realized, and the gap between them: the premium options carry over recent movement"
            >
              <span className="num text-base font-bold leading-none">×{nf(vrp.ratio, 2)}</span>
              <span className="text-[11px]">implied over realized</span>
              <span className="num ml-auto text-[11px] font-semibold">{signed(vrp.spread)} pts</span>
            </div>
          )}
        </Block>

        {/* skew */}
        <Block title="Skew">
          {skew && front?.rr25 != null ? (
            <div title="25-delta call IV minus 25-delta put IV for the front expiry. Negative = downside protection costs more">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[11px] text-term-dim">25Δ risk reversal</span>
                <span className="num text-lg font-semibold leading-none text-term-text">{signed(front.rr25)}</span>
              </div>
              <SkewGauge skew={skew} />
              <div className="mt-1 flex justify-between text-[10px] text-term-dim">
                <span>◄ puts bid</span>
                <span>calls bid ►</span>
              </div>
              <p className="mt-2 text-[11px] leading-snug text-term-text">{skew.word}</p>
            </div>
          ) : (
            <Empty>Not enough option prices to read the skew.</Empty>
          )}
        </Block>

        {/* expected range */}
        <Block title="Expected range">
          {range && front ? (
            <div title="One standard deviation move implied by the front expiry's ATM IV">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-[11px] text-term-dim">
                  To {front.expiry} · {nf(front.dte, 0)}d
                </span>
                <span className="num text-lg font-semibold leading-none text-term-text">±{nf(range.pct, 2)}%</span>
              </div>
              <div className="relative mt-2 h-2 rounded-full" style={{ background: `${IV}59` }}>
                <div className="absolute -inset-y-[3px] left-1/2 w-0.5 -translate-x-1/2 rounded bg-term-text" title={`Spot ${nf(data.spot, 1)}`} />
              </div>
              <div className="num mt-1 flex justify-between text-[11px] text-term-text">
                <span>{nf(range.lo, 0)}</span>
                <span>{nf(range.hi, 0)}</span>
              </div>
              <p className="mt-2 text-[11px] leading-snug text-term-dim">Price stays inside this about two times out of three.</p>
            </div>
          ) : (
            <Empty>No expiry with a usable IV to work the range from.</Empty>
          )}
        </Block>
      </div>
    </section>
  );
}
