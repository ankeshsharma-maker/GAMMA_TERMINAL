import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { ago, nf, sk } from "../lib/format";
import type { RvCone, VolatilityData, VolExpiry, VolSummary } from "../types";
import { LineChart, niceTicks, type LineSeries } from "./LineChart";
import { SelectMenu } from "./SelectMenu";
import { ClassFilter } from "./Header";
import { VERDICT_STYLE, VolHeadline } from "./VolHeadline";

/** Volatility dashboard for the active underlying: the IV smile per expiry, the ATM
 *  term structure with skew, and implied vs realized volatility. One backend call
 *  (/api/volatility) feeds all of it; it refreshes itself every minute. */

const PALETTE = ["#38bdf8", "#f59e0b", "#a855f7", "#14b8a6", "#f472b6", "#84cc16", "#fb923c", "#22d3ee"];
const IV = "#38bdf8";

const pctFmt = (v: number) => `${nf(v, 1)}%`;
/** 1st, 2nd, 3rd, 11th, 73rd ... */
const ord = (n: number) => {
  const r = Math.round(n);
  const s = ["th", "st", "nd", "rd"];
  const v = r % 100;
  return `${r}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
const shortDate = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

function Card({
  title,
  hint,
  children,
  className = "",
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`min-w-0 rounded border border-term-border bg-term-bg/20 p-3 ${className}`}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-term-text">{title}</h3>
        {hint && <span className="text-[10px] text-term-dim">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** The whole tab in a few plain sentences: are options expensive or cheap, the range expected, what it fears. */
function SummaryCard({ s }: { s: VolSummary }) {
  const v = s.verdict ? VERDICT_STYLE[s.verdict] : null;
  return (
    <div className="mx-3 mt-3 rounded-lg border border-term-border bg-term-panel">
      <div className="flex flex-wrap items-start gap-3 px-3 py-2.5">
        <span
          className={`shrink-0 rounded-md border px-2.5 py-1 text-xs font-bold tracking-wide ${v ? v.cls : "border-term-border bg-term-bg text-term-dim"}`}
        >
          {v ? v.word : "NO READ"}
        </span>
        <p className="min-w-0 flex-1 basis-64 text-sm font-semibold leading-snug text-term-text">{s.headline}</p>
      </div>
      {s.points.length > 0 && (
        <ul className="grid gap-x-4 gap-y-1.5 border-t border-term-border/60 px-3 py-2 text-[11px] leading-snug md:grid-cols-2">
          {s.points.map((p) => (
            <li key={p.key} className={p.tone === "warn" ? "md:col-span-2" : ""}>
              <span
                className={`mr-1.5 text-[10px] font-semibold uppercase tracking-wide ${p.tone === "warn" ? "text-amber-400" : "text-term-dim"}`}
              >
                {p.title}
              </span>
              <span className={p.tone === "warn" ? "text-amber-200" : "text-term-text"}>{p.text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-term-border/60 px-3 py-1.5 text-[10px] text-term-dim">{s.note}</div>
    </div>
  );
}

/** min..max band with the middle half boxed, the current reading marked and, if given,
 *  a second marker (the implied vol being compared with it). */
function ConeBar({ cone, iv }: { cone: RvCone; iv?: number | null }) {
  const lo = Math.min(cone.min, iv ?? cone.min);
  const hi = Math.max(cone.max, iv ?? cone.max);
  const at = (v: number) => `${((v - lo) / (hi - lo || 1)) * 100}%`;
  return (
    <div className="relative h-4 w-full min-w-[120px] rounded bg-term-border/60">
      <div
        className="absolute inset-y-0.5 rounded-sm bg-term-dim/40"
        style={{ left: at(cone.p25), width: `${((cone.p75 - cone.p25) / (hi - lo || 1)) * 100}%` }}
        title={`Middle half of the past year: ${nf(cone.p25, 1)}% - ${nf(cone.p75, 1)}%`}
      />
      <div className="absolute inset-y-0 w-0.5 bg-term-text" style={{ left: at(cone.median) }} title={`Median ${nf(cone.median, 1)}%`} />
      <div className="absolute -inset-y-0.5 w-1 rounded bg-amber-400" style={{ left: at(cone.current) }} title={`Now ${nf(cone.current, 1)}%`} />
      {iv != null && (
        <div className="absolute -inset-y-0.5 w-1 rounded" style={{ left: at(iv), background: IV }} title={`30D IV ${nf(iv, 1)}%`} />
      )}
    </div>
  );
}

export function VolatilityView() {
  const symbol = useStore((s) => s.symbol);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const symClassOk = useStore((s) => s.symClassOk);
  const symClass = useStore((s) => s.symClass);

  const [symChoices, setSymChoices] = useState<string[]>([]);
  useEffect(() => {
    api.symbols().then(
      (d) => setSymChoices([...new Set([...(d.indices ?? []), ...(d.fo ?? []), ...(d.defaults ?? [])])].sort()),
      () => {}
    );
  }, []);
  const symOptions = useMemo(
    () =>
      [...new Set([...symChoices, symbol])]
        .filter(Boolean)
        .filter((s) => s === symbol || symClassOk(s))
        .sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [symChoices, symbol, symClass]
  );

  const [data, setData] = useState<VolatilityData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // how far either side of spot the smile is drawn (% of spot; 0 = every strike). The
  // near expiry's far wings run to 40%+ and would flatten every other line otherwise.
  const [width, setWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem("vol.smileWidth"));
      return [3, 5, 8, 0].includes(v) && localStorage.getItem("vol.smileWidth") != null ? v : 5;
    } catch {
      return 5;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("vol.smileWidth", String(width));
    } catch {
      /* ignore */
    }
  }, [width]);
  const lastSym = useRef("");

  useEffect(() => {
    let alive = true;
    if (lastSym.current !== symbol) {
      lastSym.current = symbol;
      setData(null);
    }
    setErr(null);
    const load = () => {
      setBusy(true);
      return api
        .volatility(symbol)
        .then((d) => {
          if (!alive) return;
          setData(d);
          setErr(null);
        })
        .catch((e) => alive && setErr(String(e?.message ?? e)))
        .finally(() => alive && setBusy(false));
    };
    load();
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 60000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [symbol, tick]);

  const colorOf = (i: number) => PALETTE[i % PALETTE.length];

  const smileSeries: LineSeries[] = useMemo(
    () =>
      (data?.expiries ?? [])
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => !hidden.has(e.expiry) && e.smile?.length)
        .map(({ e, i }) => ({
          key: e.expiry,
          label: `${e.expiry} · ${nf(e.dte, 0)}d`,
          color: colorOf(i),
          width: i === 0 ? 2.2 : 1.6,
          points: e.smile!.filter((p) => width === 0 || Math.abs(p.m) <= width).map((p) => ({ x: p.strike, y: p.iv })),
        })),
    [data, hidden, width]
  );

  const termSeries: LineSeries[] = useMemo(() => {
    const t = (data?.term ?? []).filter((r) => r.atmIV != null);
    const mk = (key: string, label: string, color: string, pick: (r: VolExpiry) => number | null, extra = {}) => ({
      key,
      label,
      color,
      points: t.flatMap((r) => {
        const y = pick(r);
        return y == null ? [] : [{ x: r.dte, y }];
      }),
      ...extra,
    });
    return [
      mk("atm", "ATM IV", IV, (r) => r.atmIV, { dots: true, width: 2.2 }),
      mk("p25", "25Δ put IV", "#f87171", (r) => r.put25, { dashed: true, dots: true, width: 1.4 }),
      mk("c25", "25Δ call IV", "#4ade80", (r) => r.call25, { dashed: true, dots: true, width: 1.4 }),
    ].filter((s) => s.points.length);
  }, [data]);

  const rv = data?.rv;
  const rvSeries: LineSeries[] = useMemo(() => {
    if (!rv?.available || !rv.series?.length) return [];
    return [
      {
        key: "rv20",
        label: "20-day realized",
        color: "#f59e0b",
        width: 2,
        points: rv.series.map((p, i) => ({ x: i, y: p.rv })),
      },
    ];
  }, [rv]);
  const rvTicks = useMemo(() => {
    const n = rv?.series?.length ?? 0;
    return n ? niceTicks(0, n - 1, 5).map(Math.round) : [];
  }, [rv]);

  const cone20 = rv?.cone?.["20"];

  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
      <span className="font-semibold uppercase tracking-wide">Volatility</span>
      <ClassFilter />
      <SelectMenu
        value={symbol}
        options={symOptions.map((s) => [s, s] as [string, string])}
        onChange={(v) => selectSymbol(v, true)}
        title="Underlying"
        width={150}
      />
      <button className="btn !px-2 !py-0.5 !text-2xs" onClick={() => setTick((t) => t + 1)} disabled={busy}>
        <span className={busy ? "inline-block animate-spin" : ""}>⟳</span> Refresh
      </button>
      <span className="ml-auto">{data ? `updated ${ago(data.asOf)}` : ""}</span>
    </div>
  );

  if (!data) {
    return (
      <div className="flex flex-col min-[901px]:min-h-0 min-[901px]:flex-1">
        {toolbar}
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-[360px] rounded-lg border border-term-dim/70 bg-term-panel/95 px-4 py-3 text-center text-xs">
            {err ? (
              <>
                <div className="font-semibold text-down">Couldn't load volatility for {symbol}</div>
                <div className="mt-1 break-words text-[10px] text-term-dim">{err}</div>
                <button className="chipbtn mt-2 text-term-text" onClick={() => setTick((t) => t + 1)}>
                  Retry
                </button>
              </>
            ) : (
              <div className="flex items-center justify-center gap-2 text-term-text">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-term-dim/50 border-t-term-accent" />
                Loading volatility for {symbol}…
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-[901px]:min-h-0 min-[901px]:flex-1 min-[901px]:overflow-y-auto">
      {toolbar}

      {data.summary && <SummaryCard s={data.summary} />}

      <VolHeadline data={data} />

      {data.vrp && !data.summary && (
        <div className="mx-3 mt-2 rounded border border-term-accent/40 bg-term-accent/10 px-3 py-1.5 text-xs text-term-text">
          <span className="font-semibold">Implied vs realized:</span> {data.vrp.read}. 30-day IV{" "}
          <span className="num">{pctFmt(data.vrp.iv30)}</span> against 20-day realized{" "}
          <span className="num">{pctFmt(data.vrp.rv20)}</span>.
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-3 lg:grid-cols-2">
        {/* ---- smile ---- */}
        <Card title="IV smile" hint="Out-of-the-money IV at every strike, one line per expiry">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <div className="seg" title="How far either side of spot to draw">
              {([[3, "±3%"], [5, "±5%"], [8, "±8%"], [0, "All"]] as const).map(([v, l]) => (
                <button key={v} className={width === v ? "on" : ""} onClick={() => setWidth(v)}>
                  {l}
                </button>
              ))}
            </div>
            {data.expiries.map((e, i) => {
              const off = hidden.has(e.expiry);
              return (
                <button
                  key={e.expiry}
                  className={`chipbtn ${off ? "" : "on"}`}
                  style={off ? undefined : { background: colorOf(i), borderColor: colorOf(i) }}
                  title={e.stale ? "Cached - the latest refresh failed" : undefined}
                  onClick={() =>
                    setHidden((h) => {
                      const n = new Set(h);
                      n.has(e.expiry) ? n.delete(e.expiry) : n.add(e.expiry);
                      return n;
                    })
                  }
                >
                  {e.expiry} · {nf(e.dte, 0)}d{e.stale ? " ≈" : ""}
                </button>
              );
            })}
          </div>
          <LineChart
            series={smileSeries}
            height={260}
            xFormat={(x) => sk(x)}
            yFormat={pctFmt}
            vlines={[{ value: data.spot, label: "spot", color: "#94a3b8" }]}
          />
        </Card>

        {/* ---- term structure ---- */}
        <Card title="Term structure" hint="ATM IV against days to expiry, with the 25Δ wings">
          <LineChart
            series={termSeries}
            height={270}
            xFormat={(x) => `${nf(x, 0)}d`}
            yFormat={pctFmt}
            vlines={data.iv30 != null ? [{ value: 30, label: `30D ${pctFmt(data.iv30)}`, color: "#94a3b8" }] : []}
          />
        </Card>

        {/* ---- skew table ---- */}
        <Card title="Skew by expiry" hint="25Δ = the option with a 0.25 delta" className="lg:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-2xs">
              <thead>
                <tr className="text-left text-[10px] uppercase text-term-dim">
                  {["Expiry", "DTE", "ATM IV", "±1σ move", "Straddle prices", "25Δ put IV", "25Δ call IV", "Risk reversal", "Butterfly"].map((h) => (
                    <th key={h} className="border-b border-term-border px-2 py-1 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="num">
                {data.term.map((r, i) => (
                  <tr key={r.expiry} className="border-b border-term-border/50">
                    <td className="px-2 py-1">
                      <span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: colorOf(i) }} />
                      {r.expiry}
                      {r.stale ? " ≈" : ""}
                    </td>
                    <td className="px-2 py-1">{nf(r.dte, 1)}</td>
                    <td className="px-2 py-1 font-semibold text-term-text">{r.atmIV != null ? pctFmt(r.atmIV) : "–"}</td>
                    <td className="px-2 py-1">{r.sigmaMovePct != null ? `±${nf(r.sigmaMovePct, 2)}%` : "–"}</td>
                    <td className="px-2 py-1">{r.straddleMovePct != null ? `±${nf(r.straddleMovePct, 2)}%` : "–"}</td>
                    <td className="px-2 py-1">{r.put25 != null ? pctFmt(r.put25) : "–"}</td>
                    <td className="px-2 py-1">{r.call25 != null ? pctFmt(r.call25) : "–"}</td>
                    <td className={`px-2 py-1 ${r.rr25 == null ? "" : r.rr25 < 0 ? "text-down" : "text-up"}`}>
                      {r.rr25 != null ? `${r.rr25 >= 0 ? "+" : ""}${nf(r.rr25, 2)}` : "–"}
                    </td>
                    <td className="px-2 py-1">{r.fly25 != null ? `${r.fly25 >= 0 ? "+" : ""}${nf(r.fly25, 2)}` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[10px] text-term-dim">
            Risk reversal below zero means downside puts cost more than equally-far upside calls. The straddle prices about 0.8 of
            the 1σ move, so "Straddle prices" is what the market is actually charging for that expiry.
          </p>
        </Card>

        {/* ---- implied vs realized ---- */}
        <Card
          title="Implied vs realized"
          hint="20-day realized volatility over the past ~6 months against today's 30-day IV"
          className="lg:col-span-2"
        >
          {!rv?.available ? (
            <div className="rounded border border-term-border p-3 text-xs text-term-dim">
              Realized volatility needs the underlying's candle history, and none is available for {data.symbol} right now
              {rv?.error ? ` (${rv.error})` : ""}. Connect Upstox or Flattrade in Settings.
            </div>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              <LineChart
                series={rvSeries}
                height={250}
                xTicks={rvTicks}
                xFormat={(i) => (rv.series?.[Math.round(i)] ? shortDate(rv.series[Math.round(i)].d) : "")}
                yFormat={pctFmt}
                hlines={[
                  ...(data.iv30 != null ? [{ value: data.iv30, label: `30D IV ${pctFmt(data.iv30)}`, color: IV }] : []),
                  ...(cone20 ? [{ value: cone20.median, label: `1y median ${pctFmt(cone20.median)}`, color: "#94a3b8" }] : []),
                ]}
              />
              <div className="flex flex-col gap-2 text-2xs">
                <table className="w-full whitespace-nowrap">
                  <thead>
                    <tr className="text-left text-[10px] uppercase text-term-dim">
                      <th className="px-1.5 py-1 font-medium">Window</th>
                      <th className="px-1.5 py-1 font-medium">Realized</th>
                      <th className="px-1.5 py-1 font-medium">vs 1y</th>
                      <th className="w-full px-1.5 py-1 font-medium">Past year range</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    {(["10", "20", "30"] as const).map((n) => {
                      const c = rv.cone?.[n];
                      return (
                        <tr key={n} className="border-t border-term-border/50">
                          <td className="px-1.5 py-1.5">{n}-day</td>
                          <td className="px-1.5 py-1.5 font-semibold text-term-text">{c ? pctFmt(c.current) : "–"}</td>
                          <td className="px-1.5 py-1.5" title="Percentile of today's reading among the past year's readings">
                            {c ? `${ord(c.pct)} pct` : "–"}
                          </td>
                          <td className="px-1.5 py-1.5">{c ? <ConeBar cone={c} iv={n === "20" ? data.iv30 : undefined} /> : "–"}</td>
                        </tr>
                      );
                    })}
                    <tr className="border-t border-term-border/50">
                      <td className="px-1.5 py-1.5">5-day</td>
                      <td className="px-1.5 py-1.5 font-semibold text-term-text">{rv.rv5 != null ? pctFmt(rv.rv5) : "–"}</td>
                      <td colSpan={2} />
                    </tr>
                    {rv.today?.rv != null && (
                      <tr className="border-t border-term-border/50">
                        <td className="px-1.5 py-1.5">Today</td>
                        <td className="px-1.5 py-1.5 font-semibold text-term-text">{pctFmt(rv.today.rv)}</td>
                        <td colSpan={2} className="px-1.5 py-1.5 text-term-dim">
                          from {rv.today.bars} five-minute bars
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <p className="text-[10px] text-term-dim">
                  Bars show the past year's range with the middle half boxed and the median ticked. Amber is today's realized
                  reading; blue on the 20-day row is the 30-day IV, so you can see where implied sits against what the index has done.
                </p>
              </div>
            </div>
          )}
        </Card>
      </div>

      {data.skipped.length > 0 && (
        <div className="px-3 pb-3 text-[10px] text-term-dim">
          Not loaded: {data.skipped.join(", ")} (no chain available for those expiries).
        </div>
      )}
    </div>
  );
}
