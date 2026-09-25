import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { compact, oiCr, nf, sk } from "../lib/format";
import { istTime } from "../lib/istTime";
import { scoreOI } from "../lib/oiVerdict";
import { useTrend, type Dir, type Overall } from "./TrendCompass";
import type { FlowData, VolatilityData, View } from "../types";

/** Home: one screen that answers "which way, and how sure" for the symbol on
 *  screen -- price-action trend, OI summary, trending OI, order flow and
 *  volatility, each read from the same data (and the same rules) as its own
 *  tab, with a market-read strip on top. Tap a card to open its tab. */

type Tone = "up" | "down" | "flat";
const TONE: Record<Tone, string> = {
  up: "bg-up/15 text-up border-up/40",
  down: "bg-down/15 text-down border-down/40",
  flat: "bg-term-border/40 text-term-dim border-term-border",
};
const QUICK = ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY"];

const OVERALL: Record<Overall, { word: string; tone: Tone }> = {
  "strong-up": { word: "▲▲ STRONG UP", tone: "up" },
  up: { word: "▲ UP", tone: "up" },
  mixed: { word: "◆ MIXED", tone: "flat" },
  down: { word: "▼ DOWN", tone: "down" },
  "strong-down": { word: "▼▼ STRONG DOWN", tone: "down" },
};
const arrow = (d: Dir | null) => (d === "up" ? "▲" : d === "down" ? "▼" : d === "mixed" ? "◆" : "·");
const dirCls = (d: Dir | null) => (d === "up" ? "text-up" : d === "down" ? "text-down" : "text-term-dim");

function Card({
  title,
  go,
  children,
  right,
}: {
  title: string;
  go?: View;
  children: ReactNode;
  right?: ReactNode;
}) {
  const setView = useStore((s) => s.setView);
  return (
    <section className="flex min-w-0 flex-col rounded-lg border border-term-border bg-term-panel">
      <header className="flex items-center justify-between gap-2 border-b border-term-border/60 px-3 py-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-term-dim">{title}</span>
        <span className="flex items-center gap-2">
          {right}
          {go && (
            <button onClick={() => setView(go)} className="text-[11px] text-term-accent hover:underline">
              Open ›
            </button>
          )}
        </span>
      </header>
      <div className="flex flex-col gap-2 px-3 py-2.5">{children}</div>
    </section>
  );
}

const Chip = ({ tone, children }: { tone: Tone; children: ReactNode }) => (
  <span className={`whitespace-nowrap rounded border px-2 py-0.5 text-[11px] font-bold ${TONE[tone]}`}>{children}</span>
);

// every card is a table with ALL borders (a grid, like Excel's "All Borders"):
// one visible line around every cell, the header row filled, outer corners
// rounded. Cells draw their right + bottom lines, the first column its left and
// the header its top, so each line is 1px (separate borders, 0 spacing -- the
// only way rounded outer corners work on a table).
const TBL =
  "w-full border-separate border-spacing-0 text-[12px] tabular-nums [&_tr>*:first-child]:border-l " +
  "[&_thead_tr>*:first-child]:rounded-tl-lg [&_thead_tr>*:last-child]:rounded-tr-lg " +
  "[&_tbody_tr:last-child>*:first-child]:rounded-bl-lg [&_tbody_tr:last-child>*:last-child]:rounded-br-lg";
const TH =
  "border-b border-r border-t border-term-dim/50 bg-term-border/70 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-term-dim";
const TR = "";
const TD = "border-b border-r border-term-dim/50 px-2 py-1";
// a totals row: filled + bold
const TOT = "font-semibold [&>td]:bg-term-border/50";
const L = (v: number | null | undefined) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${oiCr(Math.abs(v))}`);
const pct = (v: number | null | undefined) => (v == null ? "–" : `${nf(v, 1)}%`);
const tone3 = (v: number | null | undefined, pos: string, neg: string) =>
  v == null || v === 0 ? "text-term-dim" : v > 0 ? pos : neg;
// IST minute-of-day / day number of an epoch second
const istMin = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const istDay = (t: number) => Math.floor((t + 19800) / 86400);

export function HomeDashboard() {
  const symbol = useStore((s) => s.symbol);
  const chain = useStore((s) => s.chain);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const trend = useTrend(symbol);

  const [flows, setFlows] = useState<Record<string, FlowData | null>>({});
  const [hist, setHist] = useState<
    { t: number; pcr: number | null; ceOI: number; peOI: number; ceChg: number | null; peChg: number | null; spot: number }[]
  >([]);
  const [vol, setVol] = useState<VolatilityData | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      Promise.all(["5", "15", "60"].map((w) => api.flow(symbol, undefined, w).catch(() => null))).then(
        (rs) => alive && setFlows({ "5": rs[0], "15": rs[1], "60": rs[2] })
      );
      // the PCR series keeps the whole trading day for indices (the history
      // ring only holds the last ~3 hours), so "since open" really is
      api.pcr(symbol, null, 5).then((d) => {
        if (!alive) return;
        const at = (k: string) => d.fields.indexOf(k);
        const [it, isp, ipc, ice, ipe, icc, ipcg] = ["t", "spot", "pcr", "ceOI", "peOI", "ceOIChg", "peOIChg"].map(at);
        const num = (v: number | null | undefined) => (v == null ? null : (v as number));
        setHist(
          d.points
            .filter((p) => p[it] != null && p[ice] != null && p[ipe] != null)
            .map((p) => ({
              t: p[it] as number,
              pcr: p[ipc],
              ceOI: p[ice] as number,
              peOI: p[ipe] as number,
              ceChg: icc >= 0 ? num(p[icc]) : null,
              peChg: ipcg >= 0 ? num(p[ipcg]) : null,
              spot: (p[isp] ?? 0) as number,
            }))
        );
      }, () => {});
    };
    const loadVol = () => api.volatility(symbol).then((d) => alive && setVol(d), () => {});
    setFlows({});
    setHist([]);
    setVol(null);
    load();
    loadVol();
    const a = window.setInterval(() => !document.hidden && load(), 60_000);
    const b = window.setInterval(() => !document.hidden && loadVol(), 300_000);
    return () => {
      alive = false;
      window.clearInterval(a);
      window.clearInterval(b);
    };
  }, [symbol]);

  // ---- OI summary: the OI tab's own rules, over the whole chain, today's change ----
  const oi = useMemo(() => {
    if (!chain || chain.symbol !== symbol.toUpperCase()) return null;
    let res = { k: 0, v: -1 };
    let flo = { k: 0, v: -1 };
    let ceAdd = 0, ceCut = 0, peAdd = 0, peCut = 0;
    for (const r of chain.rows) {
      if (r.call.oi > res.v) res = { k: r.strike, v: r.call.oi };
      if (r.put.oi > flo.v) flo = { k: r.strike, v: r.put.oi };
      const c = r.call.oiChg || 0;
      const p = r.put.oiChg || 0;
      if (c >= 0) ceAdd += c; else ceCut += c;
      if (p >= 0) peAdd += p; else peCut += p;
    }
    const spot = chain.liveSpot?.ltp ?? chain.spot;
    const v = scoreOI({
      pcr: chain.pcr,
      maxPain: chain.maxPain,
      spot,
      strikeStep: chain.strikeStep || 50,
      resistance: res.k || null,
      floor: flo.k || null,
      ceAdd, ceCut, peAdd, peCut,
    });
    return { ...v, spot, res: res.k, floor: flo.k, ceAdd, ceCut, peAdd, peCut };
  }, [chain, symbol]);

  // ---- trending OI: the session in hourly rows (09:15 grid), whole chain ----
  // Row 1 is the change from yesterday's close to the first reading (the open
  // can move a lot of OI in its first minutes); every row after it is the
  // change during that hour; the total is today vs yesterday's close.
  const trending = useMemo(() => {
    if (hist.length < 2) return null;
    const lastDay = istDay(hist[hist.length - 1].t);
    // from 09:15 on -- including the after-close readings, where the day's final OI lands
    let pts = hist.filter((p) => istDay(p.t) === lastDay && istMin(p.t) >= 555);
    if (pts.length < 2) pts = hist.filter((p) => istDay(p.t) === lastDay);
    if (pts.length < 2) pts = hist;
    const picks = [pts[0]];
    for (const edge of [615, 675, 735, 795, 855, 915]) {
      let best: (typeof pts)[number] | null = null;
      for (const p of pts) if (istMin(p.t) <= edge) best = p;
      if (best && best.t > picks[picks.length - 1].t) picks.push(best);
    }
    const last = pts[pts.length - 1];
    if (last.t > picks[picks.length - 1].t) picks.push(last);
    const rows = picks.map((p, i) => ({
      t: p.t,
      spot: p.spot,
      pcr: p.pcr,
      dCE: i ? p.ceOI - picks[i - 1].ceOI : p.ceChg,
      dPE: i ? p.peOI - picks[i - 1].peOI : p.peChg,
    }));
    const dCE = last.ceChg ?? last.ceOI - pts[0].ceOI;
    const dPE = last.peChg ?? last.peOI - pts[0].peOI;
    const tone: Tone = dPE > dCE * 1.15 && dPE > 0 ? "up" : dCE > dPE * 1.15 && dCE > 0 ? "down" : "flat";
    return { rows, dCE, dPE, pcr: last.pcr, tone, vsClose: last.ceChg != null };
  }, [hist]);

  // ---- order flow: net buying − selling per window ----
  const flowRows = ["5", "15", "60"].map((w) => {
    const f = flows[w];
    const buy = f ? f.bull : 0;
    const sell = f ? f.bear : 0;
    const tot = buy + sell;
    const tone: Tone = !tot ? "flat" : buy / tot >= 0.55 ? "up" : buy / tot <= 0.45 ? "down" : "flat";
    return { w, label: w === "60" ? "1 hour" : `${w} min`, buy, sell, net: buy - sell, tot, tone, warming: f?.warming, closed: f?.closed };
  });
  const flow15 = flows["15"];
  const flowTone: Tone = flow15?.state?.dir === "bull" ? "up" : flow15?.state?.dir === "bear" ? "down" : flowRows[1].tone;

  // ---- vol ----
  const vs = vol?.summary;
  const volTone: Tone = vs?.verdict === "cheap" ? "up" : vs?.verdict === "expensive" ? "down" : "flat";
  const atmIV = vol?.term?.[0]?.atmIV ?? chain?.atmIV ?? null;

  // ---- market read: do the direction signals agree? ----
  const reads: { name: string; tone: Tone; word: string }[] = [
    trend
      ? { name: "Price action", tone: OVERALL[trend.overall].tone, word: OVERALL[trend.overall].word }
      : { name: "Price action", tone: "flat", word: "…" },
    oi ? { name: "OI", tone: oi.bias === "BULLISH" ? "up" : oi.bias === "BEARISH" ? "down" : "flat", word: oi.bias } : { name: "OI", tone: "flat", word: "…" },
    trending
      ? { name: "Trending OI", tone: trending.tone, word: trending.tone === "up" ? "▲ PUTS BUILDING" : trending.tone === "down" ? "▼ CALLS BUILDING" : "◆ EVEN" }
      : { name: "Trending OI", tone: "flat", word: "…" },
    { name: "Order flow", tone: flowTone, word: flowTone === "up" ? "▲ BUYING" : flowTone === "down" ? "▼ SELLING" : "◆ MIXED" },
  ];
  const ups = reads.filter((r) => r.tone === "up").length;
  const downs = reads.filter((r) => r.tone === "down").length;
  const agree: { tone: Tone; text: string } =
    downs >= 3 && ups === 0
      ? { tone: "down", text: `${downs} of 4 point DOWN — signals agree` }
      : ups >= 3 && downs === 0
      ? { tone: "up", text: `${ups} of 4 point UP — signals agree` }
      : { tone: "flat", text: `${ups} up · ${downs} down — signals disagree, no clear direction` };
  const spot = chain?.liveSpot?.ltp ?? chain?.spot ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-term-bg">
      {/* symbol + market read */}
      <div className="border-b border-term-border bg-term-panel px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[16px] font-bold text-term-text">{symbol}</span>
          {spot != null && <span className="text-[15px] font-semibold tabular-nums text-term-text">{nf(spot, 2)}</span>}
          <div className="seg ml-auto text-[11px]">
            {[...new Set([...QUICK, symbol])].map((s) => (
              <button key={s} onClick={() => selectSymbol(s, true)} className={s === symbol ? "on" : ""}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {reads.map((r) => (
            <div key={r.name} className={`rounded border px-2 py-1.5 ${TONE[r.tone]}`}>
              <div className="text-[10px] font-medium uppercase tracking-wide opacity-80">{r.name}</div>
              <div className="truncate text-[12px] font-bold">{r.word}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
          <Chip tone={agree.tone}>{agree.tone === "up" ? "▲" : agree.tone === "down" ? "▼" : "◆"} MARKET READ</Chip>
          <span className="text-term-text">{agree.text}</span>
          {vs?.verdict && (
            <span className="text-term-dim">
              · options {vs.verdict}
              {vs.lean && vs.lean !== "none" ? ` (lean ${vs.lean})` : ""}
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
        {/* price action */}
        <Card title="Trend direction · price action" go="chart" right={trend && <Chip tone={OVERALL[trend.overall].tone}>{OVERALL[trend.overall].word}</Chip>}>
          {trend ? (
            <>
              <table className={TBL}>
                <thead>
                  <tr>
                    <th className={`${TH} text-left`}>TF</th>
                    <th className={`${TH} text-center`} title="EMA 9 / 21">EMA</th>
                    <th className={`${TH} text-center`}>Supertrend</th>
                    <th className={`${TH} text-center`}>Structure</th>
                    <th className={`${TH} text-center`} title="ADX(14): +DI vs -DI; under 20 = no trend">ADX</th>
                  </tr>
                </thead>
                <tbody>
                  {trend.tfs.map((t) => (
                    <tr key={t.label} className={TR}>
                      <td className={`${TD} text-term-text`}>{t.label}</td>
                      <td className={`${TD} text-center text-[14px] ${dirCls(t.ema)}`}>{arrow(t.ema)}</td>
                      <td className={`${TD} text-center text-[14px] ${dirCls(t.st)}`}>{arrow(t.st)}</td>
                      <td
                        className={`${TD} text-center font-semibold ${dirCls(t.pa?.dir ?? null)}`}
                        title={t.pa ? `${t.pa.hi} · ${t.pa.lo}${t.pa.broke ? ` · price ${t.pa.broke === "up" ? "above the last swing high" : "below the last swing low"}` : ""}` : undefined}
                      >
                        {t.pa ? `${arrow(t.pa.dir)} ${t.pa.dir === "up" ? "UP" : t.pa.dir === "down" ? "DOWN" : "MIXED"}` : "–"}
                      </td>
                      <td
                        className={`${TD} text-center font-semibold ${dirCls(t.adx?.dir ?? null)}`}
                        title={t.adx ? `ADX ${nf(t.adx.adx, 1)} · +DI ${nf(t.adx.pdi, 1)} · −DI ${nf(t.adx.mdi, 1)} (under 20 = no trend)` : undefined}
                      >
                        {t.adx ? `${arrow(t.adx.dir)} ${nf(t.adx.adx, 0)}` : "–"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {trend.tfs.some((t) => t.pa) && (
                <table className={TBL}>
                  <thead>
                    <tr>
                      <th className={`${TH} text-left`}>Swings</th>
                      <th className={`${TH} text-right`}>Last high</th>
                      <th className={`${TH} text-right`}>Last low</th>
                      <th className={`${TH} text-right`}>Price now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trend.tfs.map((t) => (
                      <tr key={t.label} className={TR}>
                        <td className={`${TD} text-term-text`}>{t.label}</td>
                        <td className={`${TD} text-right text-term-text`}>{t.pa ? nf(t.pa.lastHigh, 0) : "–"}</td>
                        <td className={`${TD} text-right text-term-text`}>{t.pa ? nf(t.pa.lastLow, 0) : "–"}</td>
                        <td
                          className={`${TD} text-right ${
                            t.pa?.broke === "up" ? "text-up" : t.pa?.broke === "down" ? "text-down" : "text-term-dim"
                          }`}
                        >
                          {!t.pa ? "–" : t.pa.broke === "up" ? "▲ above high" : t.pa.broke === "down" ? "▼ below low" : "between"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : (
            <div className="text-[12px] text-term-dim">reading candles…</div>
          )}
        </Card>

        {/* OI summary */}
        <Card
          title="OI summary"
          go="scrip"
          right={oi && <Chip tone={oi.bias === "BULLISH" ? "up" : oi.bias === "BEARISH" ? "down" : "flat"}>{oi.bias}</Chip>}
        >
          {oi && chain ? (
            <>
              <table className={TBL}>
                <thead>
                  <tr>
                    <th className={`${TH} text-left`}>PCR</th>
                    <th className={`${TH} text-right`}>Max pain</th>
                    <th className={`${TH} text-right`}>Spot</th>
                    <th className={`${TH} text-right`}>Range</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className={TR}>
                    <td className={`${TD} font-semibold ${(chain.pcr ?? 0) >= 1 ? "text-up" : "text-down"}`}>{nf(chain.pcr, 2)}</td>
                    <td className={`${TD} text-right text-term-text`}>{sk(chain.maxPain)}</td>
                    <td className={`${TD} text-right text-term-text`}>{nf(oi.spot, 1)}</td>
                    <td className={`${TD} text-right text-term-text`}>
                      {sk(oi.floor)}–{sk(oi.res)}
                    </td>
                  </tr>
                </tbody>
              </table>
              <table className={TBL}>
                <thead>
                  <tr>
                    <th className={`${TH} text-left`}>Today</th>
                    <th className={`${TH} text-right`}>Calls</th>
                    <th className={`${TH} text-right`}>Puts</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className={TR}>
                    <td className={`${TD} text-term-dim`}>Wall (most OI)</td>
                    <td className={`${TD} text-right font-semibold text-down`}>{sk(oi.res)} R</td>
                    <td className={`${TD} text-right font-semibold text-up`}>{sk(oi.floor)} S</td>
                  </tr>
                  <tr className={TR}>
                    <td className={`${TD} text-term-dim`}>OI added</td>
                    <td className={`${TD} text-right text-term-text`}>{L(oi.ceAdd)}</td>
                    <td className={`${TD} text-right text-term-text`}>{L(oi.peAdd)}</td>
                  </tr>
                  <tr className={TR}>
                    <td className={`${TD} text-term-dim`}>OI cut</td>
                    <td className={`${TD} text-right text-term-text`}>{L(oi.ceCut)}</td>
                    <td className={`${TD} text-right text-term-text`}>{L(oi.peCut)}</td>
                  </tr>
                </tbody>
              </table>
              {(oi.pros.length > 0 || oi.cons.length > 0) && (
                <table className={TBL}>
                  <thead>
                    <tr>
                      <th className={`${TH} w-5 text-left`} />
                      <th className={`${TH} text-left`}>What the OI says</th>
                    </tr>
                  </thead>
                  <tbody>
                    {oi.pros.slice(0, 2).map((p) => (
                      <tr key={p} className={TR}>
                        <td className={`${TD} align-top text-up`}>▲</td>
                        <td className={`${TD} leading-snug text-term-text`}>{p}</td>
                      </tr>
                    ))}
                    {oi.cons.slice(0, 2).map((p) => (
                      <tr key={p} className={TR}>
                        <td className={`${TD} align-top text-down`}>▼</td>
                        <td className={`${TD} leading-snug text-term-text`}>{p}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="text-[10px] text-term-dim">Strikes on the chain, vs yesterday's close.</div>
            </>
          ) : (
            <div className="text-[12px] text-term-dim">loading the chain…</div>
          )}
        </Card>

        {/* trending OI */}
        <Card
          title="Trending OI · today"
          go="trendingoi"
          right={trending && <Chip tone={trending.tone}>{trending.tone === "up" ? "PUTS BUILDING" : trending.tone === "down" ? "CALLS BUILDING" : "EVEN"}</Chip>}
        >
          {trending ? (
            <>
              <table className={TBL}>
                <thead>
                  <tr>
                    <th className={`${TH} text-left`}>Time</th>
                    <th className={`${TH} text-right`}>Spot</th>
                    <th className={`${TH} text-right`}>Call OI</th>
                    <th className={`${TH} text-right`}>Put OI</th>
                    <th className={`${TH} text-right`}>PCR</th>
                  </tr>
                </thead>
                <tbody>
                  {trending.rows.map((r, i) => (
                    <tr key={r.t} className={TR}>
                      <td className={`${TD} text-term-dim`}>
                        {i === 0 && trending.vsClose ? `${istTime(r.t)}*` : istMin(r.t) > 930 ? "Close" : istTime(r.t)}
                      </td>
                      <td className={`${TD} text-right text-term-text`}>{r.spot ? nf(r.spot, 0) : "–"}</td>
                      <td className={`${TD} text-right ${tone3(r.dCE, "text-down", "text-up")}`}>{L(r.dCE)}</td>
                      <td className={`${TD} text-right ${tone3(r.dPE, "text-up", "text-down")}`}>{L(r.dPE)}</td>
                      <td className={`${TD} text-right text-term-text`}>{r.pcr != null ? nf(r.pcr, 2) : "–"}</td>
                    </tr>
                  ))}
                  <tr className={TOT}>
                    <td className={`${TD} text-term-text`}>Today</td>
                    <td className={TD} />
                    <td className={`${TD} text-right ${tone3(trending.dCE, "text-down", "text-up")}`}>{L(trending.dCE)}</td>
                    <td className={`${TD} text-right ${tone3(trending.dPE, "text-up", "text-down")}`}>{L(trending.dPE)}</td>
                    <td className={`${TD} text-right text-term-text`}>{trending.pcr != null ? nf(trending.pcr, 2) : "–"}</td>
                  </tr>
                </tbody>
              </table>
              <div className="text-[10px] leading-snug text-term-dim">
                {trending.vsClose ? "* change from yesterday's close to the first reading; each row after = change in that hour. " : ""}
                Puts added faster than calls = writers defending below (support). Calls faster = writers capping above.
              </div>
            </>
          ) : (
            <div className="text-[12px] text-term-dim">collecting today's OI…</div>
          )}
        </Card>

        {/* order flow */}
        <Card title="Order flow · buying vs selling" go="orderflow" right={<Chip tone={flowTone}>{flowTone === "up" ? "▲ BUYING" : flowTone === "down" ? "▼ SELLING" : "◆ MIXED"}</Chip>}>
          <table className={TBL}>
            <thead>
              <tr>
                <th className={`${TH} text-left`}>Window</th>
                <th className={`${TH} text-right`}>Buying</th>
                <th className={`${TH} text-right`}>Selling</th>
                <th className={`${TH} text-right`}>Net</th>
                <th className={`${TH} text-right`}>Buy %</th>
              </tr>
            </thead>
            <tbody>
              {flowRows.map((r) => (
                <tr key={r.w} className={TR}>
                  <td className={`${TD} text-term-dim`}>{r.label}</td>
                  {r.tot ? (
                    <>
                      <td className={`${TD} text-right text-up`}>{compact(r.buy)}</td>
                      <td className={`${TD} text-right text-down`}>{compact(r.sell)}</td>
                      <td className={`${TD} text-right font-semibold ${r.net > 0 ? "text-up" : r.net < 0 ? "text-down" : "text-term-dim"}`}>
                        {r.net > 0 ? "+" : r.net < 0 ? "−" : ""}
                        {compact(Math.abs(r.net))}
                      </td>
                      <td className={`${TD} text-right ${r.tone === "up" ? "text-up" : r.tone === "down" ? "text-down" : "text-term-text"}`}>
                        {Math.round((r.buy / r.tot) * 100)}%
                      </td>
                    </>
                  ) : (
                    <td colSpan={4} className={`${TD} text-right text-term-dim`}>
                      {r.closed ? "closed" : r.warming ? "warming up" : "–"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[11px] text-term-dim">
            {flow15?.closed
              ? "Market closed — tracking resumes 09:15."
              : flow15?.state?.dir
              ? `15 min flow: ${flow15.state.dir === "bull" ? "buying" : flow15.state.dir === "bear" ? "selling" : "mixed"}${flow15.state.heldMin ? ` for ${nf(flow15.state.heldMin, 0)} min` : ""}.`
              : "Green = call buying + put writing, red = call writing + put buying (contracts)."}
          </div>
        </Card>

        {/* volatility */}
        <Card title="Volatility" go="vol" right={vs?.verdict && <Chip tone={volTone}>{vs.verdict.toUpperCase()}</Chip>}>
          {vol ? (
            <>
              <table className={TBL}>
                <thead>
                  <tr>
                    <th className={`${TH} text-left`}>Horizon</th>
                    <th className={`${TH} text-right`}>Implied (IV)</th>
                    <th className={`${TH} text-right`}>Realized (RV)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className={TR}>
                    <td className={`${TD} text-term-dim`}>Front ATM{vol.term?.[0]?.expiry ? ` · ${vol.term[0].expiry.slice(0, 6)}` : ""}</td>
                    <td className={`${TD} text-right font-semibold text-term-text`}>{pct(atmIV)}</td>
                    <td className={`${TD} text-right text-term-text`}>{pct(vol.rv?.today?.rv)}</td>
                  </tr>
                  <tr className={TR}>
                    <td className={`${TD} text-term-dim`}>1 week</td>
                    <td className={`${TD} text-right text-term-text`}>{pct(vol.iv7)}</td>
                    <td className={`${TD} text-right text-term-text`}>{pct(vol.rv?.rv5)}</td>
                  </tr>
                  <tr className={TR}>
                    <td className={`${TD} text-term-dim`}>2 weeks</td>
                    <td className={`${TD} text-right text-term-dim`}>–</td>
                    <td className={`${TD} text-right text-term-text`}>{pct(vol.rv?.rv10)}</td>
                  </tr>
                  <tr className={TR}>
                    <td className={`${TD} text-term-dim`}>1 month</td>
                    <td className={`${TD} text-right text-term-text`}>{pct(vol.iv30)}</td>
                    <td className={`${TD} text-right text-term-text`}>{pct(vol.rv?.rv20)}</td>
                  </tr>
                  {vol.vrp && (
                    <tr className={TOT}>
                      <td className={`${TD} text-term-text`}>IV ÷ RV (1 month)</td>
                      <td colSpan={2} className={`${TD} text-right ${volTone === "down" ? "text-down" : volTone === "up" ? "text-up" : "text-term-text"}`}>
                        ×{nf(vol.vrp.ratio, 2)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {vs && <p className="text-[12px] leading-snug text-term-text">{vs.headline}</p>}
            </>
          ) : (
            <div className="text-[12px] text-term-dim">loading volatility…</div>
          )}
        </Card>
      </div>
    </div>
  );
}
