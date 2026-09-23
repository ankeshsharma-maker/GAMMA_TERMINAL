import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf } from "../lib/format";
import { istTime } from "../lib/istTime";
import type { FlowData, FlowDir, FlowEvent, FlowKey, FlowLeg, FlowPoint } from "../types";
import { SelectMenu } from "./SelectMenu";

/* ------------------------------------------------------------------ */
/* Option flow: who is buying, who is writing, what direction that     */
/* adds up to, and when it turns. All maths is server-side (flow.py).   */
/* ------------------------------------------------------------------ */

const WINDOWS: readonly (readonly [string, string])[] = [
  ["5 min ago", "5"],
  ["15 min ago", "15"],
  ["30 min ago", "30"],
  ["1 hour ago", "60"],
  ["Prev close", "day"],
];
const WIN_LS = "flow.window";

const UP = "#4ade80"; // emerald-400: readable on the dark panel
const DOWN = "#f87171"; // red-400
const SKY = "#38bdf8";
const AMBER = "#fbbf24";

type Kind = { label: string; short: string; tone: "bull" | "bear" | "cover" | "unwind"; side: "CE" | "PE" };
const KINDS: Record<FlowKey, Kind> = {
  pw: { label: "Put writing", short: "Put writing", tone: "bull", side: "PE" },
  cb: { label: "Call buying", short: "Call buying", tone: "bull", side: "CE" },
  cw: { label: "Call writing", short: "Call writing", tone: "bear", side: "CE" },
  pb: { label: "Put buying", short: "Put buying", tone: "bear", side: "PE" },
  cs: { label: "Call short covering", short: "Call covering", tone: "cover", side: "CE" },
  ps: { label: "Put short covering", short: "Put covering", tone: "cover", side: "PE" },
  cu: { label: "Call long unwinding", short: "Call unwinding", tone: "unwind", side: "CE" },
  pu: { label: "Put long unwinding", short: "Put unwinding", tone: "unwind", side: "PE" },
};
const CARD_KEYS: FlowKey[] = ["pw", "cb", "cw", "pb"];
const EXIT_KEYS: FlowKey[] = ["cs", "ps", "cu", "pu"];

const TONE_HEX = { bull: UP, bear: DOWN, cover: SKY, unwind: AMBER } as const;
const TONE_TEXT = {
  bull: "text-emerald-400",
  bear: "text-red-400",
  cover: "text-sky-400",
  unwind: "text-amber-400",
} as const;
const TONE_CHIP = {
  bull: "bg-emerald-500/15 text-emerald-400",
  bear: "bg-red-500/15 text-red-400",
  cover: "bg-sky-500/20 text-sky-400",
  unwind: "bg-amber-500/20 text-amber-400",
} as const;

const DIR_HEX: Record<FlowDir, string> = { bull: UP, bear: DOWN, mixed: "#94a3b8" };

/** contracts -> "18.4L" (lakh) or "42K" for the small ones */
const big = (v: number, sign = false): string => {
  const a = Math.abs(v);
  const s = sign ? (v > 0 ? "+" : v < 0 ? "−" : "") : v < 0 ? "−" : "";
  if (a >= 1e5) return `${s}${(a / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${s}${Math.round(a / 1e3)}K`;
  return `${s}${Math.round(a)}`;
};
const dur = (min: number | null | undefined): string => {
  if (min == null) return "–";
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m} min`;
};
const pctS = (v: number): string => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v * 100))}%`;

/* ------------------------------------------------------------------ */
/* data                                                                */
/* ------------------------------------------------------------------ */
function useFlow(symbol: string, expiry: string | undefined, win: string) {
  const [data, setData] = useState<FlowData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.flow(symbol, expiry, win).then(
        (d) => alive && (setData(d), setErr(null)),
        (e) => alive && setErr(String(e?.message ?? e))
      );
    load();
    const id = window.setInterval(() => !document.hidden && load(), 10000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [symbol, expiry, win]);
  // what is on screen belongs to another symbol / window until the new answer lands
  const fresh = data && data.symbol === symbol.toUpperCase() && data.window === win ? data : null;
  return { data: fresh, err };
}

/* ------------------------------------------------------------------ */
/* the screen                                                          */
/* ------------------------------------------------------------------ */
export function FlowView() {
  const symbol = useStore((s) => s.symbol);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const selectExpiry = useStore((s) => s.selectExpiry);
  const chain = useStore((s) => s.chain);
  const symClass = useStore((s) => s.symClass);
  const symClassOk = useStore((s) => s.symClassOk);

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
    [symChoices, symbol, symClass] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const [win, setWin] = useState<string>(() => {
    try {
      const v = localStorage.getItem(WIN_LS);
      return v && WINDOWS.some(([, w]) => w === v) ? v : "15";
    } catch {
      return "15";
    }
  });
  const pickWin = (w: string) => {
    setWin(w);
    try {
      localStorage.setItem(WIN_LS, w);
    } catch {
      /* private mode */
    }
  };

  // the chain in the store belongs to the selected symbol only once it has loaded
  const expiry = chain && chain.symbol === symbol ? chain.expiry : undefined;
  const { data, err } = useFlow(symbol, expiry, win);

  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now() / 1000), 5000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel2 px-3 py-2 text-2xs">
        <span className="text-sm font-semibold">{symbol} Option Flow</span>
        <SelectMenu
          value={symbol}
          options={symOptions.map((s) => [s, s] as [string, string])}
          onChange={(v) => selectSymbol(v, true)}
          title="Underlying"
          width={140}
        />
        {chain?.expiries?.length ? (
          <SelectMenu
            value={expiry ?? chain.expiry}
            options={chain.expiries.map((e) => [e, e] as [string, string])}
            onChange={selectExpiry}
            title="Expiry"
            width={130}
          />
        ) : null}
        <span className="uppercase tracking-wide text-term-dim">Compare with</span>
        <div className="seg text-[10px]">
          {WINDOWS.map(([label, w]) => (
            <button key={w} className={win === w ? "on" : ""} onClick={() => pickWin(w)}>
              {label}
            </button>
          ))}
        </div>
        {data?.closed && data.trackingSince ? <span className="rounded bg-term-bg px-1.5 py-0.5 text-term-dim">market closed — last reading</span> : null}
        {data?.trackingSince ? (
          <span className="ml-auto text-term-dim">
            tracking since {istTime(data.trackingSince)}
            {data.asOf ? ` (${dur((data.asOf - data.trackingSince) / 60)}) · updated ${Math.max(0, Math.round(now - data.asOf))}s ago` : ""}
          </span>
        ) : null}
      </div>

      {err && !data ? (
        <div className="m-3 rounded border border-down/40 bg-down/10 px-3 py-2 text-xs text-red-300">
          Couldn't load option flow: {err}
        </div>
      ) : !data ? (
        <div className="m-3 rounded border border-dashed border-term-border px-3 py-6 text-center text-xs text-term-dim">
          Loading {symbol} flow…
        </div>
      ) : (
        <div className="grid min-h-0 gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-3">
            <StateBand d={data} />
            <Cards d={data} />
            <FlowChart d={data} />
            <StrikeTable d={data} />
          </div>
          <div className="min-w-0 space-y-3">
            <EventLog d={data} />
            <Help />
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* direction banner                                                    */
/* ------------------------------------------------------------------ */
function StateBand({ d }: { d: FlowData }) {
  const st = d.state;
  const dir = st.dir;
  const pill =
    d.closed && !d.trackingSince
      ? { txt: "MARKET CLOSED", cls: "border-term-border bg-term-bg text-term-dim" }
      : d.warming && dir == null
      ? { txt: "WARMING UP", cls: "border-term-border bg-term-bg text-term-dim" }
      : dir === "bull"
        ? { txt: "▲ BULLISH", cls: "border-emerald-500/50 bg-emerald-500/15 text-emerald-400" }
        : dir === "bear"
          ? { txt: "▼ BEARISH", cls: "border-red-500/50 bg-red-500/15 text-red-400" }
          : dir === "mixed"
            ? { txt: "◆ MIXED", cls: "border-term-border bg-term-bg text-term-text" }
            : { txt: "READING…", cls: "border-term-border bg-term-bg text-term-dim" };

  const lead = st.leader ? KINDS[st.leader] : null;
  let why: React.ReactNode = null;
  if (d.closed && !d.trackingSince) {
    why = <>The market is closed. Option flow is tracked 09:15–15:30 IST, Monday to Friday — it starts by itself when the market opens.</>;
  } else if (d.warming) {
    why = (
      <>
        Needs {d.warmupMin} min of data to compare against — {dur(d.coverageMin)} so far. The <b>Prev close</b> view works
        right away.
      </>
    );
  } else if (d.quiet) {
    why = <>Flows are too small to read right now (under 0.1% of the chain's open interest).</>;
  } else if (d.flat && d.move != null && d.lean != null) {
    why = (
      <>
        {d.symbol} has only moved {d.move > 0 ? "+" : d.move < 0 ? "−" : ""}
        {nf(Math.abs(d.move), 0)} pts in this window — a direction needs ±{nf(d.needMove, 0)} — so none is called.
        The flows themselves lean{" "}
        <b className={d.lean >= 0 ? "text-emerald-400" : "text-red-400"}>
          {d.lean >= 0 ? "bullish" : "bearish"} ({pctS(d.lean)})
        </b>
        .
      </>
    );
  } else if (dir === "bull" || dir === "bear") {
    why = (
      <>
        Bullish flows <b className="text-emerald-400">{big(d.bull)}</b> vs bearish{" "}
        <b className="text-red-400">{big(d.bear)}</b>
        {lead ? (
          <>
            {" "}
            · <b className={TONE_TEXT[lead.tone]}>{lead.label}</b> leads
          </>
        ) : null}
        .
      </>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-term-border bg-term-panel px-3 py-2.5">
      <div className={`rounded-md border px-3 py-1.5 text-base font-bold tracking-wide ${pill.cls}`}>{pill.txt}</div>
      <div className="min-w-0 flex-1 basis-56">
        {dir && st.since ? (
          <div className="text-xs text-term-text">
            {dir === "mixed" ? "No clear direction" : `Strength ${st.strength ?? 0}%`}{" "}
            <span className="text-term-dim">
              · since {istTime(st.since)} ({dur(st.heldMin)})
            </span>
          </div>
        ) : null}
        <div className="mt-0.5 text-[11px] leading-snug text-term-dim">{why}</div>
      </div>
      {d.spot ? (
        <div className="text-right">
          <div className="text-[9px] uppercase tracking-wide text-term-dim">{d.symbol}</div>
          <div className="num text-base font-bold">{nf(d.spot, 1)}</div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the four flows                                                      */
/* ------------------------------------------------------------------ */
function Spark({ pts, k, color }: { pts: FlowPoint[]; k: "pw" | "cw" | "cb" | "pb"; color: string }) {
  const s = pts.slice(-45);
  if (s.length < 2) return <div className="h-6" />;
  const max = Math.max(...s.map((p) => p[k]), 1);
  const path = s
    .map((p, i) => `${i ? "L" : "M"}${((i / (s.length - 1)) * 100).toFixed(1)},${(24 - (p[k] / max) * 22 - 1).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full" aria-hidden>
      <path d={path} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Cards({ d }: { d: FlowData }) {
  const mx = Math.max(...CARD_KEYS.map((k) => d.flows[k]), 1);
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {CARD_KEYS.map((k) => {
          const kd = KINDS[k];
          const v = d.flows[k];
          const top = d.top[k];
          return (
            <div key={k} className="min-w-0 rounded-lg border border-term-border bg-term-panel px-2.5 py-2">
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-term-dim">{kd.label}</span>
                <span className={`rounded px-1 text-[9px] font-semibold ${TONE_CHIP[kd.tone]}`}>
                  {kd.tone === "bull" ? "bullish" : "bearish"}
                </span>
              </div>
              <div className={`num mt-0.5 text-xl font-bold ${TONE_TEXT[kd.tone]}`}>{big(v, true)}</div>
              <div className="mt-1 h-1.5 overflow-hidden rounded bg-term-bg">
                <div className="h-full rounded" style={{ width: `${Math.max(2, (v / mx) * 100)}%`, background: TONE_HEX[kd.tone] }} />
              </div>
              <div className="mt-1 truncate text-[10px] text-term-dim">
                {top ? (
                  <>
                    biggest at <span className="num text-term-text">{nf(top.strike, 0)}</span> {kd.side} · {big(top.chg)}
                  </>
                ) : (
                  "nothing near the money"
                )}
              </div>
              <Spark pts={d.series} k={k as "pw" | "cw" | "cb" | "pb"} color={TONE_HEX[kd.tone]} />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 px-1 text-[10px] text-term-dim">
        <span>Exits (not counted in the direction):</span>
        {EXIT_KEYS.map((k) => (
          <span key={k}>
            {KINDS[k].short} <span className={`num ${TONE_TEXT[KINDS[k].tone]}`}>{big(d.flows[k])}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* chart: spot on top with the direction shaded behind it, the bias      */
/* underneath, a mark at every reversal                                  */
/* ------------------------------------------------------------------ */
function FlowChart({ d }: { d: FlowData }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const set = () => setW(Math.max(280, Math.round(el.clientWidth)));
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pts = useMemo(() => d.series.filter((p) => p.spot > 0), [d.series]);
  const m = { l: 50, r: 10, t: 8, b: 20 };
  const H1 = 150;
  const H2 = 64;
  const GAP = 8;
  const H = m.t + H1 + GAP + H2 + m.b;

  const geo = useMemo(() => {
    if (pts.length < 2) return null;
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const x = (t: number) => m.l + ((t - t0) / (t1 - t0 || 1)) * (w - m.l - m.r);
    let lo = Math.min(...pts.map((p) => p.spot));
    let hi = Math.max(...pts.map((p) => p.spot));
    const pad = (hi - lo) * 0.1 || hi * 0.0005;
    lo -= pad;
    hi += pad;
    const y1 = (v: number) => m.t + (1 - (v - lo) / (hi - lo || 1)) * H1;
    const yb = (b: number) => m.t + H1 + GAP + (1 - (b + 1) / 2) * H2;
    // tick marks on IST clock boundaries
    const span = (t1 - t0) / 60;
    const step = (span <= 100 ? 15 : span <= 200 ? 30 : 60) * 60;
    const ticks: number[] = [];
    for (let t = Math.ceil((t0 + 19800) / step) * step - 19800; t <= t1; t += step) ticks.push(t);
    // shaded runs of a confirmed direction
    const bands: { a: number; b: number; dir: FlowDir }[] = [];
    let run: { a: number; dir: FlowDir } | null = null;
    pts.forEach((p, i) => {
      const dir = p.st === "bull" || p.st === "bear" ? p.st : null;
      if (run && run.dir !== dir) {
        bands.push({ a: run.a, b: pts[i].t, dir: run.dir });
        run = null;
      }
      if (dir && !run) run = { a: p.t, dir };
    });
    if (run) bands.push({ a: (run as { a: number }).a, b: t1, dir: (run as { dir: FlowDir }).dir });
    return { x, y1, yb, lo, hi, ticks, bands, t0, t1 };
  }, [pts, w, H1, H2]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!geo) {
    return (
      <div className="rounded-lg border border-dashed border-term-border px-3 py-8 text-center text-xs text-term-dim">
        The chart fills in as samples arrive (one a minute).
      </div>
    );
  }
  const { x, y1, yb, lo, hi, ticks, bands } = geo;

  const marks = d.events
    .filter((e) => e.kind === "reversal" || e.kind === "turn" || e.kind === "fade" || (e.kind === "start" && e.to !== "mixed"))
    .map((e) => {
      const p = pts.reduce((best, q) => (Math.abs(q.t - e.t) < Math.abs(best.t - e.t) ? q : best), pts[0]);
      return { e, cx: x(p.t), cy: y1(p.spot) };
    })
    .filter((mk) => mk.e.t >= geo.t0 - 60);

  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y1(p.spot).toFixed(1)}`).join(" ");
  const bw = Math.max(1, (w - m.l - m.r) / pts.length - 0.6);
  const hp = hover != null ? pts[hover] : null;

  return (
    <div className="rounded-lg border border-term-border bg-term-panel px-2 py-2">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-3 px-1 text-[10px] text-term-dim">
        <span className="font-semibold uppercase tracking-wide">
          {d.symbol} and the direction the flows called
        </span>
        <span className="num min-h-[1em] text-term-text">
          {hp ? (
            <>
              {istTime(hp.t)} · {nf(hp.spot, 1)} · bias {hp.bias == null ? "–" : pctS(hp.bias)}
              {hp.st ? ` · ${hp.st === "bull" ? "BULLISH" : hp.st === "bear" ? "BEARISH" : "MIXED"}` : ""}
            </>
          ) : (
            <span className="text-term-dim">
              <span style={{ color: UP }}>■</span> bullish · <span style={{ color: DOWN }}>■</span> bearish · ▲▼ flips
            </span>
          )}
        </span>
      </div>
      <div ref={box} className="w-full">
        <svg
          width={w}
          height={H}
          viewBox={`0 0 ${w} ${H}`}
          role="img"
          aria-label={`${d.symbol} price with the option-flow direction`}
          className="block select-none"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(ev) => {
            const r = (ev.currentTarget as SVGSVGElement).getBoundingClientRect();
            const px = ev.clientX - r.left;
            let bi = 0;
            let bd = Infinity;
            pts.forEach((p, i) => {
              const dd = Math.abs(x(p.t) - px);
              if (dd < bd) {
                bd = dd;
                bi = i;
              }
            });
            setHover(bi);
          }}
        >
          {/* shaded direction */}
          {bands.map((b, i) => (
            <rect key={i} x={x(b.a)} y={m.t} width={Math.max(1, x(b.b) - x(b.a))} height={H1} fill={DIR_HEX[b.dir]} opacity={0.13} />
          ))}
          {/* grid + spot axis */}
          {[lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1].map((v, i) => (
            <g key={i}>
              <line x1={m.l} x2={w - m.r} y1={y1(v)} y2={y1(v)} stroke="currentColor" strokeOpacity={0.1} className="text-term-dim" />
              <text x={m.l - 5} y={y1(v) + 3} textAnchor="end" fontSize={9} fill="currentColor" className="text-term-dim">
                {nf(v, 0)}
              </text>
            </g>
          ))}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={m.t} y2={H - m.b} stroke="currentColor" strokeOpacity={0.07} className="text-term-dim" />
              <text x={x(t)} y={H - 6} textAnchor="middle" fontSize={9} fill="currentColor" className="text-term-dim">
                {istTime(t)}
              </text>
            </g>
          ))}
          <path d={path} fill="none" stroke="#e2e8f0" strokeWidth={1.4} strokeLinejoin="round" />
          {/* flips */}
          {marks.map(({ e, cx, cy }, i) =>
            e.kind === "fade" ? (
              <circle key={i} cx={cx} cy={cy} r={3.5} fill="none" stroke="#94a3b8" strokeWidth={1.4} />
            ) : (
              <path
                key={i}
                d={e.to === "bull" ? `M${cx},${cy - 11} l6,10 h-12 z` : `M${cx},${cy + 11} l6,-10 h-12 z`}
                fill={DIR_HEX[e.to ?? "mixed"]}
                stroke="#0f141d"
                strokeWidth={1}
              >
                <title>{`${istTime(e.t)} ${e.text}`}</title>
              </path>
            ),
          )}
          {/* bias */}
          <line x1={m.l} x2={w - m.r} y1={yb(0)} y2={yb(0)} stroke="currentColor" strokeOpacity={0.35} className="text-term-dim" />
          {[0.25, -0.25].map((g) => (
            <line key={g} x1={m.l} x2={w - m.r} y1={yb(g)} y2={yb(g)} stroke="currentColor" strokeOpacity={0.18} strokeDasharray="3 3" className="text-term-dim" />
          ))}
          {[1, 0, -1].map((g) => (
            <text key={g} x={m.l - 5} y={yb(g) + 3} textAnchor="end" fontSize={9} fill="currentColor" className="text-term-dim">
              {g > 0 ? "+100%" : g < 0 ? "−100%" : "0"}
            </text>
          ))}
          {pts.map((p, i) => {
            if (p.bias == null) return null;
            const cx = x(p.t);
            const y0 = yb(0);
            const yv = yb(p.bias);
            return p.bias === 0 ? (
              p.raw != null && p.raw !== 0 ? <circle key={i} cx={cx} cy={yb(p.raw)} r={1.4} fill="#64748b" /> : null
            ) : (
              <rect key={i} x={cx - bw / 2} y={Math.min(y0, yv)} width={bw} height={Math.max(1, Math.abs(yv - y0))} fill={p.bias > 0 ? UP : DOWN} opacity={0.85} />
            );
          })}
          {hp && (
            <line x1={x(hp.t)} x2={x(hp.t)} y1={m.t} y2={H - m.b} stroke="#e2e8f0" strokeOpacity={0.5} strokeDasharray="2 3" />
          )}
        </svg>
      </div>
      <div className="px-1 pt-0.5 text-[10px] text-term-dim">
        Bars underneath = the direction the flows called (−100% … +100%); grey dots = the flows lean that way but the market has not
        moved enough to call it.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the log                                                             */
/* ------------------------------------------------------------------ */
const EV_BADGE: Record<FlowEvent["kind"], { txt: string; cls: string }> = {
  reversal: { txt: "REVERSAL", cls: "bg-amber-500 text-black" },
  turn: { txt: "TURN", cls: "bg-term-accent/80 text-white" },
  start: { txt: "START", cls: "bg-term-border text-term-text" },
  fade: { txt: "FADE", cls: "bg-slate-600 text-white" },
  lead: { txt: "LEAD", cls: "bg-sky-600/80 text-white" },
};

function EventLog({ d }: { d: FlowData }) {
  return (
    <div className="rounded-lg border border-term-border bg-term-panel">
      <div className="flex items-center justify-between border-b border-term-border px-3 py-1.5">
        <span className="text-2xs font-semibold uppercase tracking-wide text-term-dim">Direction changes</span>
        <span className="text-[10px] text-term-dim">{d.events.length ? `${d.events.length} today` : ""}</span>
      </div>
      {d.events.length === 0 ? (
        <div className="px-3 py-5 text-center text-[11px] leading-snug text-term-dim">
          Nothing yet. Every time the direction starts, fades or reverses it is logged here with the time, the {d.symbol} level and
          the strikes behind it.
        </div>
      ) : (
        <ul className="max-h-[420px] divide-y divide-term-border/60 overflow-y-auto font-mono text-[11px]">
          {d.events.map((e, i) => {
            const b = EV_BADGE[e.kind];
            const edge =
              e.kind === "reversal" || e.kind === "turn" || e.kind === "start"
                ? e.to === "bull"
                  ? "border-l-emerald-500"
                  : e.to === "bear"
                    ? "border-l-red-500"
                    : "border-l-slate-500"
                : "border-l-transparent";
            return (
              <li key={`${e.t}-${i}`} className={`border-l-2 px-2.5 py-1.5 ${edge} ${e.kind === "reversal" ? "bg-amber-500/5" : ""}`}>
                <div className="flex items-center gap-1.5">
                  <span className="num text-term-dim">{istTime(e.t)}</span>
                  <span className={`rounded px-1 text-[9px] font-bold ${b.cls}`}>{b.txt}</span>
                  <span className="num ml-auto text-term-dim">
                    {d.symbol} {nf(e.spot, 0)}
                  </span>
                </div>
                <div className={`mt-0.5 leading-snug ${e.kind === "lead" || e.kind === "fade" ? "text-term-dim" : "text-term-text"}`}>{e.text}</div>
                {e.kind === "reversal" && e.heldMin != null ? (
                  <div className="text-[10px] text-term-dim">the {e.from === "bull" ? "bullish" : "bearish"} run lasted {dur(e.heldMin)}</div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Help() {
  return (
    <div className="rounded-lg border border-term-border/70 bg-term-bg/40 px-3 py-2 text-[11px] leading-snug text-term-dim">
      <div className="mb-1 font-semibold uppercase tracking-wide">How to read this</div>
      <p>
        <b className="text-term-text">Buying</b> = an option's price and its open interest (OI) are both rising.{" "}
        <b className="text-term-text">Writing</b> = the price is falling while OI rises. Put writing and call buying lean{" "}
        <span className="text-emerald-400">bullish</span>; call writing and put buying lean{" "}
        <span className="text-red-400">bearish</span>.
      </p>
      <p className="mt-1">
        A direction is only called once the market has really moved over the window (0.10% in 15 minutes, about 23 NIFTY points);
        a flat market reads MIXED however lopsided the flows look. A flip is confirmed a few samples after it happens, so a reversal
        shows up about 15 minutes after it starts on the 15-minute view (about 8 on 5 minutes).
      </p>
      <p className="mt-1">
        It is worked out from price and OI, not from who traded, so read it as a lean, not a fact.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* strike table                                                        */
/* ------------------------------------------------------------------ */
function Chip({ leg, strike, side, top }: { leg: FlowLeg | undefined; strike: number; side: "CE" | "PE"; top: FlowData["top"] }) {
  if (!leg || !leg.key) return <span className="text-term-dim">–</span>;
  const kd = KINDS[leg.key];
  const star = top[leg.key]?.strike === strike && kd.side === side;
  // the column head already says Calls / Puts, so a phone gets the one-word version
  const word = kd.label.replace(/^(Call|Put) /, "").replace("short covering", "covering").replace("long unwinding", "unwinding");
  return (
    <span className={`inline-block whitespace-nowrap rounded px-1.5 py-px text-[10px] font-semibold ${TONE_CHIP[kd.tone]}`}>
      <span className="sm:hidden">{word[0].toUpperCase() + word.slice(1)}</span>
      <span className="hidden sm:inline">{kd.short}</span>
      {star ? " ★" : ""}
    </span>
  );
}

function StrikeTable({ d }: { d: FlowData }) {
  if (!d.strikes.length) return null;
  // calls read  chip | dOI | dPrice | STRIKE;  puts mirror it:  STRIKE | dPrice | dOI | chip
  const cell = (leg: FlowLeg | undefined, mirror = false) => {
    const oi = (
      <td key="oi" className="num px-1.5 py-1 text-right">
        {leg ? big(leg.dOi, true) : "–"}
      </td>
    );
    const px = (
      <td
        key="px"
        className={`num hidden px-1.5 py-1 text-right sm:table-cell ${leg && leg.dPx > 0 ? "text-emerald-400" : leg && leg.dPx < 0 ? "text-red-400" : "text-term-dim"}`}
      >
        {leg ? `${leg.dPx > 0 ? "+" : leg.dPx < 0 ? "−" : ""}${Math.abs(leg.dPx).toFixed(1)}` : "–"}
      </td>
    );
    return mirror ? [px, oi] : [oi, px];
  };
  return (
    <div className="rounded-lg border border-term-border bg-term-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-term-border px-3 py-1.5">
        <span className="text-2xs font-semibold uppercase tracking-wide text-term-dim">
          Strike by strike · change in OI and price
          {d.window === "day" ? " since yesterday's close" : ` over ${d.window === "60" ? "1 hour" : `${d.window} min`}`}
        </span>
        <span className="text-[10px] text-term-dim">★ = the biggest for that flow</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] sm:min-w-[520px]">
          <thead className="text-[10px] uppercase tracking-wide text-term-dim">
            <tr className="border-b border-term-border/60">
              <th className="px-1.5 py-1 text-left">Calls</th>
              <th className="px-1.5 py-1 text-right">ΔOI</th>
              <th className="hidden px-1.5 py-1 text-right sm:table-cell">Δ price</th>
              <th className="px-1.5 py-1 text-center">Strike</th>
              <th className="hidden px-1.5 py-1 text-right sm:table-cell">Δ price</th>
              <th className="px-1.5 py-1 text-right">ΔOI</th>
              <th className="px-1.5 py-1 text-right">Puts</th>
            </tr>
          </thead>
          <tbody>
            {d.strikes.map((r) => (
              <tr key={r.strike} className={`border-b border-term-border/40 ${r.atm ? "bg-term-accent/10" : ""}`}>
                <td className="px-1.5 py-1 text-left">
                  <Chip leg={r.ce} strike={r.strike} side="CE" top={d.top} />
                </td>
                {cell(r.ce)}
                <td className={`num px-1.5 py-1 text-center font-semibold ${r.atm ? "text-term-accent" : ""}`}>{nf(r.strike, 0)}</td>
                {cell(r.pe, true)}
                <td className="px-1.5 py-1 text-right">
                  <Chip leg={r.pe} strike={r.strike} side="PE" top={d.top} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
