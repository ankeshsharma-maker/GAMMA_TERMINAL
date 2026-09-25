import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RefreshChainBtn } from "./RefreshChainBtn";
import { ClassFilter } from "./Header";
import { useStore } from "../store";
import { api, type OiWallPt } from "../lib/api";
import { istTime } from "../lib/istTime";
import { compact, nf, sk } from "../lib/format";
import { PcrChart } from "./PcrChart";
import { SelectMenu } from "./SelectMenu";
import { useIsMobile } from "../lib/useIsMobile";
import { scoreOI } from "../lib/oiVerdict";
import type { ChainRow } from "../types";

type Metric = "oi" | "chg" | "combined";

const CALL_OI = "#b91c1c"; // dark red    — total Call OI
const PUT_OI = "#15803d"; // dark green   — total Put OI

// change-in-OI, coloured purely by direction: green = OI added (buildup),
// red = OI reduced (unwinding). Leg (call/put) stays shown by column position.
const OI_ADD = "#22c55e";
const OI_CUT = "#ef4444";
// the Change-in-OI bars: calls red, puts green (added solid, cut faded)
const CALL_CHG = "#ef4444";
const PUT_CHG = "#22c55e";

const zClamp = (z: number) => Math.min(3, Math.max(0.5, z));

/** Change in OI as bars from a zero line: per side, OI added rises (green)
 *  and OI cut falls (red), with the net over each pair -- read at a glance,
 *  where the old ring only showed which side's net was bigger. */
const DeltaOIBars = ({
  ceAdd,
  ceCut,
  peAdd,
  peCut,
}: {
  ceAdd: number;
  ceCut: number;
  peAdd: number;
  peCut: number;
}) => {
  const W = 200;
  const H = 200;
  const base = 100; // zero line
  const span = 70; // tallest bar
  const m = Math.max(1, ceAdd, -ceCut, peAdd, -peCut);
  const hgt = (v: number) => (Math.abs(v) / m) * span;
  const bw = 40;
  const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${compact(Math.abs(v))}`;
  // call bars red, put bars green; added rises (solid), cut falls (faded)
  const group = (cx: number, add: number, cut: number, label: string, col: string) => {
    const net = add + cut;
    const ha = hgt(add);
    const hc = hgt(cut);
    return (
      <g>
        <text x={cx} y={14} textAnchor="middle" fontSize="13" fontWeight="700" fill={col}>
          net {signed(net)}
        </text>
        <rect x={cx - bw - 2} y={base - ha} width={bw} height={Math.max(ha, add > 0 ? 1.5 : 0)} rx="2" fill={col} />
        <rect
          x={cx + 2}
          y={base}
          width={bw}
          height={Math.max(hc, cut < 0 ? 1.5 : 0)}
          rx="2"
          fill={col}
          fillOpacity={0.4}
          stroke={col}
          strokeWidth="1"
        />
        <text x={cx - bw / 2 - 2} y={base - ha - 4} textAnchor="middle" fontSize="11" fontWeight="600" className="fill-term-text">
          {add > 0 ? `+${compact(add)}` : ""}
        </text>
        <text x={cx + bw / 2 + 2} y={base + hc + 13} textAnchor="middle" fontSize="11" fontWeight="600" className="fill-term-text">
          {cut < 0 ? `−${compact(-cut)}` : ""}
        </text>
        <text x={cx} y={H - 4} textAnchor="middle" fontSize="13" fontWeight="700" fill={col}>
          {label}
        </text>
      </g>
    );
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[420px]">
      <line x1="4" x2={W - 4} y1={base} y2={base} stroke="#64748b" strokeWidth="1" />
      {group(W * 0.27, ceAdd, ceCut, "Call", CALL_CHG)}
      {group(W * 0.73, peAdd, peCut, "Put", PUT_CHG)}
    </svg>
  );
};

/** Two-value ring: |aVal| vs |bVal| as an arc split, a bold center label and
 *  a dim caption underneath. Shared by the OI-split donuts and the Dealer
 *  Exposure panel's Call/Put and ITM/OTM rings. */
const MiniDonut = ({
  aVal,
  bVal,
  aCol,
  bCol,
  center,
  sub,
}: {
  aVal: number;
  bVal: number;
  aCol: string;
  bCol: string;
  center: string;
  sub: string;
}) => {
  const R = 40;
  const SW = 12;
  const C = 2 * Math.PI * R;
  const t = Math.abs(aVal) + Math.abs(bVal) || 1;
  const aLen = (Math.abs(aVal) / t) * C;
  return (
    <svg viewBox="0 0 100 100" className="w-full max-w-[190px]">
      <circle cx="50" cy="50" r={R} fill="none" stroke="#1e2733" strokeWidth={SW} />
      <circle
        cx="50"
        cy="50"
        r={R}
        fill="none"
        stroke={bCol}
        strokeWidth={SW}
        strokeDasharray={`${C} ${C}`}
        transform="rotate(-90 50 50)"
      />
      <circle
        cx="50"
        cy="50"
        r={R}
        fill="none"
        stroke={aCol}
        strokeWidth={SW}
        strokeDasharray={`${aLen.toFixed(1)} ${C}`}
        transform="rotate(-90 50 50)"
      />
      <text x="50" y="47" textAnchor="middle" className="fill-term-text" fontSize="16" fontWeight="700">
        {center}
      </text>
      <text x="50" y="61" textAnchor="middle" className="fill-term-dim" fontSize="8">
        {sub}
      </text>
    </svg>
  );
};

export function OIProfile({ paneNav }: { paneNav?: ReactNode } = {}) {
  const chain = useStore((s) => s.chain);
  const chainError = useStore((s) => s.chainError);
  const symbol = useStore((s) => s.symbol);
  const expiry = useStore((s) => s.expiry) ?? chain?.expiry ?? "";
  const selectSymbol = useStore((s) => s.selectSymbol);
  const selectExpiry = useStore((s) => s.selectExpiry);
  const symClass = useStore((s) => s.symClass);
  const symClassOk = useStore((s) => s.symClassOk);

  const isMobile = useIsMobile();
  const [tools, setTools] = useState(false); // mobile: show the extra control rows
  const [metric, setMetric] = useState<Metric>("combined");
  const [layout, setLayout] = useState<"chart" | "table" | "ladder" | "walls" | "pcr" | "gex" | "dex">("chart");
  // Table / Ladder open centred on the spot line (with All strikes they'd
  // start at the lowest strike) -- re-centred a few times over ~1.5 s while
  // the page settles (a single scroll on the first render could land at the
  // top on a phone, the list still growing), and again on a symbol / expiry
  // change. Any touch, wheel or key stops it, so it never fights a manual
  // scroll, and the 5 s refreshes don't re-run it.
  const spotRef = useRef<HTMLDivElement>(null);
  const tableSpotRef = useRef<HTMLTableRowElement>(null);
  const chainReady = !!chain && chain.rows.length > 0;
  useEffect(() => {
    if ((layout !== "ladder" && layout !== "table") || !chainReady) return;
    let stop = false;
    const target = () => (layout === "table" ? tableSpotRef.current : spotRef.current);
    const go = () => {
      if (!stop) target()?.scrollIntoView({ block: "center" });
    };
    const halt = () => {
      stop = true;
    };
    const evs = ["touchstart", "wheel", "keydown"] as const;
    evs.forEach((e) => document.addEventListener(e, halt, { passive: true }));
    const timers = [0, 150, 400, 900, 1600].map((ms) => window.setTimeout(go, ms));
    return () => {
      stop = true;
      timers.forEach((t) => window.clearTimeout(t));
      evs.forEach((e) => document.removeEventListener(e, halt));
    };
  }, [layout, symbol, expiry, chainReady]);

  // "Go to" chips: centre a strike and flash its row
  const jumpBoxRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const flashT = useRef<number | undefined>(undefined);

  // the Walls view: today's recorded walls, refreshed every minute
  const [wallPts, setWallPts] = useState<OiWallPt[] | null>(null);
  useEffect(() => {
    if (layout !== "walls") return;
    let alive = true;
    setWallPts(null);
    const load = () =>
      api.oiWalls(symbol, expiry || undefined).then(
        (d) => alive && setWallPts(d.points),
        () => alive && setWallPts([])
      );
    load();
    const id = window.setInterval(() => !document.hidden && load(), 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [layout, symbol, expiry]);
  const [gexPts, setGexPts] = useState<
    { date: string; spot: number; netGex: number; gammaFlip: number }[]
  >([]);
  const [gexSource, setGexSource] = useState<"nse_bhavcopy" | "upstox" | null>(null);
  const [gexErr, setGexErr] = useState<string | null>(null);
  const [gexView, setGexView] = useState<"chart" | "table">("chart");
  const [gexFrame, setGexFrame] = useState<"daily" | "intraday">("daily");
  const [intraGexPts, setIntraGexPts] = useState<
    { t: number; spot: number; netGex: number; gammaFlip: number | null }[]
  >([]);
  const [intraTf, setIntraTf] = useState(5); // minutes: bucket size for the intraday gex chart/table
  const [count, setCount] = useState(0); // strikes each side of ATM; 0 = All
  const [symChoices, setSymChoices] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  // ΔOI window in minutes, 0 = the full day (since yesterday's close). Remembered
  // on the device; Full day until one is picked -- a rolling 5 min reads all
  // zeros whenever the market is shut, which looked like missing data
  const [tf, setTfState] = useState<number>(() => {
    try {
      const v = localStorage.getItem("oi.tf");
      if (v != null && Number.isFinite(+v)) return +v;
    } catch {
      /* private mode */
    }
    return 0;
  });
  const setTf = (v: number) => {
    setTfState(v);
    try {
      localStorage.setItem("oi.tf", String(v));
    } catch {
      /* ignore */
    }
  };
  const [win, setWin] = useState<Record<string, { ceOiChg: number; peOiChg: number }>>({});
  const [winCov, setWinCov] = useState(0);
  const [donutW, setDonutW] = useState(260); // resizable OI-split panel width (px)
  const scrollRef = useRef<HTMLDivElement>(null);
  const didCenter = useRef(false);

  const startDonutDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = donutW;
    const move = (ev: MouseEvent) =>
      setDonutW(Math.max(150, Math.min(600, w0 + (ev.clientX - x0))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const AREA = Math.round(240 * zoom);
  const COLW = Math.round(40 * zoom);
  const BARW = Math.max(5, Math.round(14 * zoom));

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
    [symChoices, symbol, symClass]
  );

  // rolling-window OI change (polls the backend snapshot series)
  useEffect(() => {
    if (tf === 0 || !chain) {
      setWin({});
      setWinCov(0);
      return;
    }
    let alive = true;
    const load = () =>
      api.oiChange(symbol, expiry || undefined, tf).then(
        (d) => {
          if (!alive) return;
          const m: Record<string, { ceOiChg: number; peOiChg: number }> = {};
          for (const [k, v] of Object.entries(d.strikes))
            m[k] = { ceOiChg: v.ceOiChg, peOiChg: v.peOiChg };
          setWin(m);
          setWinCov(d.coverageMin);
        },
        () => {}
      );
    load();
    const id = window.setInterval(load, 20000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [tf, symbol, expiry, chain?.symbol, chain?.expiry]);

  // today's intraday netGex/gammaFlip — same in-memory session history the
  // PCR chart above already polls (store.py records both on every chain
  // refresh), just not surfaced as its own view before. Bounded to
  // HISTORY_MAXLEN snapshots (~3h at the poller's ~15s cadence), persisted
  // to disk and reloaded on startup (store._load_history/_persist_history)
  // -- NOT reset by a restart, but also not a clean single trading session
  // if the backend was down for stretches in between; the daily bhavcopy
  // view below has no such gaps since it's one real close per real day.
  useEffect(() => {
    if (layout !== "gex" || gexFrame !== "intraday" || !symbol) return;
    let alive = true;
    const load = () =>
      api.history(symbol).then(
        (d) => {
          if (!alive) return;
          setIntraGexPts(
            d.points
              .filter((p) => p.netGex != null)
              .map((p) => ({ t: p.t, spot: p.spot, netGex: p.netGex, gammaFlip: p.gammaFlip ?? null }))
          );
        },
        () => {}
      );
    load();
    const id = window.setInterval(load, 15000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [layout, gexFrame, symbol]);

  // daily netGex/gammaFlip history for the "gex" layout — daily-resolution,
  // so a slow refresh is plenty (unlike the live 20s polls above)
  useEffect(() => {
    if (layout !== "gex" || !symbol) return;
    let alive = true;
    setGexErr(null);
    const load = () =>
      api.weeklyGex(symbol, 10).then(
        (d) => {
          if (!alive) return;
          setGexPts(d.series);
          setGexSource(d.source);
        },
        (e) => {
          if (!alive) return;
          setGexErr(e?.message || "failed");
        }
      );
    load();
    const id = window.setInterval(load, 5 * 60000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [layout, symbol]);

  const rows = useMemo<ChainRow[]>(() => {
    if (!chain) return [];
    if (count === 0) return chain.rows; // "All"
    let atm = chain.rows.findIndex((r) => r.strike === chain.atmStrike);
    if (atm < 0) atm = Math.floor(chain.rows.length / 2);
    return chain.rows.slice(Math.max(0, atm - count), atm + count + 1);
  }, [chain, count]);

  const dCE = (r: ChainRow) =>
    tf === 0 ? r.call.oiChg : win[String(Math.round(r.strike))]?.ceOiChg ?? 0;
  const dPE = (r: ChainRow) =>
    tf === 0 ? r.put.oiChg : win[String(Math.round(r.strike))]?.peOiChg ?? 0;

  const stats = useMemo(() => {
    let maxOI = 1;
    let maxCallOI = { v: -1, k: -1 };
    let maxPutOI = { v: -1, k: -1 };
    for (const r of rows) {
      maxOI = Math.max(maxOI, r.call.oi, r.put.oi);
      if (r.call.oi > maxCallOI.v) maxCallOI = { v: r.call.oi, k: r.strike };
      if (r.put.oi > maxPutOI.v) maxPutOI = { v: r.put.oi, k: r.strike };
    }
    return { maxOI, resistance: maxCallOI.k, floor: maxPutOI.k };
  }, [rows]);

  // total Call / Put OI across the visible strike window (for the donut)
  const oiTotals = useMemo(() => {
    let ce = 0, pe = 0;
    for (const r of rows) {
      ce += r.call.oi || 0;
      pe += r.put.oi || 0;
    }
    return { ce, pe, pcr: ce ? pe / ce : null };
  }, [rows]);

  const flow = useMemo(() => {
    let ceAdd = 0, ceCut = 0, peAdd = 0, peCut = 0, maxChg = 1;
    for (const r of rows) {
      const c = tf === 0 ? r.call.oiChg : win[String(Math.round(r.strike))]?.ceOiChg ?? 0;
      const p = tf === 0 ? r.put.oiChg : win[String(Math.round(r.strike))]?.peOiChg ?? 0;
      maxChg = Math.max(maxChg, Math.abs(c), Math.abs(p));
      if (c >= 0) ceAdd += c; else ceCut += c;
      if (p >= 0) peAdd += p; else peCut += p;
    }
    return { ceAdd, ceCut, peAdd, peCut, maxChg };
  }, [rows, win, tf]);

  // gamma-flip: strike where cumulative dealer gamma exposure crosses zero.
  // Read from the backend's chain.gammaFlip (computed over the full ATM±30
  // window, same figure the GEX dashboard below and Chart.tsx's price-line
  // use) rather than recomputing from `rows` -- `rows` is whatever strike
  // slice the zoom control currently shows, and computing the crossing over
  // a narrower/shifting window made the marker jump or vanish purely from
  // zooming, not from any real change in dealer positioning. Mapped onto
  // the visible columns' fractional index the same way spotMark is below;
  // hidden (not clamped to an edge) when the flip strike is off-screen, so
  // it never shows a false position.
  const gammaFlip = useMemo(() => {
    if (chain?.gammaFlip == null || rows.length < 2) return null;
    const gf = chain.gammaFlip;
    if (gf < rows[0].strike || gf > rows[rows.length - 1].strike) return null;
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i].strike;
      const b = rows[i + 1].strike;
      if (gf >= a && gf <= b) return { strike: gf, index: i + (gf - a) / (b - a || 1) };
    }
    return null;
  }, [chain?.gammaFlip, rows]);

  // current spot / close: fractional column index for a vertical marker line
  const spotMark = useMemo(() => {
    if (!chain || rows.length < 2) return null;
    const sp = chain.liveSpot?.ltp ?? chain.spot;
    if (sp <= rows[0].strike) return { index: 0, spot: sp };
    if (sp >= rows[rows.length - 1].strike) return { index: rows.length - 1, spot: sp };
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i].strike;
      const b = rows[i + 1].strike;
      if (sp >= a && sp <= b) return { index: i + (sp - a) / (b - a || 1), spot: sp };
    }
    return null;
  }, [rows, chain]);

  // ---- overall OI-analysis verdict (bullish / bearish / neutral) ----
  const verdict = useMemo(() => {
    if (!chain) return null;
    return scoreOI({
      pcr: chain.pcr,
      maxPain: chain.maxPain,
      spot: chain.liveSpot?.ltp ?? chain.spot,
      strikeStep: chain.strikeStep || 50,
      resistance: stats.resistance,
      floor: stats.floor,
      ...flow,
    });
  }, [chain, flow, stats]);

  useEffect(() => {
    didCenter.current = false;
  }, [chain?.symbol, chain?.expiry, count]);
  useEffect(() => {
    if (didCenter.current || !scrollRef.current || rows.length === 0 || !chain)
      return;
    const i = rows.findIndex((r) => r.strike === chain.atmStrike);
    if (i >= 0) {
      const el = scrollRef.current;
      el.scrollLeft = i * COLW - el.clientWidth / 2 + COLW / 2;
      didCenter.current = true;
    }
  }, [rows, chain, COLW, layout]);

  // resample the raw ~15s poll samples into one row per intraTf-minute
  // bucket (last sample in the bucket wins, like a candle's close) — raw
  // cadence is far too dense to read as a table, and pretty noisy as a
  // chart too. A real hook, so it has to sit with the others above the
  // early returns below, not down with the (non-hook) *El render IIFEs.
  const intraGexBuckets = useMemo(() => {
    const bucketS = intraTf * 60;
    const byBucket = new Map<number, { t: number; spot: number; netGex: number; gammaFlip: number | null }>();
    for (const p of intraGexPts) {
      const b = Math.floor(p.t / bucketS) * bucketS;
      byBucket.set(b, p); // later (more recent) sample in the same bucket overwrites
    }
    return [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([bucketT, p]) => ({ ...p, bucketT }));
  }, [intraGexPts, intraTf]);

  if (chainError && !chain)
    return <div className="flex h-full items-center justify-center p-8 text-sm text-down">{chainError}</div>;
  if (!chain)
    return <div className="flex h-full items-center justify-center text-term-dim">loading…</div>;

  const spot = chain.liveSpot?.ltp ?? chain.spot;
  const oiMax = stats.maxOI;
  const chgMax = flow.maxChg;

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom((z) => zClamp(z * (e.deltaY < 0 ? 1.12 : 0.89)));
  };

  const Sw = ({ c, hollow }: { c: string; hollow?: boolean }) => (
    <span
      className="inline-block h-2.5 w-3.5 rounded-sm align-middle"
      style={hollow ? { boxShadow: `inset 0 0 0 1.5px ${c}` } : { background: c }}
    />
  );

  // ---- the horizontal column chart ----
  const TAG = 20; // px: WALL/FLOOR tag row (h-4) + pt-1 above the plot
  const LBL = 56; // px: rotated strike-label strip (h-14) below the plot
  const diverging = metric === "chg";
  // Y-axis tick values + their pixel offset from the container's bottom edge
  const axisTicks = (diverging
    ? [1, 0.5, 0, -0.5, -1].map((f) => ({ v: f * chgMax, mid: true }))
    : [1, 0.75, 0.5, 0.25, 0].map((f) => ({ v: f * oiMax, mid: false }))
  ).map(({ v }) => ({
    v,
    bottom: diverging
      ? LBL + AREA / 2 + (v / (chgMax || 1)) * (AREA / 2)
      : LBL + (v / (oiMax || 1)) * AREA,
  }));

  const PLOT_H = TAG + AREA + LBL;
  const chartEl = (
    <div
      className={`w-full p-3 ${
        isMobile ? "overflow-x-auto" : "min-h-0 flex-1 overflow-auto"
      }`}
    >
      <div className="flex items-end" style={{ minHeight: "100%" }}>
        {/* Y axis — OI (or ΔOI) values */}
        <div
          className="relative w-12 shrink-0 border-r border-term-border/60"
          style={{ height: PLOT_H }}
        >
          {axisTicks.map((t, i) => (
            <div
              key={i}
              className="absolute right-1 translate-y-1/2 text-[9px] leading-none text-term-dim"
              style={{ bottom: t.bottom }}
            >
              {diverging && t.v > 0 ? "+" : ""}
              {compact(t.v)}
            </div>
          ))}
          <div className="absolute right-1 text-[8px] uppercase tracking-wide text-term-dim" style={{ bottom: LBL - 12 }}>
            {diverging ? "ΔOI" : "OI"}
          </div>
        </div>

        {/* scrollable bars */}
        <div ref={scrollRef} onWheel={onWheel} className="min-w-0 flex-1 overflow-x-auto">
      <div
        className="relative flex items-end border border-term-border bg-term-panel/30"
        style={{ minWidth: rows.length * COLW, height: PLOT_H }}
      >
        {axisTicks.map((t, i) => (
          <div
            key={"g" + i}
            className="pointer-events-none absolute inset-x-0 border-t border-term-border/25"
            style={{ bottom: t.bottom }}
          />
        ))}
        {gammaFlip && (
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-10 border-l-2 border-dashed border-fuchsia-400"
            style={{ left: 12 + gammaFlip.index * COLW + COLW / 2 }}
            title={`Gamma flip ≈ ${sk(gammaFlip.strike)}`}
          >
            <span className="absolute -top-0 left-1 whitespace-nowrap rounded-sm bg-fuchsia-500 px-1 text-[8px] font-bold text-white">
              γ-flip {sk(gammaFlip.strike)}
            </span>
          </div>
        )}
        {spotMark && (
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-20 border-l-2 border-sky-400"
            style={{ left: 12 + spotMark.index * COLW + COLW / 2 }}
            title={`Spot / close ${nf(spotMark.spot, 1)}`}
          >
            <span className="absolute bottom-0 left-1 whitespace-nowrap rounded-sm bg-sky-500 px-1 text-[8px] font-bold text-white">
              ● spot {nf(spotMark.spot, 1)}
            </span>
          </div>
        )}
        {rows.map((r) => {
          const isATM = r.strike === chain.atmStrike;
          const isRes = r.strike === stats.resistance;
          const isFloor = r.strike === stats.floor;
          const near = Math.abs(r.strike - spot) < (chain.strikeStep || 50) * 0.5;
          const cChg = dCE(r);
          const pChg = dPE(r);

          let content: React.ReactNode;
          if (metric === "oi") {
            content = (
              <div className="flex items-end justify-center gap-[3px]" style={{ height: AREA }}>
                <div
                  title={`Call OI ${compact(r.call.oi)} @ ${r.strike}`}
                  className="rounded-t-sm"
                  style={{ width: BARW, height: (r.call.oi / oiMax) * AREA, background: CALL_OI }}
                />
                <div
                  title={`Put OI ${compact(r.put.oi)} @ ${r.strike}`}
                  className="rounded-t-sm"
                  style={{ width: BARW, height: (r.put.oi / oiMax) * AREA, background: PUT_OI }}
                />
              </div>
            );
          } else if (metric === "chg") {
            const half = AREA / 2;
            const cH = (Math.abs(cChg) / chgMax) * half;
            const pH = (Math.abs(pChg) / chgMax) * half;
            // candle convention: OI added = SOLID body (up); OI reduced =
            // HOLLOW body (down) — so add vs cut reads by shape, not colour.
            const col = (up: boolean, h: number, label: string, delta: number) => (
              <div className="flex flex-col" style={{ width: BARW, height: AREA }}>
                <div className="flex flex-1 items-end justify-center">
                  {up && (
                    <div
                      title={`${label} +${compact(delta)} · OI added`}
                      className="rounded-t-sm"
                      style={{ width: BARW, height: Math.max(h > 0 ? 2 : 0, h), background: OI_ADD }}
                    />
                  )}
                </div>
                <div className="flex flex-1 items-start justify-center">
                  {!up && (
                    <div
                      title={`${label} ${compact(delta)} · OI reduced`}
                      className="rounded-b-sm"
                      style={{
                        width: BARW,
                        height: Math.max(h > 0 ? 2 : 0, h),
                        background: "transparent",
                        boxShadow: `inset 0 0 0 1.5px ${OI_CUT}`,
                      }}
                    />
                  )}
                </div>
              </div>
            );
            content = (
              <div className="relative flex justify-center gap-[3px]" style={{ height: AREA }}>
                <div className="absolute inset-x-0 border-t border-term-dim/60" style={{ top: half }} />
                {/* green = OI added (up), red = OI reduced (down); left bar = Call, right = Put */}
                {col(cChg >= 0, cH, "Call ΔOI", cChg)}
                {col(pChg >= 0, pH, "Put ΔOI", pChg)}
              </div>
            );
          } else {
            // Sensibull "OI Change" style: the bar spans max(start, now) OI in
            // the leg's own colour. The part that changed over the window is
            // hatched — bright hatch = OI increase, pale hatch = OI decrease.
            const seg = (
              nowOI: number,
              chg: number,
              base: string,
              bright: string,
              pale: string,
              title: string
            ) => {
              const startOI = Math.max(0, nowOI - chg);
              const hiH = Math.min(AREA, (Math.max(nowOI, startOI) / oiMax) * AREA);
              const loH = Math.min(hiH, (Math.min(nowOI, startOI) / oiMax) * AREA);
              const chgH = hiH - loH;
              const inc = chg >= 0;
              return (
                <div
                  title={title}
                  className="flex flex-col justify-end overflow-hidden rounded-t-sm"
                  style={{ width: BARW, height: Math.max(2, hiH) }}
                >
                  {chgH > 1 && (
                    <div
                      style={{
                        height: Math.max(2, chgH),
                        backgroundColor: inc ? base : "transparent",
                        backgroundImage: `repeating-linear-gradient(45deg, ${
                          inc ? bright : pale
                        } 0 2px, transparent 2px 4.5px)`,
                        borderTop: `1.5px solid ${inc ? bright : pale}`,
                      }}
                    />
                  )}
                  <div style={{ flex: 1, background: base }} />
                </div>
              );
            };
            content = (
              <div className="flex items-end justify-center gap-[3px]" style={{ height: AREA }}>
                {seg(
                  r.call.oi,
                  cChg,
                  CALL_OI,
                  "#f87171",
                  "rgba(185,28,28,0.45)",
                  `Call OI ${compact(r.call.oi)} · Δ ${compact(cChg)}`
                )}
                {seg(
                  r.put.oi,
                  pChg,
                  PUT_OI,
                  "#4ade80",
                  "rgba(21,128,61,0.45)",
                  `Put OI ${compact(r.put.oi)} · Δ ${compact(pChg)}`
                )}
              </div>
            );
          }

          return (
            <div
              key={r.strike}
              className={`flex flex-col items-center border-r border-term-border/40 last:border-r-0 ${
                isRes
                  ? "bg-down/10 ring-1 ring-inset ring-down/50"
                  : isFloor
                  ? "bg-up/10 ring-1 ring-inset ring-up/50"
                  : isATM
                  ? "bg-term-accent/10"
                  : ""
              }`}
              style={{ width: COLW }}
            >
              <div className="flex h-4 w-full items-end justify-center">
                {isRes && (
                  <span className="whitespace-nowrap rounded-sm bg-down px-1 text-[8px] font-bold leading-tight text-white">
                    WALL
                  </span>
                )}
                {isFloor && (
                  <span className="whitespace-nowrap rounded-sm bg-up px-1 text-[8px] font-bold leading-tight text-white">
                    FLOOR
                  </span>
                )}
              </div>
              <div className="w-full pt-1">{content}</div>
              <div className="flex h-14 w-full items-center justify-center border-t border-term-border/60 bg-term-panel/40">
                <div
                  className={`num -rotate-90 whitespace-nowrap text-[12px] leading-none ${
                    isRes
                      ? "font-bold text-down"
                      : isFloor
                      ? "font-bold text-up"
                      : isATM || near
                      ? "font-bold text-term-accent"
                      : "text-term-dim"
                  }`}
                >
                  {sk(r.strike)}
                </div>
              </div>
            </div>
          );
        })}
          </div>
        </div>
      </div>
    </div>
  );

  // ---- OI ladder: per strike, a solid OI bar and a separate thin ΔOI bar on
  // each side, figures outside the bars, a legend and a spot line. (It used to
  // paint the green/red ΔOI "cap" over OI bars that are themselves red/green.)
  const tfName = tf === 0 ? "since open" : `last ${tf}m`;
  const signedK = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${compact(Math.abs(v))}`;
  // index of the first strike above spot: the spot line goes just before it
  const spotRow = rows.findIndex((r) => r.strike > spot);
  // the strikes where the most call / put OI was ADDED over the chosen window
  const maxAdd = (() => {
    let ce = { k: 0, v: 0 };
    let pe = { k: 0, v: 0 };
    for (const r of rows) {
      const c = dCE(r);
      const p = dPE(r);
      if (c > ce.v) ce = { k: r.strike, v: c };
      if (p > pe.v) pe = { k: r.strike, v: p };
    }
    return { ce: ce.v > 0 ? ce.k : null, pe: pe.v > 0 ? pe.k : null };
  })();
  const jumpTo = (k: number | "spot") => {
    const el =
      k === "spot"
        ? layout === "table"
          ? tableSpotRef.current
          : spotRef.current
        : jumpBoxRef.current?.querySelector<HTMLElement>(`[data-strike="${k}"]`);
    el?.scrollIntoView({ block: "center" });
    if (k !== "spot") {
      setFlash(k);
      window.clearTimeout(flashT.current);
      flashT.current = window.setTimeout(() => setFlash(null), 1600);
    }
  };
  const chip = "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums";
  const jumpBar = (
    <div className="no-scrollbar flex items-center gap-1 overflow-x-auto normal-case tracking-normal">
      <span className="shrink-0 text-[10px] font-medium text-term-dim">Go to</span>
      <button onClick={() => jumpTo("spot")} className={`${chip} border-term-accent/60 text-term-accent`}>
        ⌖ Spot
      </button>
      {stats.resistance > 0 && (
        <button onClick={() => jumpTo(stats.resistance)} className={`${chip} border-down/50 text-down`} title="most call OI">
          R {sk(stats.resistance)}
        </button>
      )}
      {stats.floor > 0 && (
        <button onClick={() => jumpTo(stats.floor)} className={`${chip} border-up/50 text-up`} title="most put OI">
          S {sk(stats.floor)}
        </button>
      )}
      {maxAdd.ce != null && (
        <button onClick={() => jumpTo(maxAdd.ce!)} className={`${chip} border-down/50 text-down`} title={`most call OI added (${tfName})`}>
          +C {sk(maxAdd.ce)}
        </button>
      )}
      {maxAdd.pe != null && (
        <button onClick={() => jumpTo(maxAdd.pe!)} className={`${chip} border-up/50 text-up`} title={`most put OI added (${tfName})`}>
          +P {sk(maxAdd.pe)}
        </button>
      )}
    </div>
  );
  const spotLine = (
    <div ref={spotRef} className="flex items-center gap-2 px-3 py-0.5 text-[10px] font-semibold text-term-accent">
      <span className="h-px flex-1 bg-term-accent/60" />
      spot {nf(spot, 1)}
      <span className="h-px flex-1 bg-term-accent/60" />
    </div>
  );
  const strikeCell = (r: ChainRow) => {
    const isRes = r.strike === stats.resistance;
    const isFloor = r.strike === stats.floor;
    return (
      <div
        className={`flex items-center justify-center gap-1 px-2 text-[13px] tabular-nums ${
          isRes ? "font-bold text-down" : isFloor ? "font-bold text-up" : r.strike === chain?.atmStrike ? "font-bold text-term-accent" : "text-term-text"
        }`}
      >
        {sk(r.strike)}
        {isRes && <span className="rounded bg-down/15 px-1 text-[9px]">R</span>}
        {isFloor && <span className="rounded bg-up/15 px-1 text-[9px]">S</span>}
      </div>
    );
  };

  const hbar = (pct: number, col: string, label: string, side: "call" | "put", thin: boolean, tone?: string) => (
    <div className={`flex w-full items-center gap-1.5 ${side === "put" ? "flex-row-reverse" : ""}`}>
      <span
        className={`w-12 shrink-0 tabular-nums leading-tight ${side === "call" ? "text-right" : "text-left"} ${
          thin ? "text-[10px]" : "text-[11px] font-semibold"
        } ${tone ?? "text-term-text"}`}
      >
        {label}
      </span>
      <div className={`relative flex-1 ${thin ? "h-1" : "h-2.5"}`}>
        <span
          className={`absolute top-0 h-full ${side === "call" ? "right-0 rounded-l" : "left-0 rounded-r"}`}
          style={{ width: `${Math.min(100, pct)}%`, background: col }}
        />
      </div>
    </div>
  );
  // lakhs on both sides (compact() mixed K and L: 7.0K calls beside 13.24L puts)
  const ldp = stats.maxOI < 10e5 ? 2 : 1;
  const lk = (v: number) => nf(v / 1e5, ldp);
  const slk = (v: number) => {
    const l = Math.round(v / 10 ** (5 - ldp)) / 10 ** ldp;
    return `${l > 0 ? "+" : l < 0 ? "−" : ""}${nf(Math.abs(l), ldp)}`;
  };
  const ladderEl = (
    <div ref={jumpBoxRef} className={isMobile ? "" : "min-h-0 flex-1 overflow-y-auto"}>
      {/* ONE sticky row: jump chips + legend (was three rows) */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel2 px-3 py-1">
        <div className="min-w-0 flex-1">{jumpBar}</div>
        <div className="flex items-center gap-x-2 text-[10px] text-term-dim">
          <span className="flex items-center gap-1"><Sw c={CALL_OI} /> call</span>
          <span className="flex items-center gap-1"><Sw c={PUT_OI} /> put</span>
          <span className="flex items-center gap-1"><Sw c={OI_ADD} /> added</span>
          <span className="flex items-center gap-1"><Sw c={OI_CUT} /> cut · {tf === 0 ? "day" : `${tf}m`}</span>
          <span>· lakhs</span>
        </div>
      </div>
      <div className={isMobile ? "" : "mx-auto max-w-3xl"}>
      {rows.map((r, i) => {
        const cChg = dCE(r);
        const pChg = dPE(r);
        return (
          <Fragment key={r.strike}>
            {i === spotRow && spotLine}
            <div
              data-strike={r.strike}
              className={`grid grid-cols-[1fr_auto_1fr] items-center border-b border-term-border/50 py-0.5 transition-colors ${
                flash === r.strike ? "bg-term-accent/25" : r.strike === chain?.atmStrike ? "bg-term-accent/[0.06]" : ""
              }`}
            >
              <div className="flex flex-col gap-0.5 pl-2">
                {hbar((r.call.oi / stats.maxOI) * 100, CALL_OI, lk(r.call.oi), "call", false)}
                {hbar((Math.abs(cChg) / flow.maxChg) * 100, cChg >= 0 ? OI_ADD : OI_CUT, slk(cChg), "call", true, cChg >= 0 ? "text-up" : "text-down")}
              </div>
              {strikeCell(r)}
              <div className="flex flex-col gap-0.5 pr-2">
                {hbar((r.put.oi / stats.maxOI) * 100, PUT_OI, lk(r.put.oi), "put", false)}
                {hbar((Math.abs(pChg) / flow.maxChg) * 100, pChg >= 0 ? OI_ADD : OI_CUT, slk(pChg), "put", true, pChg >= 0 ? "text-up" : "text-down")}
              </div>
            </div>
          </Fragment>
        );
      })}
      {spotRow === -1 && rows.length > 0 && spotLine}
      </div>
    </div>
  );

  // ---- the strike TABLE: every strike as a bordered grid row, OI in lakhs
  // with a bar inside the OI cell (call bars grow toward the strike from the
  // left, put bars from the right), change over the chosen window, R / S on
  // the biggest call / put strike, and the spot line between strikes ----
  // lakhs: 1 decimal, 2 when the biggest strike is under 10 lakh (SENSEX /
  // BANKEX / stocks -- with 1 decimal most of their strikes read 0.0)
  const dp = stats.maxOI < 10e5 ? 2 : 1;
  const L1 = (v: number) => nf(v / 1e5, dp);
  const S1 = (v: number) => {
    const l = Math.round(v / 10 ** (5 - dp)) / 10 ** dp; // rounded first, so a tiny change reads 0.0, not +0.0
    return `${l > 0 ? "+" : l < 0 ? "−" : ""}${nf(Math.abs(l), dp)}`;
  };
  const tone = (v: number, pos: string, neg: string) => (v > 0 ? pos : v < 0 ? neg : "text-term-dim");
  const GRID = "w-full border-separate border-spacing-0 text-[12px] tabular-nums [&_tr>*:first-child]:border-l";
  const GTH =
    "sticky top-0 z-10 border-b border-r border-t border-term-dim/50 bg-term-panel2 px-1.5 py-1 text-[10px] font-medium uppercase tracking-wide text-term-dim";
  const GTD = "border-b border-r border-term-dim/50 px-1.5 py-1";
  const WTH = GTH.replace("sticky top-0 z-10 ", ""); // headers of the small tables: not sticky
  const tableSpot = (
    <tr ref={tableSpotRef}>
      <td colSpan={5} className="border-b border-r border-term-dim/50 bg-term-accent/10 px-2 py-0.5 text-center text-[10px] font-semibold text-term-accent">
        ▶ spot {nf(spot, 1)}
      </td>
    </tr>
  );
  const tableEl = (
    <div ref={jumpBoxRef} className={isMobile ? "px-2 py-2" : "min-h-0 flex-1 overflow-y-auto px-3 pb-2"}>
      <table className={`${GRID} mx-auto max-w-3xl`}>
        <thead className="sticky top-0 z-10">
          <tr>
            <th colSpan={5} className="rounded-t-lg border-b border-r border-t border-term-dim/50 bg-term-panel2 px-1.5 py-1 text-left font-normal">
              {jumpBar}
            </th>
          </tr>
          <tr>
            <th className={`${WTH} text-right`}>Call OI</th>
            <th className={`${WTH} text-right`}>Chg</th>
            <th className={`${WTH} text-center`}>Strike</th>
            <th className={`${WTH} text-left`}>Chg</th>
            <th className={`${WTH} text-left`}>Put OI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const cChg = dCE(r);
            const pChg = dPE(r);
            const isRes = r.strike === stats.resistance;
            const isFloor = r.strike === stats.floor;
            const cPct = Math.min(100, (r.call.oi / stats.maxOI) * 100);
            const pPct = Math.min(100, (r.put.oi / stats.maxOI) * 100);
            return (
              <Fragment key={r.strike}>
                {i === spotRow && tableSpot}
                <tr
                  data-strike={r.strike}
                  className={
                    flash === r.strike
                      ? "[&>td]:bg-term-accent/25"
                      : r.strike === chain?.atmStrike
                      ? "[&>td]:bg-term-accent/[0.07]"
                      : ""
                  }
                >
                  <td
                    className={`${GTD} text-right ${isRes ? "font-bold text-down" : "text-term-text"}`}
                    style={{ backgroundImage: `linear-gradient(to left, ${CALL_OI}70 ${cPct}%, transparent ${cPct}%)` }}
                  >
                    {L1(r.call.oi)}
                  </td>
                  <td className={`${GTD} text-right ${tone(cChg, "text-down", "text-up")}`}>{S1(cChg)}</td>
                  <td
                    className={`${GTD} whitespace-nowrap text-center font-semibold ${
                      isRes ? "text-down" : isFloor ? "text-up" : "text-term-text"
                    }`}
                  >
                    {sk(r.strike)}
                    {isRes && <span className="ml-1 rounded bg-down/15 px-1 text-[9px]">R</span>}
                    {isFloor && <span className="ml-1 rounded bg-up/15 px-1 text-[9px]">S</span>}
                  </td>
                  <td className={`${GTD} text-left ${tone(pChg, "text-up", "text-down")}`}>{S1(pChg)}</td>
                  <td
                    className={`${GTD} text-left ${isFloor ? "font-bold text-up" : "text-term-text"}`}
                    style={{ backgroundImage: `linear-gradient(to right, ${PUT_OI}70 ${pPct}%, transparent ${pPct}%)` }}
                  >
                    {L1(r.put.oi)}
                  </td>
                </tr>
              </Fragment>
            );
          })}
          {spotRow === -1 && rows.length > 0 && tableSpot}
          {/* totals -- in the table itself (the separate totals strip above is
              hidden in this view, so the rows get that height back) */}
          <tr className="font-semibold [&>td]:bg-term-border/50">
            <td className={`${GTD} text-right text-term-text`}>{L1(oiTotals.ce)}</td>
            <td className={`${GTD} text-right ${tone(flow.ceAdd + flow.ceCut, "text-down", "text-up")}`}>
              {S1(flow.ceAdd + flow.ceCut)}
            </td>
            <td className={`${GTD} text-center text-term-text`}>Total · net</td>
            <td className={`${GTD} text-left ${tone(flow.peAdd + flow.peCut, "text-up", "text-down")}`}>
              {S1(flow.peAdd + flow.peCut)}
            </td>
            <td className={`${GTD} text-left text-term-text`}>{L1(oiTotals.pe)}</td>
          </tr>
          <tr className="[&>td]:bg-term-border/30">
            <td className={GTD} />
            <td className={`${GTD} text-right ${tone(flow.ceAdd, "text-down", "text-up")}`}>{S1(flow.ceAdd)}</td>
            <td className={`${GTD} text-center text-term-dim`}>Added</td>
            <td className={`${GTD} text-left ${tone(flow.peAdd, "text-up", "text-down")}`}>{S1(flow.peAdd)}</td>
            <td className={GTD} />
          </tr>
          <tr className="[&>td]:bg-term-border/30">
            <td className={`${GTD} rounded-bl-lg`} />
            <td className={`${GTD} text-right ${tone(flow.ceCut, "text-down", "text-up")}`}>{S1(flow.ceCut)}</td>
            <td className={`${GTD} text-center text-term-dim`}>Cut</td>
            <td className={`${GTD} text-left ${tone(flow.peCut, "text-up", "text-down")}`}>{S1(flow.peCut)}</td>
            <td className={`${GTD} rounded-br-lg`} />
          </tr>
        </tbody>
      </table>
      <div className="mx-auto mt-1.5 max-w-3xl text-[10px] leading-snug text-term-dim">
        OI in lakhs · strikes: {count === 0 ? "all" : `ATM ±${count}`} · Chg = {tfName} · bar = OI vs the biggest strike shown · R / S = most call / put OI · PCR{" "}
        {chain?.pcr != null ? nf(chain.pcr, 2) : "–"} (whole chain)
      </div>
    </div>
  );

  // ---- the WALLS view: where the biggest call strike (resistance) and put
  // strike (support) sat through today, as a step chart + the moves table ----
  const wallsEl = (() => {
    const pts = wallPts;
    if (pts === null) return <div className="p-6 text-center text-xs text-term-dim">loading walls…</div>;
    if (pts.length === 0)
      return (
        <div className="p-6 text-center text-xs leading-relaxed text-term-dim">
          No walls recorded yet today for {symbol} {expiry}.<br />
          They're recorded from the live chain every minute, 09:15–16:00 IST.
        </div>
      );
    const first = pts[0];
    const last = pts[pts.length - 1];
    const moves = pts.filter((p, i) => i === 0 || p.cw !== pts[i - 1].cw || p.pw !== pts[i - 1].pw);
    if (moves[moves.length - 1] !== last) moves.push(last);
    const cd = Math.sign(last.cw - first.cw);
    const pd = Math.sign(last.pw - first.pw);
    const read =
      (cd < 0 && pd <= 0) || (cd <= 0 && pd < 0)
        ? { t: "▼ Walls moving DOWN — sellers in control", c: "border-down/40 bg-down/15 text-down" }
        : (cd > 0 && pd >= 0) || (cd >= 0 && pd > 0)
        ? { t: "▲ Walls moving UP — buyers in control", c: "border-up/40 bg-up/15 text-up" }
        : cd === 0 && pd === 0
        ? { t: `◆ Walls holding — range ${sk(last.pw)}–${sk(last.cw)}`, c: "border-term-border bg-term-border/40 text-term-text" }
        : cd > 0
        ? { t: "◆ Range widening — both sides backing off", c: "border-term-border bg-term-border/40 text-term-text" }
        : { t: "◆ Range narrowing — walls closing in", c: "border-term-border bg-term-border/40 text-term-text" };

    // step chart
    const W = isMobile ? 360 : 720;
    const H = 200;
    const padL = 44;
    const padR = 8;
    const padT = 10;
    const padB = 20;
    const vals = pts.flatMap((p) => [p.cw, p.pw, ...(p.spot ? [p.spot] : [])]);
    const step = chain?.strikeStep || 50;
    const lo = Math.min(...vals) - step;
    const hi = Math.max(...vals) + step;
    const t0 = first.t;
    const t1 = Math.max(last.t, t0 + 60);
    const x = (t: number) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
    const y = (v: number) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
    const stepPath = (k: "cw" | "pw") =>
      pts.map((p, i) => (i === 0 ? `M${x(p.t)},${y(p[k])}` : `H${x(p.t)}V${y(p[k])}`)).join("") + `H${x(t1)}`;
    const spotPath = pts
      .filter((p) => p.spot)
      .map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.spot as number).toFixed(1)}`)
      .join("");
    const levels = [...new Set(pts.flatMap((p) => [p.cw, p.pw]))].sort((a, b) => b - a);
    const hours = pts.map((p) => p.t).filter((t) => istTime(t).endsWith(":15") || istTime(t).endsWith(":00"));
    const hourTicks = [...new Set(hours.map((t) => istTime(t).slice(0, 2)))].map((h) => pts.find((p) => istTime(p.t).startsWith(h))!.t);
    const arrowOf = (a: number, b: number) => (a > b ? "▲" : a < b ? "▼" : "");

    return (
      <div className={isMobile ? "flex flex-col gap-2 px-2 py-2" : "mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-2 overflow-y-auto px-3 py-2"}>
        <div className={`self-start rounded border px-2 py-1 text-[12px] font-bold ${read.c}`}>{read.t}</div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxWidth: W }}>
          {levels.map((v) => (
            <g key={v}>
              <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="rgb(var(--term-border))" strokeDasharray="2 3" />
              <text x={padL - 4} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="rgb(var(--term-dim))">
                {sk(v)}
              </text>
            </g>
          ))}
          {hourTicks.map((t) => (
            <text key={t} x={x(t)} y={H - 5} textAnchor="middle" fontSize="10" fill="rgb(var(--term-dim))">
              {istTime(t)}
            </text>
          ))}
          {spotPath && <path d={spotPath} fill="none" stroke="rgb(var(--term-dim))" strokeWidth="1.3" strokeDasharray="4 3" />}
          <path d={stepPath("cw")} fill="none" stroke="#ef4444" strokeWidth="2.2" />
          <path d={stepPath("pw")} fill="none" stroke="#22c55e" strokeWidth="2.2" />
        </svg>
        <div className="flex flex-wrap gap-x-3 text-[10px] text-term-dim">
          <span><span className="text-down">━</span> call wall (most call OI = resistance)</span>
          <span><span className="text-up">━</span> put wall (most put OI = support)</span>
          <span>┅ spot</span>
        </div>
        <table className={GRID}>
          <thead>
            <tr>
              <th className={`${WTH} rounded-tl-lg text-left`}>Now</th>
              <th className={`${WTH} text-right`}>Call wall</th>
              <th className={`${WTH} rounded-tr-lg text-right`}>Put wall</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={`${GTD} text-term-dim`}>Biggest</td>
              <td className={`${GTD} text-right font-semibold text-down`}>{sk(last.cw)} · {L1(last.cwOI)}L</td>
              <td className={`${GTD} text-right font-semibold text-up`}>{sk(last.pw)} · {L1(last.pwOI)}L</td>
            </tr>
            <tr>
              <td className={`${GTD} rounded-bl-lg text-term-dim`}>Next</td>
              <td className={`${GTD} text-right text-term-text`}>{last.cw2 != null ? `${sk(last.cw2)} · ${L1(last.cw2OI ?? 0)}L` : "–"}</td>
              <td className={`${GTD} rounded-br-lg text-right text-term-text`}>{last.pw2 != null ? `${sk(last.pw2)} · ${L1(last.pw2OI ?? 0)}L` : "–"}</td>
            </tr>
          </tbody>
        </table>
        <table className={GRID}>
          <thead>
            <tr>
              <th className={`${WTH} rounded-tl-lg text-left`}>Time</th>
              <th className={`${WTH} text-right`}>Spot</th>
              <th className={`${WTH} text-right`}>Call wall</th>
              <th className={`${WTH} rounded-tr-lg text-right`}>Put wall</th>
            </tr>
          </thead>
          <tbody>
            {moves.map((p, i) => {
              const prev = i ? moves[i - 1] : null;
              const lastRow = i === moves.length - 1;
              return (
                <tr key={p.t}>
                  <td className={`${GTD} text-term-dim ${lastRow ? "rounded-bl-lg" : ""}`}>
                    {istTime(p.t)}
                    {lastRow && p === last && i > 0 ? " · now" : ""}
                  </td>
                  <td className={`${GTD} text-right text-term-text`}>{p.spot ? nf(p.spot, 0) : "–"}</td>
                  <td className={`${GTD} text-right ${prev && p.cw !== prev.cw ? "font-bold text-down" : "text-term-text"}`}>
                    {prev && p.cw !== prev.cw ? `${arrowOf(p.cw, prev.cw)} ` : ""}
                    {sk(p.cw)}
                  </td>
                  <td
                    className={`${GTD} text-right ${prev && p.pw !== prev.pw ? "font-bold text-up" : "text-term-text"} ${
                      lastRow ? "rounded-br-lg" : ""
                    }`}
                  >
                    {prev && p.pw !== prev.pw ? `${arrowOf(p.pw, prev.pw)} ` : ""}
                    {sk(p.pw)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="text-[10px] leading-snug text-term-dim">
          One row each time a wall moved. Call wall stepping down = resistance coming closer (bearish); put wall stepping up =
          support rising (bullish).
        </div>
      </div>
    );
  })();

  // ---- OI donuts (total OI split + change-in-OI split) ----
  const donutEl = (() => {
    const { ce, pe } = oiTotals;
    // the donut's Call/Put split is intentionally windowed (±count strikes,
    // matches the "Total OI · N±ATM" label), but PCR itself is always quoted
    // across the whole chain (chain.pcr, same value as the header/top-bar) so
    // it doesn't jump around as you change the strike window
    const pcr = chain?.pcr ?? null;
    const tot = ce + pe;
    if (tot <= 0) return null;

    const dCEnet = flow.ceAdd + flow.ceCut; // net Call OI change over the window
    const dPEnet = flow.peAdd + flow.peCut; // net Put OI change
    const dtot = Math.abs(dCEnet) + Math.abs(dPEnet);
    const tfLbl = tf === 0 ? "since open" : `last ${tf}m`;

    const Row = ({ c, label, val }: { c: string; label: string; val: string }) => (
      <div className="flex items-center justify-between text-2xs">
        <span className="flex items-center gap-1">
          <Sw c={c} /> {label}
        </span>
        <span className="num text-term-text">{val}</span>
      </div>
    );

    return (
      <div
        className={`flex shrink-0 flex-col items-center gap-2 border-term-border p-3 ${
          isMobile ? "w-full border-t" : "overflow-y-auto border-r"
        }`}
        style={isMobile ? undefined : { width: donutW }}
      >
        {/* PCR: one small line, the size of the added / cut legend */}
        <div className="text-[10px] text-term-dim">
          PCR{" "}
          <span
            className={`font-semibold tabular-nums ${
              pcr == null ? "text-term-text" : pcr >= 1 ? "text-up" : "text-down"
            }`}
          >
            {pcr != null ? nf(pcr, 2) : "–"}
          </span>{" "}
          · whole chain
        </div>

        <div className="mt-1 w-full border-t border-term-border/50 pt-2 text-center text-2xs font-semibold uppercase tracking-wide text-term-dim">
          Change in OI · {tfLbl}
        </div>
        {dtot > 0 ? (
          <>
            <DeltaOIBars ceAdd={flow.ceAdd} ceCut={flow.ceCut} peAdd={flow.peAdd} peCut={flow.peCut} />
            <div className="flex w-full flex-wrap justify-center gap-x-3 text-[10px] text-term-dim">
              <span className="flex items-center gap-1">
                <Sw c={CALL_CHG} /> Call
              </span>
              <span className="flex items-center gap-1">
                <Sw c={PUT_CHG} /> Put
              </span>
              <span>▲ solid = OI added</span>
              <span>▼ faded = OI reduced</span>
            </div>
            <div className="w-full space-y-0.5">
              <Row
                c={CALL_CHG}
                label={`Call ${dCEnet >= 0 ? "written" : "unwound"}`}
                val={`${dCEnet >= 0 ? "+" : ""}${compact(dCEnet)}`}
              />
              <Row
                c={PUT_CHG}
                label={`Put ${dPEnet >= 0 ? "written" : "unwound"}`}
                val={`${dPEnet >= 0 ? "+" : ""}${compact(dPEnet)}`}
              />
            </div>
          </>
        ) : (
          <div className="text-2xs text-term-dim">no OI change yet</div>
        )}
      </div>
    );
  })();

  // ---- the Sensibull-style data table ----
  const frameToggle = (
    <div className="seg">
      <button onClick={() => setGexFrame("daily")} className={gexFrame === "daily" ? "on" : ""}>
        Daily
      </button>
      <button onClick={() => setGexFrame("intraday")} className={gexFrame === "intraday" ? "on" : ""}>
        Intraday
      </button>
    </div>
  );

  const intraTfToggle = (
    <div className="seg">
      {([3, 5, 15, 60, 240] as const).map((m) => (
        <button key={m} onClick={() => setIntraTf(m)} className={intraTf === m ? "on" : ""}>
          {m < 60 ? `${m}m` : `${m / 60}h`}
        </button>
      ))}
    </div>
  );

  // ---- Weekly GEX / intraday: dealer-gamma-exposure trend, either as daily
  // bars off NSE bhavcopy (real front-week per day, see gexPts above) or as
  // today's own live session — the same in-memory netGex/gammaFlip history
  // the PCR chart already polls, just not charted on its own before. ----
  const gexIntraEl = (() => {
    if (intraGexPts.length < 2)
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-xs text-term-dim">
          {frameToggle}
          <span>collecting intraday GEX for {symbol}… (last ~720 polled samples, persisted to disk)</span>
        </div>
      );
    const intraGexPtsAll = intraGexBuckets;
    if (gexView === "table") {
      return (
        <div className={`p-3 ${isMobile ? "h-[68vh]" : "min-h-0 flex-1 overflow-auto"}`}>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <span className="text-xs font-semibold text-term-text">{symbol} · Intraday GEX (today)</span>
            {frameToggle}
            <div className="seg">
              <button onClick={() => setGexView("chart")} className="">
                Chart
              </button>
              <button onClick={() => setGexView("table")} className="on">
                Table
              </button>
            </div>
            {intraTfToggle}
            <span className="ml-auto text-[9px] uppercase tracking-wide text-term-dim">
              {intraGexPtsAll.length} × {intraTf < 60 ? `${intraTf}m` : `${intraTf / 60}h`} buckets
            </span>
          </div>
          {isMobile && (
            <div className="mb-1 text-right text-[9px] uppercase tracking-wide text-term-dim">
              swipe to scroll →
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="num min-w-[540px] w-full text-xs">
              <thead className="sticky top-0 z-10 bg-term-panel2 text-[10px] uppercase text-term-dim">
                <tr className="[&>th]:border-b [&>th]:border-term-border [&>th]:px-2 [&>th]:py-1 [&>th]:text-right first:[&>th]:text-left">
                  <th className="sticky left-0 z-10 !text-left bg-term-panel2 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.5)]">
                    Time
                  </th>
                  <th>Spot</th>
                  <th>netGex</th>
                  <th>γ-flip</th>
                  <th>Gap to flip</th>
                  <th className="!text-center">Regime</th>
                </tr>
              </thead>
              <tbody>
                {[...intraGexPtsAll].reverse().map((p) => {
                  const gap = p.gammaFlip != null ? p.spot - p.gammaFlip : null;
                  const regimeUp = gap != null ? gap >= 0 : null;
                  return (
                    <tr key={p.bucketT} className="border-b border-term-border/40 hover:bg-term-accent/[0.06]">
                      <td className="sticky left-0 bg-term-bg px-2 py-1 text-left text-term-text shadow-[2px_0_4px_-2px_rgba(0,0,0,0.5)]">
                        {new Date(p.bucketT * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td className="px-2 py-1 text-right text-sky-400">{nf(p.spot, 1)}</td>
                      <td className={`px-2 py-1 text-right font-semibold ${p.netGex >= 0 ? "text-up" : "text-down"}`}>
                        {p.netGex >= 0 ? "+" : ""}
                        {compact(p.netGex)}
                      </td>
                      <td className="px-2 py-1 text-right text-fuchsia-400">
                        {p.gammaFlip != null ? nf(p.gammaFlip, 0) : "–"}
                      </td>
                      <td className={`px-2 py-1 text-right ${regimeUp == null ? "text-term-dim" : regimeUp ? "text-up" : "text-down"}`}>
                        {gap != null ? `${gap >= 0 ? "+" : ""}${nf(gap, 0)}` : "–"}
                      </td>
                      <td className="px-2 py-1 text-center">
                        {regimeUp != null && (
                          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${regimeUp ? "bg-up text-white" : "bg-down text-white"}`}>
                            {regimeUp ? "long-γ" : "short-γ"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    const W = 1000;
    const H = 320;
    const pad = { l: 56, r: 56, t: 20, b: 26 };
    const n = intraGexPtsAll.length;
    const withFlip = intraGexPtsAll.filter((p) => p.gammaFlip != null) as { t: number; spot: number; netGex: number; gammaFlip: number }[];
    const gexVals = intraGexPtsAll.map((p) => p.netGex);
    let glo = Math.min(0, ...gexVals);
    let ghi = Math.max(0, ...gexVals);
    const gPad = (ghi - glo) * 0.12 || 1;
    glo -= gPad;
    ghi += gPad;
    const prices = intraGexPtsAll.flatMap((p) => (p.gammaFlip != null ? [p.spot, p.gammaFlip] : [p.spot]));
    let plo = Math.min(...prices);
    let phi = Math.max(...prices);
    const pPad = (phi - plo) * 0.15 || 1;
    plo -= pPad;
    phi += pPad;
    const t0 = intraGexPtsAll[0].t;
    const t1 = intraGexPtsAll[n - 1].t || t0 + 1;
    const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - glo) / (ghi - glo || 1)) * (H - pad.t - pad.b);
    const yp = (v: number) => pad.t + (1 - (v - plo) / (phi - plo || 1)) * (H - pad.t - pad.b);
    const zeroY = y(0);
    // the poller isn't guaranteed to run continuously (deploy restarts,
    // backend downtime) and history persists across those gaps rather than
    // resetting -- break the line instead of drawing a straight connector
    // across a real gap, so a multi-hour outage doesn't look like a smooth move.
    // Scales with the bucket size: consecutive buckets are intraTf minutes
    // apart by construction, so the threshold has to clear that normal
    // spacing (3x it) rather than flagging every single bucket boundary.
    const GAP_S = intraTf * 60 * 3;
    const pathWithGaps = <T,>(pts: T[], tOf: (p: T) => number, vOf: (p: T) => number) => {
      let d = "";
      let prevT: number | null = null;
      for (const p of pts) {
        const t = tOf(p);
        d += `${prevT === null || t - prevT > GAP_S ? "M" : "L"}${x(t).toFixed(1)},${vOf(p).toFixed(1)} `;
        prevT = t;
      }
      return d.trim();
    };
    const gexPath = pathWithGaps(intraGexPtsAll, (p) => p.t, (p) => y(p.netGex));
    const spotPath = pathWithGaps(intraGexPtsAll, (p) => p.t, (p) => yp(p.spot));
    const flipPath = pathWithGaps(withFlip, (p) => p.t, (p) => yp(p.gammaFlip));
    const last = intraGexPtsAll[n - 1];
    const longGamma = last.gammaFlip != null ? last.spot >= last.gammaFlip : null;
    const fmtT = (t: number) =>
      new Date(t * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    return (
      <div className={`overflow-hidden p-3 ${isMobile ? "h-[68vh]" : "min-h-0 flex-1"}`}>
        <div className="mb-1 flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold text-term-text">{symbol} · Intraday GEX (today)</span>
          <span className={`num text-lg font-bold ${longGamma == null ? "text-term-text" : longGamma ? "text-up" : "text-down"}`}>
            {compact(last.netGex)}
          </span>
          {longGamma != null && (
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${longGamma ? "bg-up text-white" : "bg-down text-white"}`}>
              {longGamma ? "long-γ / dampening" : "short-γ / amplifying"}
            </span>
          )}
          <div className="seg">
            <button onClick={() => setGexView("chart")} className="on">
              Chart
            </button>
            <button onClick={() => setGexView("table")} className="">
              Table
            </button>
          </div>
          {frameToggle}
          {intraTfToggle}
          <span className="ml-auto text-[9px] uppercase tracking-wide text-term-dim">
            session history · last ~720 polled samples (~3h continuous)
          </span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[calc(100%-2rem)] w-full">
          <line x1={pad.l} x2={W - pad.r} y1={zeroY} y2={zeroY} stroke="currentColor" strokeOpacity={0.35} className="text-term-dim" />
          <text x={4} y={zeroY + 3} fontSize={10} className="fill-term-dim">0</text>
          <text x={4} y={y(ghi) + 8} fontSize={10} className="fill-term-dim">{compact(ghi)}</text>
          <text x={4} y={y(glo) - 2} fontSize={10} className="fill-term-dim">{compact(glo)}</text>
          {[phi - (phi - plo) * 0.1, (plo + phi) / 2, plo + (phi - plo) * 0.1].map((v, i) => (
            <text key={i} x={W - pad.r + 4} y={yp(v) + 3} fontSize={9} className="fill-sky-400/80">
              {nf(v, 0)}
            </text>
          ))}
          {[t0, (t0 + t1) / 2, t1].map((t, i) => (
            <text key={i} x={x(t)} y={H - 8} fontSize={11} textAnchor="middle" className="fill-term-dim">
              {fmtT(t)}
            </text>
          ))}
          <path d={gexPath} fill="none" stroke={longGamma === false ? "#ef4444" : "#22c55e"} strokeWidth={2} />
          {withFlip.length > 1 && (
            <path d={flipPath} fill="none" stroke="#e879f9" strokeWidth={1.5} strokeDasharray="4 3" strokeOpacity={0.9} />
          )}
          <path d={spotPath} fill="none" stroke="#38bdf8" strokeWidth={1.5} strokeOpacity={0.9} />
          <circle cx={x(last.t)} cy={y(last.netGex)} r={3.5} fill={longGamma === false ? "#ef4444" : "#22c55e"} />
          <circle cx={x(last.t)} cy={yp(last.spot)} r={3} fill="#38bdf8" />
        </svg>
      </div>
    );
  })();

  // ---- Weekly GEX: daily net dealer-gamma-exposure trend (bars) with
  // spot + gamma-flip level overlaid (lines) ----
  const gexEl = (() => {
    if (gexFrame === "intraday") return gexIntraEl;
    if (gexErr)
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-xs text-down">
          {frameToggle}
          <span>{gexErr}</span>
        </div>
      );
    if (gexPts.length < 2)
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-xs text-term-dim">
          {frameToggle}
          <span>loading daily GEX history for {symbol}…</span>
        </div>
      );
    const W = 1000;
    const H = 320;
    const pad = { l: 56, r: 56, t: 20, b: 34 };
    const n = gexPts.length;
    const gexVals = gexPts.map((p) => p.netGex);
    let glo = Math.min(0, ...gexVals);
    let ghi = Math.max(0, ...gexVals);
    const gPad = (ghi - glo) * 0.12 || 1;
    glo -= gPad;
    ghi += gPad;
    const prices = gexPts.flatMap((p) => [p.spot, p.gammaFlip]);
    let plo = Math.min(...prices);
    let phi = Math.max(...prices);
    const pPad = (phi - plo) * 0.15 || 1;
    plo -= pPad;
    phi += pPad;
    const x = (i: number) => pad.l + (n > 1 ? (i / (n - 1)) * (W - pad.l - pad.r) : (W - pad.l - pad.r) / 2);
    const y = (v: number) => pad.t + (1 - (v - glo) / (ghi - glo || 1)) * (H - pad.t - pad.b);
    const yp = (v: number) => pad.t + (1 - (v - plo) / (phi - plo || 1)) * (H - pad.t - pad.b);
    const zeroY = y(0);
    const spotPath = gexPts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yp(p.spot).toFixed(1)}`).join(" ");
    const flipPath = gexPts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yp(p.gammaFlip).toFixed(1)}`).join(" ");
    const last = gexPts[n - 1];
    const longGamma = last.spot >= last.gammaFlip;
    const barW = Math.max(6, Math.min(28, ((W - pad.l - pad.r) / n) * 0.55));
    const ddmmm = (d: string) => {
      const [, m, day] = d.split("-");
      const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return `${day}-${names[Number(m)]}`;
    };
    return (
      <div className={`overflow-hidden p-3 ${isMobile ? "h-[68vh]" : "min-h-0 flex-1"}`}>
        {/* headline: what it is + today's number + the one-word verdict */}
        <div className="mb-1 flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold text-term-text">{symbol} · Weekly GEX Trend</span>
          <span className={`num text-lg font-bold ${longGamma ? "text-up" : "text-down"}`}>
            {compact(last.netGex)}
          </span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${longGamma ? "bg-up text-white" : "bg-down text-white"}`}>
            {longGamma ? "long-γ / dampening" : "short-γ / amplifying"}
          </span>
          <div className="seg">
            <button onClick={() => setGexView("chart")} className={gexView === "chart" ? "on" : ""}>
              Chart
            </button>
            <button onClick={() => setGexView("table")} className={gexView === "table" ? "on" : ""}>
              Table
            </button>
          </div>
          {frameToggle}
          <span className="ml-auto text-[9px] uppercase tracking-wide text-term-dim">
            {gexSource === "upstox" ? "Upstox approximation" : "NSE bhavcopy · real front-week"}
          </span>
        </div>
        {/* legend: tied to the actual line styles in the chart below */}
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-term-dim">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-3.5 rounded-sm align-middle" style={{ background: "#22c55e" }} />
            <span className="inline-block h-2.5 w-3.5 rounded-sm align-middle" style={{ background: "#ef4444" }} />
            daily netGex (green ≥0 · red &lt;0)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0 w-4 border-t-2 border-dashed align-middle" style={{ borderColor: "#e879f9" }} />
            γ-flip <span className="num text-fuchsia-400">{nf(last.gammaFlip, 0)}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0 w-4 border-t-2 align-middle" style={{ borderColor: "#38bdf8" }} />
            spot <span className="num text-sky-400">{nf(last.spot, 1)}</span>
          </span>
        </div>
        {gexView === "chart" ? (
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[calc(100%-2rem)] w-full">
            <line x1={pad.l} x2={W - pad.r} y1={zeroY} y2={zeroY} stroke="currentColor" strokeOpacity={0.35} className="text-term-dim" />
            <text x={4} y={zeroY + 3} fontSize={10} className="fill-term-dim">0</text>
            <text x={4} y={y(ghi) + 8} fontSize={10} className="fill-term-dim">{compact(ghi)}</text>
            <text x={4} y={y(glo) - 2} fontSize={10} className="fill-term-dim">{compact(glo)}</text>
            {[phi - (phi - plo) * 0.1, (plo + phi) / 2, plo + (phi - plo) * 0.1].map((v, i) => (
              <text key={i} x={W - pad.r + 4} y={yp(v) + 3} fontSize={9} className="fill-sky-400/80">
                {nf(v, 0)}
              </text>
            ))}
            {gexPts.map((p, i) => {
              const up = p.netGex >= 0;
              const y1 = y(Math.max(0, p.netGex));
              const y2 = y(Math.min(0, p.netGex));
              return (
                <g key={p.date}>
                  <rect
                    x={x(i) - barW / 2}
                    y={y1}
                    width={barW}
                    height={Math.max(1.5, y2 - y1)}
                    rx={1.5}
                    fill={up ? "#22c55e" : "#ef4444"}
                    fillOpacity={0.85}
                  >
                    <title>
                      {p.date}: netGex {compact(p.netGex)}, spot {nf(p.spot, 1)}, γ-flip {nf(p.gammaFlip, 0)}
                    </title>
                  </rect>
                  <text
                    x={x(i)}
                    y={H - pad.b + 14}
                    fontSize={9}
                    textAnchor="middle"
                    className="fill-term-dim"
                  >
                    {ddmmm(p.date)}
                  </text>
                </g>
              );
            })}
            <path d={flipPath} fill="none" stroke="#e879f9" strokeWidth={1.5} strokeDasharray="4 3" strokeOpacity={0.9} />
            <path d={spotPath} fill="none" stroke="#38bdf8" strokeWidth={2} />
            {gexPts.map((p, i) => (
              <circle key={p.date} cx={x(i)} cy={yp(p.spot)} r={2.5} fill="#38bdf8" />
            ))}
          </svg>
        ) : (
          <div className="h-[calc(100%-2rem)] w-full overflow-auto">
            {isMobile && (
              <div className="mb-1 text-right text-[9px] uppercase tracking-wide text-term-dim">
                swipe to scroll →
              </div>
            )}
            <table className="num min-w-[540px] w-full text-xs">
              <thead className="sticky top-0 z-10 bg-term-panel2 text-[10px] uppercase text-term-dim">
                <tr className="[&>th]:border-b [&>th]:border-term-border [&>th]:px-2 [&>th]:py-1 [&>th]:text-right first:[&>th]:text-left">
                  <th className="sticky left-0 z-10 !text-left bg-term-panel2 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.5)]">
                    Date
                  </th>
                  <th>Spot</th>
                  <th>netGex</th>
                  <th>γ-flip</th>
                  <th>Gap to flip</th>
                  <th className="!text-center">Regime</th>
                </tr>
              </thead>
              <tbody>
                {[...gexPts].reverse().map((p) => {
                  const gap = p.spot - p.gammaFlip;
                  const regimeUp = gap >= 0;
                  return (
                    <tr
                      key={p.date}
                      className="border-b border-term-border/40 hover:bg-term-accent/[0.06]"
                    >
                      <td className="sticky left-0 bg-term-bg px-2 py-1 text-left text-term-text shadow-[2px_0_4px_-2px_rgba(0,0,0,0.5)]">
                        {ddmmm(p.date)}
                      </td>
                      <td className="px-2 py-1 text-right text-sky-400">{nf(p.spot, 1)}</td>
                      <td className={`px-2 py-1 text-right font-semibold ${p.netGex >= 0 ? "text-up" : "text-down"}`}>
                        {p.netGex >= 0 ? "+" : ""}
                        {compact(p.netGex)}
                      </td>
                      <td className="px-2 py-1 text-right text-fuchsia-400">{nf(p.gammaFlip, 0)}</td>
                      <td className={`px-2 py-1 text-right ${regimeUp ? "text-up" : "text-down"}`}>
                        {gap >= 0 ? "+" : ""}
                        {nf(gap, 0)}
                      </td>
                      <td className="px-2 py-1 text-center">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                            regimeUp ? "bg-up text-white" : "bg-down text-white"
                          }`}
                        >
                          {regimeUp ? "long-γ" : "short-γ"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  })();

  // ---- Dealer Exposure: regime + IV/expected-move + aggregate greeks +
  // Call/Put and ITM/OTM OI split, all off the already-fetched chain (no
  // extra request — unlike weekly gex this needs no history, just today's
  // live rows) ----
  const dexEl = (() => {
    if (!chain) return null;
    let dex = 0, theta = 0, vega = 0, itmOI = 0, otmOI = 0;
    // chain.rows (the whole delivered chain), not the frontend "Strikes ±"
    // window (`rows`) -- ΓGEX beside these three sits at chain.netGex, the
    // backend's whole-chain figure, so DEX/Theta/Vega drifting with a
    // window selector meant for the OI bar chart would silently mismatch
    // their own neighbour in the same row.
    for (const r of chain.rows) {
      // same "call − put" dealer-exposure convention as the backend's own
      // netGex (processing.py) — NOT the gammaFlip walk above, which nets
      // the opposite way for its own, different purpose (finding the
      // zero-cross strike rather than one aggregate figure).
      dex += (r.call.delta ?? 0) * (r.call.oi ?? 0) - (r.put.delta ?? 0) * (r.put.oi ?? 0);
      theta += (r.call.theta ?? 0) * (r.call.oi ?? 0) - (r.put.theta ?? 0) * (r.put.oi ?? 0);
      vega += (r.call.vega ?? 0) * (r.call.oi ?? 0) - (r.put.vega ?? 0) * (r.put.oi ?? 0);
      // ITM/OTM per leg, not the row's own `moneyness` (that field is
      // call-centric — a strike below spot is a call ITM but a put OTM).
      if (r.strike < spot) { itmOI += r.call.oi || 0; otmOI += r.put.oi || 0; }
      else if (r.strike > spot) { otmOI += r.call.oi || 0; itmOI += r.put.oi || 0; }
    }
    const expMove = chain.atmIV && chain.dte != null
      ? spot * (chain.atmIV / 100) * Math.sqrt(Math.max(chain.dte, 0) / 365)
      : null;
    const shortGamma = gammaFlip ? spot < gammaFlip.strike : null;
    // whole-chain Call/Put OI (same tot_ce_oi/tot_pe_oi the backend derives
    // chain.pcr from), not oiTotals -- keeps this donut's Put/Call % in
    // agreement with the PCR figure at its own center, and with DEX/GEX/
    // Theta/Vega above now all reading the same whole-chain scope.
    const { ceOI: ce, peOI: pe } = chain.totals;
    const oiTot = ce + pe;
    const itmTot = itmOI + otmOI;

    const Tile = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
      <div className="rounded border border-term-border bg-term-bg/40 p-2">
        <div className="text-[9px] uppercase tracking-wide text-term-dim">{label}</div>
        <div className="num text-base font-bold text-term-text">{value}</div>
        {sub && <div className="text-[9px] text-term-dim">{sub}</div>}
      </div>
    );
    const Greek = ({ label, value, up }: { label: string; value: string; up: boolean | null }) => (
      <div className="rounded border border-term-border bg-term-bg/40 px-1 py-1.5 text-center">
        <div className="text-[9px] text-term-dim">{label}</div>
        <div className={`num text-xs font-bold ${up == null ? "text-term-text" : up ? "text-up" : "text-down"}`}>
          {value}
        </div>
      </div>
    );

    return (
      <div className={`p-3 ${isMobile ? "" : "min-h-0 flex-1 overflow-y-auto"}`}>
        <div
          className={`rounded-lg border p-3 ${
            shortGamma ? "border-down/25" : shortGamma == null ? "border-term-border" : "border-up/25"
          }`}
          style={{
            background: shortGamma
              ? "radial-gradient(120% 140% at 0% 0%, rgba(220,38,38,0.10), transparent 55%), linear-gradient(135deg, rgb(var(--term-panel2)), rgb(var(--term-bg)) 70%)"
              : shortGamma === false
              ? "radial-gradient(120% 140% at 0% 0%, rgba(22,163,74,0.10), transparent 55%), linear-gradient(135deg, rgb(var(--term-panel2)), rgb(var(--term-bg)) 70%)"
              : "linear-gradient(135deg, rgb(var(--term-panel2)), rgb(var(--term-bg)) 70%)",
          }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-term-text">{symbol} · Dealer Exposure</span>
            <span className="num text-xs font-bold text-term-text">{nf(spot, 1)}</span>
          </div>

          <div className={`flex gap-4 ${isMobile ? "flex-col" : "flex-row items-stretch"}`}>
          {/* stats table */}
          <div className={isMobile ? "" : "w-[380px] shrink-0"}>
            {gammaFlip && (
              <div
                className={`mb-2 flex items-center justify-between rounded border p-2.5 ${
                  shortGamma ? "border-down/40 bg-down/10" : "border-up/40 bg-up/10"
                }`}
                title="Below the gamma-flip strike dealers are short gamma and hedging amplifies moves; above it they're long gamma and hedging dampens moves."
              >
                <div>
                  <div className="text-[9px] uppercase tracking-wide text-term-dim">GEX regime</div>
                  <div className={`text-base font-extrabold ${shortGamma ? "text-down" : "text-up"}`}>
                    {shortGamma ? "Short-γ" : "Long-γ"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[9px] uppercase tracking-wide text-term-dim">Gamma flip</div>
                  <div className="num text-base font-extrabold text-fuchsia-400">{sk(gammaFlip.strike)}</div>
                </div>
              </div>
            )}

            <div className="mb-2 grid grid-cols-3 gap-2">
              <Tile label="PCR" value={nf(chain.pcr, 2)} />
              <Tile label="Max Pain" value={nf(chain.maxPain, 0)} />
              <Tile label="σ ATM IV" value={chain.atmIV ? `${nf(chain.atmIV, 1)}%` : "–"} />
              <Tile
                label="± Expected move"
                value={expMove ? `±${nf(expMove, 0)}` : "–"}
                sub={expMove ? `${nf((expMove / spot) * 100, 2)}% · ${nf(chain.dte, 1)}d` : undefined}
              />
              {chain.atmStraddle != null && <Tile label="ATM straddle" value={nf(chain.atmStraddle, 1)} />}
            </div>

            <div
              className="grid grid-cols-4 gap-1.5"
              title="Aggregate dealer exposure across the whole chain: Σ(call·OI − put·OI) per greek, same sign convention as netGex — assumes dealers are net long puts / short calls from customer flow."
            >
              <Greek label="ΔDEX" value={compact(dex)} up={dex >= 0} />
              <Greek label="ΓGEX" value={compact(chain.netGex)} up={chain.netGex >= 0} />
              <Greek label="Θ/day" value={compact(theta)} up={theta >= 0} />
              <Greek label="Vega" value={compact(vega)} up={null} />
            </div>
          </div>

          {/* donuts — horizontal, filling the rest of the row, sized to the stats table's height */}
          <div className="flex min-w-0 flex-1 flex-row gap-3">
            <div className="flex min-w-0 flex-1 flex-col items-center justify-center rounded border border-term-border bg-term-panel/40 p-3 text-center">
              <div className="mb-1 text-[9px] uppercase tracking-wide text-term-dim">Call vs Put OI</div>
              <MiniDonut aVal={pe} bVal={ce} aCol={PUT_OI} bCol={CALL_OI} center={nf(chain.pcr, 2)} sub="PCR" />
              <div className="mt-1 flex justify-center gap-3 text-[9px] text-term-dim">
                <span><Sw c={PUT_OI} /> Put {oiTot ? nf((pe / oiTot) * 100, 0) : "–"}%</span>
                <span><Sw c={CALL_OI} /> Call {oiTot ? nf((ce / oiTot) * 100, 0) : "–"}%</span>
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col items-center justify-center rounded border border-term-border bg-term-panel/40 p-3 text-center">
              <div className="mb-1 text-[9px] uppercase tracking-wide text-term-dim">ITM vs OTM OI</div>
              <MiniDonut
                aVal={itmOI}
                bVal={otmOI}
                aCol="#3b82f6"
                bCol="#a855f7"
                center={itmTot ? `${nf((itmOI / itmTot) * 100, 0)}%` : "–"}
                sub="ITM"
              />
              <div className="mt-1 flex justify-center gap-3 text-[9px] text-term-dim">
                <span><Sw c="#3b82f6" /> ITM {itmTot ? nf((itmOI / itmTot) * 100, 0) : "–"}%</span>
                <span><Sw c="#a855f7" /> OTM {itmTot ? nf((otmOI / itmTot) * 100, 0) : "–"}%</span>
              </div>
            </div>
          </div>
          </div>
        </div>
      </div>
    );
  })();

  // View / Strikes / ΔOI-over / Zoom — on the web portal these ride the "Show"
  // row (one row saved); on mobile they stay a separate ⚙-collapsible row.
  const chartControls = (
    <>
      {/* View only changes the Chart; Table / Ladder always show OI and its change */}
      {layout === "chart" && (
        <>
          <span className="ml-1">View</span>
          <div className="seg">
            <button onClick={() => setMetric("oi")} className={metric === "oi" ? "on" : ""}>
              OI
            </button>
            <button onClick={() => setMetric("chg")} className={metric === "chg" ? "on" : ""}>
              ΔOI bars
            </button>
            <button
              onClick={() => setMetric("combined")}
              className={metric === "combined" ? "on" : ""}
            >
              OI + Δ caps
            </button>
          </div>
        </>
      )}

      <span className="ml-1">Strikes ±</span>
      <div className="seg">
        {[5, 10, 15, 20, 25, 0].map((n) => (
          <button key={n} onClick={() => setCount(n)} className={count === n ? "on" : ""}>
            {n === 0 ? "All" : n}
          </button>
        ))}
      </div>

      <span className="ml-1">ΔOI over</span>
      <SelectMenu
        value={tf}
        options={
          [
            ["Full day", 0],
            ["1m", 1],
            ["2m", 2],
            ["3m", 3],
            ["5m", 5],
            ["15m", 15],
            ["30m", 30],
            ["1h", 60],
            ["2h", 120],
            ["3h", 180],
          ] as const
        }
        onChange={setTf}
        title="ΔOI window"
      />
      {tf > 0 && winCov > 0 && winCov < tf - 0.5 && (
        <span className="text-amber-400">
          history {winCov}m / {tf}m — still filling
        </span>
      )}
      {tf > 0 && winCov === 0 && (
        <span className="text-amber-400">collecting OI history…</span>
      )}

      {layout === "chart" && (
        <>
          <span className="ml-1">Zoom</span>
          <div className="seg">
            {[100, 95, 90, 85, 80].map((p) => (
              <button
                key={p}
                onClick={() => setZoom(p / 100)}
                className={Math.round(zoom * 100) === p ? "on" : ""}
              >
                {p}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col ${isMobile ? "overflow-y-auto" : ""}`}
    >
      {/* toolbar */}
      <div className="border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
        {/* phone: symbol / expiry / ⚙ on one row, the view switch on the next,
            a one-line summary; everything else waits behind ⚙ so the chart /
            ladder starts high up */}
        {isMobile && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <SelectMenu
                value={symbol}
                options={symOptions.map((s) => [s, s] as [string, string])}
                onChange={(v) => selectSymbol(v, true)}
                title="Underlying (list filtered by the All / Indices / Stocks toggle)"
                width={150}
              />
              {chain.expiries.length > 0 && (
                <SelectMenu
                  value={expiry}
                  options={chain.expiries.map((e) => [e, e] as [string, string])}
                  onChange={selectExpiry}
                  title="Expiry"
                  width={130}
                />
              )}
              <button
                onClick={() => setTools((t) => !t)}
                className={`ml-auto rounded border px-2 py-0.5 ${
                  tools ? "border-term-accent text-term-accent" : "border-term-dim/70 text-term-dim"
                }`}
                title="Filters, strike / ΔOI controls, OI totals and the trend's reasons"
              >
                ⚙ {tools ? "▴" : "▾"}
              </button>
            </div>
            <div className="seg no-scrollbar max-w-full self-start overflow-x-auto">
              {(
                [
                  ["chart", "Chart"],
                  ["table", "Table"],
                  ["ladder", "Ladder"],
                  ["walls", "Walls"],
                  ["gex", "Weekly Gex"],
                  ["dex", "Dealer Exp"],
                  ["pcr", "PCR"],
                ] as const
              ).map(([v, l]) => (
                <button key={v} onClick={() => setLayout(v)} className={`whitespace-nowrap ${layout === v ? "on" : ""}`}>
                  {l}
                </button>
              ))}
            </div>
            <div className="no-scrollbar flex items-center gap-2 overflow-x-auto whitespace-nowrap text-[10px] tabular-nums">
              {verdict && (
                <span
                  className={`rounded px-1.5 py-0.5 font-bold ${
                    verdict.bias === "BULLISH"
                      ? "bg-up text-white"
                      : verdict.bias === "BEARISH"
                      ? "bg-down text-white"
                      : "bg-term-border text-term-dim"
                  }`}
                >
                  {verdict.bias}
                </span>
              )}
              <span>
                PCR <span className="text-term-text">{nf(chain.pcr, 2)}</span>
              </span>
              <span>
                Spot <span className="text-term-text">{nf(spot, 1)}</span>
              </span>
              <span>
                Max Pain <span className="text-term-text">{nf(chain.maxPain, 0)}</span>
              </span>
            </div>
          </div>
        )}

        {/* row 1 — always visible: symbol / expiry / view switch / readout
            (phone: this whole row lives behind ⚙) */}
        <div className={`flex-wrap items-center gap-x-3 gap-y-1 ${isMobile ? (tools ? "mt-1.5 flex" : "hidden") : "flex"}`}>
          {paneNav ?? (
            <span className="font-semibold uppercase tracking-wide">OI Profile</span>
          )}

          <RefreshChainBtn />

          <ClassFilter />
          {!isMobile && (
            <SelectMenu
              value={symbol}
              options={symOptions.map((s) => [s, s] as [string, string])}
              onChange={(v) => selectSymbol(v, true)}
              title="Underlying (list filtered by the All / Indices / Stocks toggle)"
              width={150}
            />
          )}

          {!isMobile && chain.expiries.length > 0 && (
            <SelectMenu
              value={expiry}
              options={chain.expiries.map((e) => [e, e] as [string, string])}
              onChange={selectExpiry}
              title="Expiry"
              width={130}
            />
          )}

          {!isMobile && (
          <>
          <span className="ml-1">Show</span>
          <div className="seg">
            {(
              [
                ["chart", "Chart"],
                ["table", "Table"],
                ["ladder", "Ladder"],
                ["walls", "Walls"],
                ["gex", "Weekly Gex"],
                ["dex", "Dealer Exp"],
                ["pcr", "PCR"],
              ] as const
            ).map(([v, l]) => (
              <button key={v} onClick={() => setLayout(v)} className={layout === v ? "on" : ""}>
                {l}
              </button>
            ))}
          </div>

          </>
          )}

          {/* web portal: chart controls ride the "Show" row (saves a row) */}
          {!isMobile && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{chartControls}</div>
          )}

          <div className="num ml-auto flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className="rounded border border-term-border bg-term-bg/40 px-2 py-0.5">
              <span className="text-term-dim">Spot </span>
              <span className="text-term-text">{nf(spot, 1)}</span>
            </span>
            <span className="rounded border border-term-border bg-term-bg/40 px-2 py-0.5">
              <span className="text-term-dim">PCR </span>
              <span className="text-term-text">{nf(chain.pcr, 2)}</span>
            </span>
            <span className="rounded border border-term-border bg-term-bg/40 px-2 py-0.5">
              <span className="text-term-dim">Max Pain </span>
              <span className="text-term-text">{nf(chain.maxPain, 0)}</span>
            </span>
            {gammaFlip && (
              <span className="rounded border border-term-border bg-term-bg/40 px-2 py-0.5">
                <span className="text-term-dim">γ-flip </span>
                <span className="text-fuchsia-400">{sk(gammaFlip.strike)}</span>{" "}
                <span className={spot >= gammaFlip.strike ? "text-up" : "text-down"}>
                  {spot >= gammaFlip.strike ? "long-γ" : "short-γ"}
                </span>
              </span>
            )}
          </div>
        </div>

        {/* mobile: chart controls stay a separate ⚙-collapsible row */}
        {isMobile && (
          <div
            className={`mt-1 w-full flex-wrap items-center gap-x-3 gap-y-1 ${
              tools ? "flex" : "hidden"
            }`}
          >
            {chartControls}
          </div>
        )}
      </div>

      {/* OI totals (phone: behind ⚙) -- ONE scope, the strikes shown ("Strikes ±"),
          all in lakhs: total OI, added / cut over the ΔOI window, net, and the
          wall on each side. (It used to mix whole-chain totals in crores with
          windowed changes in lakhs, and a windowed resistance.) */}
      <div
        className={`border-b border-term-border bg-term-panel px-3 py-1.5 ${
          (isMobile && !tools) || layout === "table" || layout === "ladder" ? "hidden" : ""
        }`}
      >
        <table className="w-full max-w-2xl border-separate border-spacing-0 whitespace-nowrap text-[11px] tabular-nums [&_tr>*:first-child]:border-l">
          <thead>
            <tr className="[&>th]:border-b [&>th]:border-r [&>th]:border-t [&>th]:border-term-dim/50 [&>th]:bg-term-panel2 [&>th]:px-1.5 [&>th]:py-0.5 [&>th]:text-[10px] [&>th]:font-medium [&>th]:text-term-dim">
              <th className="rounded-tl-lg text-left" title={`strikes counted: ${count === 0 ? "all" : `ATM ${sk(chain.atmStrike)} ±${count}`}`}>
                {count === 0 ? "All" : `±${count}`} · {tf === 0 ? "day" : `${tf}m`}
              </th>
              <th className="text-right">OI</th>
              <th className="text-right" title={`over ${tfName}`}>Added</th>
              <th className="text-right">Cut</th>
              <th className="text-right">Net</th>
              <th className="rounded-tr-lg text-right">Wall</th>
            </tr>
          </thead>
          <tbody className="[&_td]:border-b [&_td]:border-r [&_td]:border-term-dim/50 [&_td]:px-1.5 [&_td]:py-0.5">
            {(
              [
                ["Calls", oiTotals.ce, flow.ceAdd, flow.ceCut, stats.resistance, "R", "text-down", "text-up"],
                ["Puts", oiTotals.pe, flow.peAdd, flow.peCut, stats.floor, "S", "text-up", "text-down"],
              ] as const
            ).map(([side, oi, add, cut, wall, tag, addCls, cutCls], i) => {
              const net = add + cut;
              const l1 = (v: number) => `${nf(v / 1e5, dp)}L`;
              const sgn = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${l1(Math.abs(v))}`;
              return (
                <tr key={side}>
                  <td className={`font-semibold ${addCls} ${i === 1 ? "rounded-bl-lg" : ""}`}>{side}</td>
                  <td className="text-right text-term-text">{l1(oi)}</td>
                  <td className={`text-right ${add > 0 ? addCls : "text-term-dim"}`}>{sgn(add)}</td>
                  <td className={`text-right ${cut < 0 ? cutCls : "text-term-dim"}`}>{sgn(cut)}</td>
                  <td className={`text-right font-semibold ${net > 0 ? addCls : net < 0 ? cutCls : "text-term-dim"}`}>{sgn(net)}</td>
                  <td className={`text-right font-semibold ${addCls} ${i === 1 ? "rounded-br-lg" : ""}`}>
                    {wall > 0 ? `${sk(wall)} ${tag}` : "–"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* overall OI verdict (phone: the summary row shows the bias; reasons behind ⚙) */}
      {/* not in the Ladder / Table: they need the height (the bias is in the phone summary row and on Home) */}
      {verdict && (!isMobile || tools) && layout !== "ladder" && layout !== "table" && (
        <div
          className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b px-3 py-1 text-[10px] ${
            verdict.bias === "BULLISH"
              ? "border-up/40 bg-up/10"
              : verdict.bias === "BEARISH"
              ? "border-down/40 bg-down/10"
              : "border-term-border bg-term-panel"
          }`}
        >
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
              verdict.bias === "BULLISH"
                ? "bg-up text-white"
                : verdict.bias === "BEARISH"
                ? "bg-down text-white"
                : "bg-term-border text-term-dim"
            }`}
          >
            OI TREND: {verdict.bias}
          </span>
          <span className="text-term-dim">score {verdict.score > 0 ? "+" : ""}{verdict.score}</span>
          {verdict.pros.length > 0 && (
            <span className="text-up">▲ {verdict.pros.join(" · ")}</span>
          )}
          {verdict.cons.length > 0 && (
            <span className="text-down">▼ {verdict.cons.join(" · ")}</span>
          )}
        </div>
      )}

      {layout === "chart" && (
        <div className={`flex ${isMobile ? "flex-col-reverse" : "min-h-0 flex-1 flex-row"}`}>
          {donutEl && (
            <>
              {donutEl}
              {!isMobile && (
                <div
                  onMouseDown={startDonutDrag}
                  title="Drag to resize the OI-split panel"
                  className="w-1.5 shrink-0 cursor-col-resize bg-term-border/50 transition-colors hover:bg-term-accent/70"
                />
              )}
            </>
          )}
          {chartEl}
        </div>
      )}
      {layout === "ladder" && ladderEl}
      {layout === "table" && tableEl}
      {layout === "walls" && wallsEl}
      {layout === "pcr" && <PcrChart symbol={symbol} isMobile={isMobile} />}
      {layout === "gex" && gexEl}
      {layout === "dex" && dexEl}

      {layout === "chart" && (
        <div className="flex flex-wrap items-center gap-x-3 border-t border-term-border px-3 py-1 text-[9px] text-term-dim">
          <span>
            <Sw c={CALL_OI} /> Call OI &nbsp; <Sw c={PUT_OI} /> Put OI
          </span>
          <span>
            {metric === "combined" ? (
              <>
                bar = OI (leg colour) &nbsp;
                <span
                  className="mr-1 inline-block h-2.5 w-3.5 align-middle"
                  style={{ backgroundImage: "repeating-linear-gradient(45deg,#94a3b8 0 2px,transparent 2px 4.5px)" }}
                />
                hatched = increase &nbsp;
                <span
                  className="mr-1 inline-block h-2.5 w-3.5 align-middle"
                  style={{ backgroundImage: "repeating-linear-gradient(45deg,#94a3b855 0 2px,transparent 2px 4.5px)" }}
                />
                pale = decrease
              </>
            ) : metric === "chg" ? (
              <>
                <Sw c={OI_ADD} /> OI added (solid, up) &nbsp; <Sw c={OI_CUT} hollow /> OI reduced (hollow, down)
              </>
            ) : (
              <>
                <span className="mr-1 inline-block h-2.5 w-3.5 align-middle" style={{ background: "#94a3b855" }} />
                bar height = total OI at each strike
              </>
            )}
          </span>
          <span>
            <span className="mr-1 inline-block border-l-2 border-dashed border-fuchsia-400 align-middle" style={{ height: 10 }} />
            γ-flip (dealer gamma zero-cross)
          </span>
          <span className="text-term-dim">
            · ΔOI over the selected window · Ctrl+scroll to zoom.
          </span>
        </div>
      )}
    </div>
  );
}
