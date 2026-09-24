import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { compact, lakhs, nf, sk } from "../lib/format";
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

const Stat = ({ label, value, cls = "text-term-text" }: { label: string; value: ReactNode; cls?: string }) => (
  <div className="min-w-0">
    <div className="text-[10px] uppercase tracking-wide text-term-dim">{label}</div>
    <div className={`truncate text-[14px] font-semibold tabular-nums ${cls}`}>{value}</div>
  </div>
);

/** a small line over the day, with its first and last values marked */
function Spark({ pts, fmt }: { pts: { t: number; v: number }[]; fmt: (v: number) => string }) {
  if (pts.length < 2) return <div className="text-[11px] text-term-dim">collecting…</div>;
  const W = 300;
  const H = 54;
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const x = (t: number) => 2 + ((t - t0) / (t1 - t0 || 1)) * (W - 4);
  const y = (v: number) => 4 + (1 - (v - lo) / (hi - lo || 1)) * (H - 8);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const up = pts[pts.length - 1].v >= pts[0].v;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-[54px] w-full" preserveAspectRatio="none">
        <path d={d} fill="none" stroke={up ? "#22c55e" : "#ef4444"} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[10px] tabular-nums text-term-dim">
        <span>
          {istTime(t0)} · {fmt(pts[0].v)}
        </span>
        <span>
          {istTime(t1)} · <span className={up ? "text-up" : "text-down"}>{fmt(pts[pts.length - 1].v)}</span>
        </span>
      </div>
    </div>
  );
}

export function HomeDashboard() {
  const symbol = useStore((s) => s.symbol);
  const chain = useStore((s) => s.chain);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const trend = useTrend(symbol);

  const [flows, setFlows] = useState<Record<string, FlowData | null>>({});
  const [hist, setHist] = useState<{ t: number; pcr: number | null; ceOI: number; peOI: number; spot: number }[]>([]);
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
        const [it, isp, ipc, ice, ipe] = ["t", "spot", "pcr", "ceOI", "peOI"].map(at);
        setHist(
          d.points
            .filter((p) => p[it] != null && p[ice] != null && p[ipe] != null)
            .map((p) => ({ t: p[it] as number, pcr: p[ipc], ceOI: p[ice] as number, peOI: p[ipe] as number, spot: (p[isp] ?? 0) as number }))
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

  // ---- trending OI: today's put vs call OI build, from the history ring ----
  const trending = useMemo(() => {
    const day = hist;
    if (day.length < 2) return null;
    const a = day[0];
    const b = day[day.length - 1];
    const dCE = b.ceOI - a.ceOI;
    const dPE = b.peOI - a.peOI;
    const pcrPts = day.filter((p) => p.pcr != null).map((p) => ({ t: p.t, v: p.pcr as number }));
    const tone: Tone = dPE > dCE * 1.15 && dPE > 0 ? "up" : dCE > dPE * 1.15 && dCE > 0 ? "down" : "flat";
    return { dCE, dPE, pcrPts, tone, since: a.t };
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
              <table className="w-full text-[12px] tabular-nums">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-term-dim">
                    <th className="py-0.5 text-left font-medium">Timeframe</th>
                    <th className="py-0.5 text-center font-medium">EMA 9/21</th>
                    <th className="py-0.5 text-center font-medium">Supertrend</th>
                  </tr>
                </thead>
                <tbody>
                  {trend.tfs.map((t) => (
                    <tr key={t.label} className="border-t border-term-border/40">
                      <td className="py-1 text-term-text">{t.label}</td>
                      <td className={`py-1 text-center text-[14px] ${dirCls(t.ema)}`}>{arrow(t.ema)}</td>
                      <td className={`py-1 text-center text-[14px] ${dirCls(t.st)}`}>{arrow(t.st)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-[11px] text-term-dim">
                {trend.up} up · {trend.down} down of {trend.total} signals. Confirms a trend once it's under way — it lags at turns.
              </div>
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
              <div className="grid grid-cols-3 gap-2">
                <Stat label="PCR" value={nf(chain.pcr, 2)} cls={(chain.pcr ?? 0) >= 1 ? "text-up" : "text-down"} />
                <Stat label="Max pain" value={sk(chain.maxPain)} />
                <Stat label="Spot" value={nf(oi.spot, 1)} />
                <Stat label="Resistance" value={sk(oi.res)} cls="text-down" />
                <Stat label="Support" value={sk(oi.floor)} cls="text-up" />
                <Stat label="Range" value={`${sk(oi.floor)}–${sk(oi.res)}`} cls="text-term-dim" />
              </div>
              <div className="flex flex-wrap gap-x-3 text-[11px] text-term-dim">
                <span>
                  Call OI today <span className={oi.ceAdd + oi.ceCut >= 0 ? "text-down" : "text-up"}>{oi.ceAdd + oi.ceCut >= 0 ? "+" : ""}{lakhs(oi.ceAdd + oi.ceCut)}</span>
                </span>
                <span>
                  Put OI today <span className={oi.peAdd + oi.peCut >= 0 ? "text-up" : "text-down"}>{oi.peAdd + oi.peCut >= 0 ? "+" : ""}{lakhs(oi.peAdd + oi.peCut)}</span>
                </span>
              </div>
              {(oi.pros.length > 0 || oi.cons.length > 0) && (
                <ul className="flex flex-col gap-0.5 text-[11px] leading-snug">
                  {oi.pros.slice(0, 2).map((p) => (
                    <li key={p} className="text-up">▲ {p}</li>
                  ))}
                  {oi.cons.slice(0, 2).map((p) => (
                    <li key={p} className="text-down">▼ {p}</li>
                  ))}
                </ul>
              )}
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
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Call OI since open" value={`${trending.dCE >= 0 ? "+" : ""}${lakhs(trending.dCE)}`} cls={trending.dCE >= 0 ? "text-down" : "text-up"} />
                <Stat label="Put OI since open" value={`${trending.dPE >= 0 ? "+" : ""}${lakhs(trending.dPE)}`} cls={trending.dPE >= 0 ? "text-up" : "text-down"} />
              </div>
              <div className="text-[10px] uppercase tracking-wide text-term-dim">PCR through the day</div>
              <Spark pts={trending.pcrPts} fmt={(v) => nf(v, 2)} />
              <div className="text-[11px] text-term-dim">
                Puts added faster than calls = writers defending below (support). Calls faster = writers capping above.
              </div>
            </>
          ) : (
            <div className="text-[12px] text-term-dim">collecting today's OI…</div>
          )}
        </Card>

        {/* order flow */}
        <Card title="Order flow · buying vs selling" go="orderflow" right={<Chip tone={flowTone}>{flowTone === "up" ? "▲ BUYING" : flowTone === "down" ? "▼ SELLING" : "◆ MIXED"}</Chip>}>
          {flowRows.map((r) => (
            <div key={r.w} className="flex items-center gap-2 text-[12px] tabular-nums">
              <span className="w-14 shrink-0 text-term-dim">{r.label}</span>
              <div className="relative h-3 flex-1 overflow-hidden rounded bg-term-border/40">
                {r.tot > 0 && (
                  <>
                    <div className="absolute inset-y-0 left-0 bg-up/70" style={{ width: `${(r.buy / r.tot) * 100}%` }} />
                    <div className="absolute inset-y-0 right-0 bg-down/70" style={{ width: `${(r.sell / r.tot) * 100}%` }} />
                  </>
                )}
              </div>
              <span className={`w-16 shrink-0 text-right font-semibold ${r.net > 0 ? "text-up" : r.net < 0 ? "text-down" : "text-term-dim"}`}>
                {r.tot ? `${r.net > 0 ? "+" : r.net < 0 ? "−" : ""}${compact(Math.abs(r.net))}` : r.warming ? "warming" : "–"}
              </span>
            </div>
          ))}
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
              <div className="grid grid-cols-3 gap-2">
                <Stat label="ATM IV" value={atmIV != null ? `${nf(atmIV, 1)}%` : "–"} />
                <Stat label="IV 7d" value={vol.iv7 != null ? `${nf(vol.iv7, 1)}%` : "–"} />
                <Stat label="Realized" value={vol.rv?.rv10 != null ? `${nf(vol.rv.rv10, 1)}%` : "–"} />
              </div>
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
