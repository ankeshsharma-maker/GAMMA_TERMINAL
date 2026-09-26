import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts";
import { useStore } from "../store";
import { isViewer } from "../lib/auth";
import { ChartStepper } from "./ChartStepper";
import { api } from "../lib/api";
import { MiniChart } from "./MiniChart";
import { SelectMenu } from "./SelectMenu";
import { getDataSrc, getIntervalS } from "../lib/prefs";
import { computeGammaFlip } from "../lib/gammaFlip";
import { DrawingPrimitive, describeDrawing, type Drawing, type Point } from "../lib/chartDrawings";
import { bucketStart } from "../lib/istTime";
import { detectPatterns, PATTERN_LEGEND, type PatternHit } from "../lib/candlePatterns";
import { detectChartPatterns, type ChartEvent } from "../lib/chartPatterns";
import { AutoPatternsPrimitive } from "../lib/autoPatternsPrimitive";
import { TrendCompass } from "./TrendCompass";
import {
  bollinger,
  ema,
  heikinAshi,
  macd,
  pivots,
  rsi,
  sma,
  supertrend,
  vwap,
  type Candle,
  type PivotPeriod,
  type Pt,
} from "../lib/indicators";

interface ChartData {
  symbol: string;
  candles: Candle[];
  series: Record<string, Pt[]>;
  lastSpot: number | null;
  points: number;
  candleSource?: "broker" | "sampled" | "upstox";
  hasVolume?: boolean;
  interval?: number;
  /** the server is re-serving its last good answer because the feed hiccuped */
  stale?: boolean;
}

/** How many refreshes in a row may be refused before a smaller set is believed (15s apart = ~5 min). */
const DEGRADED_MAX = 20;

/** Is `nd` a degraded version of the chart already on screen? A feed hiccup (an upstream rate limit,
 *  a restart) can make the server answer with a sliver of the candles, or only its "sampled" fallback.
 *  Drawn as-is the chart collapses to that sliver and then "replays" its whole history when the feed
 *  recovers -- which is the flicker. Only ever judged against the SAME symbol and interval, so
 *  switching timeframe or instrument is never mistaken for a degradation. */
function isDegraded(cur: ChartData | null, nd: ChartData): boolean {
  if (!cur || cur.symbol !== nd.symbol || cur.interval !== nd.interval) return false;
  // only a chart that is already good needs protecting; anything better than a poor one is welcome
  const curReal = cur.candleSource !== "sampled" && cur.candles.length >= 25;
  if (!curReal) return false;
  if (nd.stale) return true; // the server's own copy of an older answer: keep what we already have
  return nd.candleSource === "sampled" || nd.candles.length < cur.candles.length * 0.5;
}

const TIMEFRAMES: [string, number][] = [
  ["15s", 15],
  ["30s", 30],
  ["1m", 60],
  ["3m", 180],
  ["5m", 300],
  ["15m", 900],
  ["30m", 1800],
  ["45m", 2700],
  ["1h", 3600],
  ["2h", 7200],
  ["4h", 14400],
  ["1D", 86400],
];

const TOGGLES = [
  ["ema9", "EMA 9"],
  ["ema21", "EMA 21"],
  ["ema50", "EMA 50"],
  ["sma20", "SMA 20"],
  ["vwap", "VWAP"],
  ["boll", "Bollinger"],
  ["pivot", "Pivot Points"],
  ["gammaFlip", "Gamma Flip"],
  ["supertrend", "Supertrend"],
  ["vol", "Volume"],
  ["rsi", "RSI"],
  ["macd", "MACD"],
  ["oi", "OI"],
  ["oichg", "ΔOI"],
  ["fibpivot", "Fib Pivots"],
  ["straddle", "ATM Straddle"],
  ["score", "Blast Score"],
  ["greeks", "Greeks"],
  ["patterns", "Candle patterns"],
  ["ranges", "Range breakouts"],
  ["chartpat", "Chart patterns"],
  ["structure", "Market structure"],
] as const;
type ToggleKey = (typeof TOGGLES)[number][0];
/** drawn-on-price analysis: its own "Patterns" button, not the ƒx indicator list */
const PATTERN_KEYS = new Set<ToggleKey>(["patterns", "ranges", "chartpat", "structure"]);
const DEFAULT_ON: Record<ToggleKey, boolean> = {
  ema9: true,
  ema21: true,
  ema50: false,
  sma20: false,
  vwap: true,
  boll: false,
  supertrend: false,
  vol: true,
  rsi: false,
  macd: false,
  oi: false,
  oichg: false,
  pivot: false,
  gammaFlip: false,
  fibpivot: false,
  straddle: false, // ATM CE+PE price (a volatility proxy) — opt-in, it was crowding every chart
  score: false,
  greeks: false,
  // drawn-on-price analysis (◇ Patterns) starts off -- the user turns on what they want
  patterns: false,
  ranges: false,
  chartpat: false,
  structure: false,
};

/** Everything a saved chart layout brings back (TradingView-style). */
type ChartLayout = {
  on: Partial<Record<ToggleKey, boolean>>;
  intervalS: number;
  rangeD: number;
  ctype: "candle" | "heikin" | "line" | "area" | "bar";
  logScale: boolean;
  greekSel: "delta" | "gamma" | "theta" | "vega";
  mtf: { ind: string; len: number; tf: number; period?: PivotPeriod } | null;
  split: boolean;
  cmpInstrument: string;
  showTime: boolean;
  indHidden: boolean;
  barOpen: boolean;
  symbol?: string;
  instrument?: string;
};
type SavedLayout = { id: string; name: string; saved: number; layout: ChartLayout };
type LayoutBook = { active: string | null; layouts: SavedLayout[] };
const LAYOUT_CACHE = "chart.layouts";
const readLayoutCache = (): LayoutBook => {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_CACHE) || "null");
    return v && Array.isArray(v.layouts) ? v : { active: null, layouts: [] };
  } catch {
    return { active: null, layouts: [] };
  }
};
const writeLayoutCache = (b: LayoutBook) => {
  try {
    localStorage.setItem(LAYOUT_CACHE, JSON.stringify(b));
  } catch {
    /* ignore */
  }
};
/** a saved option leg that has expired can't be charted any more */
const instrumentLive = (ins: string) => {
  if (!ins || ins === "STRADDLE") return true;
  const exp = Date.parse(ins.split("|")[1] || "");
  return !Number.isNaN(exp) && exp + 86400000 > Date.now();
};

const dedupe = (pts: Pt[] = []) => {
  const m = new Map<number, number>();
  for (const p of pts) m.set(p.time, p.value);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
};

/* ---- IST time rendering (lightweight-charts draws UTC by default, so the
 *      NSE session 09:15-15:30 was showing ~5.5h off) ---- */
const IST = "Asia/Kolkata";
let _tfSecs = false; // show seconds on the axis / crosshair for sub-minute intervals
const istTime = (t: number) =>
  new Date(t * 1000).toLocaleTimeString("en-GB", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    ...(_tfSecs ? { second: "2-digit" as const } : {}),
    hour12: false,
  });
const istDate = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-GB", { timeZone: IST, day: "2-digit", month: "short" });
const IST_LOCALIZATION = {
  timeFormatter: (t: number) => `${istDate(t)} ${istTime(t)}`,
};
const istTickFormatter = (t: number, tickType: number) =>
  tickType <= 2 ? istDate(t) : istTime(t);

/** OHLC resample to a coarser bucket, for multi-timeframe indicator overlays. */
function resampleCandles(cs: Candle[], sec: number): Candle[] {
  if (!cs.length || sec <= 0) return cs;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let key = -1;
  for (const c of cs) {
    const k = bucketStart(c.time as number, sec);
    if (k !== key) {
      if (cur) out.push(cur);
      cur = { ...c };
      key = k;
    } else if (cur) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      (cur as any).volume = ((cur as any).volume ?? 0) + ((c as any).volume ?? 0);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** forward-fill a coarse indicator series onto the base candle timeline (step). */
function stepOnto(base: Candle[], pts: Pt[]): Pt[] {
  if (!pts.length || !base.length) return [];
  const out: Pt[] = [];
  let j = 0;
  for (const b of base) {
    const bt = b.time as number;
    while (j + 1 < pts.length && pts[j + 1].time <= bt) j++;
    if (pts[j].time <= bt) out.push({ time: bt, value: pts[j].value });
  }
  return out;
}

const MTF_INDS: [string, string][] = [
  ["ema", "EMA"],
  ["sma", "SMA"],
  ["vwap", "VWAP"],
  ["boll", "Bollinger mid"],
  ["bollu", "Bollinger upper"],
  ["bolll", "Bollinger lower"],
  ["supertrend", "Supertrend"],
  ["rsi", "RSI"],
  ["macd", "MACD"],
  ["macdsig", "MACD signal"],
  ["fibpivot", "Fib Pivots"],
];
// MTF indicators whose values sit off the price scale — drawn on a hidden axis
const MTF_OSC = new Set(["rsi", "macd", "macdsig"]);

/** How many days of history a fresh intraday timeframe opens on. One day is plenty of bars from 1m to 15m
 *  (375 down to 25) but only 13 at 30m and 7 at 1h -- a handful of giant candles with two axis labels -- so those
 *  open on a week / a fortnight (about 65 / 75 bars). The range menu still overrides it until the timeframe changes. */
const defaultRangeDays = (intervalS: number): number => (intervalS >= 3600 ? 15 : intervalS >= 1800 ? 7 : 1);

export function Chart() {
  const symbol = useStore((s) => s.symbol);
  const chain = useStore((s) => s.chain);
  // subscribe to just the charted symbol's tick — not the whole liveSpots map,
  // which churns on every tick of every watchlist / subscribed symbol
  const liveTick = useStore((s) => s.liveSpots[s.symbol]);
  // broker session up but its live socket down => charts are on the REST
  // fallback; surface it loudly instead of letting the chart look frozen.
  // Debounced on the way *up* only: the WS reconnects on its own within a
  // few seconds for a plain transient drop (5s->60s backoff), so flipping
  // this the instant a single status poll sees it down made the "FEED
  // STALE" badge (and the toolbar row it can wrap onto) flash in and out
  // during live trading -- reads as the whole chart flickering / shifting
  // position. Recovery still clears it immediately.
  const rawFeedStale = useStore((s) => !!s.broker?.authed && !s.broker?.wsConnected);
  const [feedStale, setFeedStale] = useState(false);
  useEffect(() => {
    if (!rawFeedStale) {
      setFeedStale(false);
      return;
    }
    const t = setTimeout(() => setFeedStale(true), 6000);
    return () => clearTimeout(t);
  }, [rawFeedStale]);
  const watch = useStore((s) => s.watch);
  const instrument = useStore((s) => s.chartInstrument);
  const setInstrument = useStore((s) => s.setChartInstrument);
  const selectSymbol = useStore((s) => s.selectSymbol);
  const setView = useStore((s) => s.setView);
  const view = useStore((s) => s.view);
  const symClass = useStore((s) => s.symClass);
  const symClassOk = useStore((s) => s.symClassOk);
  const quickTradeAt = useStore((s) => s.quickTradeAt);
  const scalpLots = useStore((s) => s.scalpLots);
  const [symChoices, setSymChoices] = useState<string[]>([]);
  useEffect(() => {
    api.symbols().then(
      (d) => setSymChoices([...new Set([...(d.indices ?? []), ...(d.fo ?? []), ...(d.defaults ?? [])])].sort()),
      () => {}
    );
  }, []);
  const symOptions = useMemo(
    () =>
      [...new Set([symbol, ...symChoices])]
        .filter(Boolean)
        .filter((s) => s === symbol || symClassOk(s))
        .sort(),
    [symbol, symChoices, symClass]
  );
  const [data, setData] = useState<ChartData | null>(null);
  // why the current symbol's chart couldn't load (null = no failure), and a nudge to retry it
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  // a new symbol / instrument / interval just started loading: re-frame the view
  // once its first candles land, instead of trusting the previous chart's scroll position
  const reframeRef = useRef(false);
  // the logical range we last applied ourselves (via fitContent/setVisibleRange), so a plain
  // data refresh can tell "user zoomed/panned the view" apart from "new candles landed" and
  // leave a manually-zoomed-out view alone instead of snapping it back every poll
  const lastAppliedRangeRef = useRef<{ from: number; to: number } | null>(null);
  const dataRef = useRef<ChartData | null>(null); // mirror of `data`, readable inside the fetch loop
  const degradedRef = useRef(0); // consecutive refreshes refused as degraded
  const priceCandlesRef = useRef<Candle[]>([]); // the candles on screen, readable from drawing primitives
  const intervalRef = useRef(0);
  const [feedLimited, setFeedLimited] = useState(false);
  const [intervalS, setIntervalS] = useState(getIntervalS); // default from Settings
  const [rangeD, setRangeD] = useState(() => defaultRangeDays(intervalS)); // visible-history window in days; 0 = all
  const [split, setSplit] = useState(false);
  const [cmpInstrument, setCmpInstrument] = useState<string>("STRADDLE");
  const [ctype, setCtype] = useState<"candle" | "heikin" | "line" | "area" | "bar">("candle");
  const [logScale, setLogScale] = useState(false);
  const [drawTool, setDrawTool] = useState<"none" | "hline" | "trend" | "fib">("none");
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [drawingsOpen, setDrawingsOpen] = useState(false);
  const plRefs = useRef<any[]>([]); // hline price-line refs (drawn via createPriceLine, not a primitive)
  const linePrimitives = useRef<Map<string, DrawingPrimitive>>(new Map()); // trend/fib
  const previewPrimitive = useRef<DrawingPrimitive | null>(null);
  const dragStart = useRef<Point | null>(null);
  const pvtRefs = useRef<any[]>([]);
  const mtfPvtRefs = useRef<any[]>([]);
  const gfRef = useRef<any>(null);
  const drawToolRef = useRef<typeof drawTool>("none");
  const [legend, setLegend] = useState<string>("");
  // candlestick patterns on screen, by bar time -- the crosshair legend names the one under the cursor
  const patternsRef = useRef<Map<number, PatternHit>>(new Map());
  // breakouts / confirmed chart patterns on screen, by bar time (crosshair legend)
  const eventsRef = useRef<Map<number, ChartEvent[]>>(new Map());
  // draws the range boxes + pattern lines: one on the candle series, one on the bar series
  const autoPrimRef = useRef<{ candle: AutoPatternsPrimitive; bar: AutoPatternsPrimitive } | null>(null);
  // px per bar (zoom), so pattern labels are spaced to what fits on screen
  const [barSpacing, setBarSpacing] = useState(6);
  const [rsiVal, setRsiVal] = useState<number | null>(null);
  const lastRsiRef = useRef<number | null>(null);
  useEffect(() => {
    drawToolRef.current = drawTool;
  }, [drawTool]);

  const instrOptions = watch.filter((w) => w.kind === "option" && w.symbol === symbol);
  const isOption = instrument.includes("|");
  const strikes = chain?.rows.map((r) => r.strike) ?? [];
  const [pickStrike, setPickStrike] = useState<number>(0);
  useEffect(() => {
    if (chain?.atmStrike) setPickStrike(chain.atmStrike);
  }, [chain?.atmStrike, chain?.symbol]);
  // every strike is listed; the picker scrolls the ATM one into view when opened
  const shownStrikes = useMemo(
    () =>
      strikes.includes(pickStrike) || !pickStrike
        ? strikes
        : [...strikes, pickStrike].sort((a, b) => a - b),
    [strikes, pickStrike]
  );
  const chartLeg = (ot: "CE" | "PE") => {
    if (chain && pickStrike) setInstrument(`${symbol}|${chain.expiry}|${pickStrike}|${ot}`);
  };
  const [on, setOn] = useState<Record<ToggleKey, boolean>>(() => ({ ...DEFAULT_ON }));
  // hide the time (x) axis labels for a cleaner chart
  const [showTime, setShowTime] = useState(() => {
    try {
      return localStorage.getItem("chart.showTime") !== "0";
    } catch {
      return true;
    }
  });
  const toggleTime = () =>
    setShowTime((v) => {
      try {
        localStorage.setItem("chart.showTime", v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });
  // multi-timeframe indicator overlay: pick an indicator + length + timeframe
  const [mtf, setMtf] = useState<
    { ind: string; len: number; tf: number; period?: PivotPeriod } | null
  >(null);
  // "hide indicators" — blank every overlay/sub-pane at once while keeping the
  // user's real selection so it comes straight back on toggle.
  const [indHidden, setIndHidden] = useState(() => {
    try {
      return localStorage.getItem("chart.indHidden") === "1";
    } catch {
      return false;
    }
  });
  const setInd = (v: boolean) => {
    setIndHidden(v);
    try {
      localStorage.setItem("chart.indHidden", v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  // which Greek the "Greeks" toggle plots -- ATM call + put, from the same
  // per-poll history the live chain's own Greeks table reads
  const [greekSel, setGreekSel] = useState<"delta" | "gamma" | "theta" | "vega">(() => {
    try {
      const v = localStorage.getItem("chart.greekSel");
      return v === "gamma" || v === "theta" || v === "vega" ? v : "delta";
    } catch {
      return "delta";
    }
  });
  const setGreek = (v: "delta" | "gamma" | "theta" | "vega") => {
    setGreekSel(v);
    try {
      localStorage.setItem("chart.greekSel", v);
    } catch {
      /* ignore */
    }
  };
  const eff = useMemo(() => {
    if (!indHidden) return on;
    const z = { ...on };
    (Object.keys(z) as ToggleKey[]).forEach((k) => (z[k] = false));
    return z;
  }, [on, indHidden]);

  // ƒx indicator picker + MTF overlay picker
  const [fxOpen, setFxOpen] = useState(false);
  const [patOpen, setPatOpen] = useState(false);
  const [mtfOpen, setMtfOpen] = useState(false);
  const activeInd = TOGGLES.filter(([k]) => on[k] && !PATTERN_KEYS.has(k)).length;
  const activePat = TOGGLES.filter(([k]) => on[k] && PATTERN_KEYS.has(k)).length;

  const onRef = useRef(eff);
  useEffect(() => {
    onRef.current = eff;
  }, [eff]);

  // collapse the whole settings toolbar for a full-height chart
  const [barOpen, setBarOpen] = useState(() => {
    try {
      return localStorage.getItem("chart.barOpen") !== "0";
    } catch {
      return true;
    }
  });
  // ---- saved layouts (TradingView-style): named snapshots of every setting on this chart ----
  const [book, setBook] = useState<LayoutBook>(readLayoutCache);
  const [layoutOpen, setLayoutOpen] = useState<{ top: number; left: number } | null>(null);
  const [layoutName, setLayoutName] = useState("");
  const pendingRangeRef = useRef<number | null>(null);
  const activeLayout = book.layouts.find((l) => l.id === book.active) ?? null;

  const setBar = (v: boolean) => {
    setBarOpen(v);
    try {
      localStorage.setItem("chart.barOpen", v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const currentLayout = (): ChartLayout => ({
    on: { ...on },
    intervalS,
    rangeD,
    ctype,
    logScale,
    greekSel,
    mtf,
    split,
    cmpInstrument,
    showTime,
    indHidden,
    barOpen,
    symbol,
    instrument,
  });
  // "•" on the button: the chart differs from the active layout (symbol / instrument aside --
  // browsing another symbol isn't an edit of the layout)
  const layoutKey = (l: ChartLayout) => {
    const { symbol: _s, instrument: _i, ...rest } = l;
    return JSON.stringify({ ...rest, on: { ...DEFAULT_ON, ...rest.on } });
  };
  const layoutModified = !!activeLayout && layoutKey(currentLayout()) !== layoutKey(activeLayout.layout);

  /** Put a layout on the chart. `withSymbol`: also switch to its symbol / instrument (picking one
   *  from the menu); on app start only the settings come back, not the symbol you were on. */
  const applyLayout = (L: ChartLayout, withSymbol: boolean) => {
    setOn({ ...DEFAULT_ON, ...(L.on || {}) });
    setCtype(L.ctype || "candle");
    setLogScale(!!L.logScale);
    setGreek(L.greekSel || "delta");
    setMtf(L.mtf ?? null);
    setSplit(!!L.split);
    setCmpInstrument(L.cmpInstrument ?? "STRADDLE");
    setShowTime(L.showTime !== false);
    try {
      localStorage.setItem("chart.showTime", L.showTime !== false ? "1" : "0");
    } catch {
      /* ignore */
    }
    setInd(!!L.indHidden);
    setBar(L.barOpen !== false);
    if (withSymbol && L.symbol) {
      selectSymbol(L.symbol, true);
      if (instrumentLive(L.instrument ?? "")) setInstrument(L.instrument ?? "");
    }
    const iv = L.intervalS || getIntervalS();
    if (iv === intervalRef.current) setRangeD(L.rangeD ?? defaultRangeDays(iv));
    else {
      pendingRangeRef.current = L.rangeD ?? defaultRangeDays(iv);
      setIntervalS(iv);
    }
  };
  const defaultLayout = (): ChartLayout => ({
    on: { ...DEFAULT_ON },
    intervalS: getIntervalS(),
    rangeD: defaultRangeDays(getIntervalS()),
    ctype: "candle",
    logScale: false,
    greekSel: "delta",
    mtf: null,
    split: false,
    cmpInstrument: "STRADDLE",
    showTime: true,
    indHidden: false,
    barOpen: true,
  });

  // on open: the active layout's settings (device copy first, then the server's, which wins)
  useEffect(() => {
    const cached = readLayoutCache();
    const c = cached.layouts.find((l) => l.id === cached.active);
    if (c) applyLayout(c.layout, false);
    api
      .chartLayouts()
      .then((d) => {
        const b: LayoutBook = { active: d.active ?? null, layouts: (d.layouts as SavedLayout[]) ?? [] };
        setBook(b);
        writeLayoutCache(b);
        const sv = b.layouts.find((l) => l.id === b.active);
        if (sv && JSON.stringify(sv) !== JSON.stringify(c)) applyLayout(sv.layout, false);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const persistBook = (b: LayoutBook) => {
    setBook(b);
    writeLayoutCache(b);
    api.saveChartLayouts(b).catch((e) => alert(`Couldn't save the layout on the server: ${e?.message || e}`));
  };
  const saveLayout = () => {
    if (!activeLayout) return;
    persistBook({
      ...book,
      layouts: book.layouts.map((l) => (l.id === activeLayout.id ? { ...l, saved: Date.now(), layout: currentLayout() } : l)),
    });
  };
  const saveLayoutAs = () => {
    const name = layoutName.trim().slice(0, 40);
    if (!name) return;
    if (book.layouts.length >= 20) return alert("Up to 20 layouts -- delete one first.");
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    persistBook({ active: id, layouts: [...book.layouts, { id, name, saved: Date.now(), layout: currentLayout() }] });
    setLayoutName("");
  };
  const loadLayout = (l: SavedLayout) => {
    applyLayout(l.layout, true);
    persistBook({ ...book, active: l.id });
    setLayoutOpen(null);
  };
  const deleteLayout = (l: SavedLayout) => {
    if (!confirm(`Delete the layout “${l.name}”?`)) return;
    persistBook({ active: book.active === l.id ? null : book.active, layouts: book.layouts.filter((x) => x.id !== l.id) });
  };
  const resetLayout = () => {
    applyLayout(defaultLayout(), false);
    persistBook({ ...book, active: null });
    setLayoutOpen(null);
  };

  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const s = useRef<Record<string, ISeriesApi<any>>>({});
  const rsiGuidesRef = useRef<any[]>([]);
  const macdZeroRef = useRef<any>(null);
  // top edge (0..1 from the top) of the oscillator band — drives the divider
  const [oscTop, setOscTop] = useState<number | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const chart = createChart(wrapRef.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#7a8699" },
      grid: { vertLines: { color: "#141c27" }, horzLines: { color: "#141c27" } },
      crosshair: { mode: CrosshairMode.Normal },
      localization: IST_LOCALIZATION,
      rightPriceScale: { borderColor: "#1e2733", scaleMargins: { top: 0.06, bottom: 0.28 } },
      timeScale: {
        borderColor: "#1e2733",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: istTickFormatter,
      },
      autoSize: true,
    });
    chartRef.current = chart;
    const c = s.current;

    c.vol = chart.addHistogramSeries({ priceScaleId: "vol", priceLineVisible: false, base: 0 });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });

    c.candle = chart.addCandlestickSeries({
      upColor: "#16a34a",
      downColor: "#dc2626",
      borderVisible: false,
      wickUpColor: "#16a34a",
      wickDownColor: "#dc2626",
    });
    c.barS = chart.addBarSeries({ upColor: "#16a34a", downColor: "#dc2626", visible: false });
    autoPrimRef.current = { candle: new AutoPatternsPrimitive(), bar: new AutoPatternsPrimitive() };
    c.candle.attachPrimitive(autoPrimRef.current.candle);
    c.barS.attachPrimitive(autoPrimRef.current.bar);
    c.lineS = chart.addLineSeries({ color: "#38bdf8", lineWidth: 2, visible: false, lastValueVisible: true });
    c.areaS = chart.addAreaSeries({
      lineColor: "#38bdf8",
      topColor: "rgba(56,189,248,0.25)",
      bottomColor: "rgba(56,189,248,0.02)",
      lineWidth: 2,
      visible: false,
    });

    // zoom level for the pattern-label spacing (only re-renders on a real zoom change)
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      const b = chart.timeScale().options().barSpacing;
      setBarSpacing((prev) => (Math.abs(b - prev) / prev > 0.2 ? b : prev));
    });

    // crosshair OHLC legend
    chart.subscribeCrosshairMove((p) => {
      const cs = s.current.candle as ISeriesApi<"Candlestick">;
      const bar: any = p.seriesData?.get(cs) || p.seriesData?.get(s.current.barS);
      if (!bar || bar.open == null) {
        setLegend("");
        setRsiVal(lastRsiRef.current); // not hovering -> show the latest RSI, not nothing
        return;
      }
      const ch = bar.close - bar.open;
      const chp = bar.open ? (ch / bar.open) * 100 : 0;
      const pat = patternsRef.current.get(bar.time as number);
      const evs = eventsRef.current.get(bar.time as number) ?? [];
      const evTxt = evs.map((e) => `  ·  ${e.name} ${e.dir === "up" ? "▲" : "▼"}`).join("");
      setLegend(
        `O ${bar.open.toFixed(1)}  H ${bar.high.toFixed(1)}  L ${bar.low.toFixed(1)}  C ${bar.close.toFixed(1)}  ${
          ch >= 0 ? "+" : ""
        }${ch.toFixed(1)} (${chp.toFixed(2)}%)${pat ? `  ·  ${pat.name} ${pat.bias === "bull" ? "▲" : pat.bias === "bear" ? "▼" : "◆"}` : ""}${evTxt}`
      );
      if (onRef.current.rsi) {
        const rp: any = p.seriesData?.get(s.current.rsi as any);
        setRsiVal(rp?.value != null ? rp.value : lastRsiRef.current);
      }
    });

    // click to drop a horizontal line (hline tool)
    chart.subscribeClick((p) => {
      if (drawToolRef.current !== "hline" || !p.point) return;
      const price = (s.current.candle as ISeriesApi<"Candlestick">).coordinateToPrice(p.point.y);
      if (price != null) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setDrawings((ds) => [...ds, { id, type: "hline", price: Number(price.toFixed(2)) }]);
      }
    });

    // drag to draw a trendline / fib retracement (trend/fib tools). Native
    // pointer events (not the library's own click/crosshair APIs) so mouse
    // and touch both work with one code path -- same reason this app's
    // Watchlist search-add already uses pointerdown over onClick.
    const toChartPoint = (clientX: number, clientY: number): Point | null => {
      if (!wrapRef.current) return null;
      const rect = wrapRef.current.getBoundingClientRect();
      const time = chart.timeScale().coordinateToTime(clientX - rect.left);
      const price = (s.current.candle as ISeriesApi<"Candlestick">).coordinateToPrice(
        clientY - rect.top
      );
      return time == null || price == null ? null : { time: time as number, price };
    };
    const onPointerDown = (e: PointerEvent) => {
      const tool = drawToolRef.current;
      if (tool !== "trend" && tool !== "fib") return;
      const p = toChartPoint(e.clientX, e.clientY);
      if (!p) return;
      e.preventDefault();
      dragStart.current = p;
      const primitive = new DrawingPrimitive({ id: "__preview__", type: tool, p1: p, p2: p });
      (s.current.candle as ISeriesApi<"Candlestick">).attachPrimitive(primitive);
      previewPrimitive.current = primitive;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!previewPrimitive.current || !dragStart.current) return;
      const p = toChartPoint(e.clientX, e.clientY);
      if (!p) return;
      previewPrimitive.current.setDrawing({ ...previewPrimitive.current.drawing, p2: p });
    };
    const onPointerUp = (e: PointerEvent) => {
      const preview = previewPrimitive.current;
      const p1 = dragStart.current;
      if (!preview || !p1) return;
      const p2 = toChartPoint(e.clientX, e.clientY) ?? preview.drawing.p2;
      const tool = preview.drawing.type;
      (s.current.candle as ISeriesApi<"Candlestick">).detachPrimitive(preview);
      previewPrimitive.current = null;
      dragStart.current = null;
      // ignore a bare click (no real drag) -- don't add a zero-length line,
      // and leave the tool armed so the user can just try the drag again
      if (Math.abs(p2.time - p1.time) < 1 && Math.abs(p2.price - p1.price) < 1e-9) return;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setDrawings((ds) => [...ds, { id, type: tool, p1, p2 }]);
      // one-shot: a finished trend/fib deactivates the tool (matches every
      // other charting app -- draw one, then explicitly re-arm to draw
      // another) so the next plain click on the chart doesn't start a
      // second drawing.
      setDrawTool("none");
    };
    wrapRef.current?.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    const line = (color: string, w = 1) =>
      chart.addLineSeries({ color, lineWidth: w as any, priceLineVisible: false, lastValueVisible: false });
    c.ema9 = line("#3b82f6");
    c.ema21 = line("#f59e0b");
    c.ema50 = line("#a855f7");
    c.sma20 = line("#14b8a6");
    c.vwap = line("#eab308", 2);
    c.bu = line("#475569");
    c.bl = line("#475569");
    c.st = line("#22c55e", 2);
    c.mtf = chart.addLineSeries({
      color: "#22d3ee",
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    // second MTF line on its own hidden auto-scaled axis, for oscillator MTF
    // indicators (RSI / MACD) whose values don't live on the price scale
    c.mtf2 = chart.addLineSeries({
      color: "#22d3ee",
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      priceScaleId: "mtfosc",
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
    });
    chart.priceScale("mtfosc").applyOptions({
      visible: false,
      scaleMargins: { top: 0.7, bottom: 0.04 },
    });

    c.straddle = chart.addLineSeries({
      color: "#a855f7",
      lineWidth: 2,
      priceScaleId: "straddle",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    c.score = chart.addLineSeries({
      color: "#eab308",
      lineWidth: 2,
      priceScaleId: "score",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("straddle").applyOptions({ scaleMargins: { top: 0.74, bottom: 0.14 } });
    chart.priceScale("score").applyOptions({ scaleMargins: { top: 0.74, bottom: 0.14 } });

    // ATM Greeks (call red / put green, matching this app's CE/PE colour
    // convention elsewhere) -- which field each line reads is picked at
    // render time by greekSel, both share one scale since delta/gamma/
    // theta/vega for the same ATM pair are always on comparable magnitudes
    c.greeksCe = chart.addLineSeries({
      color: "#f87171",
      lineWidth: 2,
      priceScaleId: "greeks",
      priceLineVisible: false,
      lastValueVisible: true,
    });
    c.greeksPe = chart.addLineSeries({
      color: "#4ade80",
      lineWidth: 2,
      priceScaleId: "greeks",
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chart.priceScale("greeks").applyOptions({ scaleMargins: { top: 0.74, bottom: 0.14 } });

    c.rsi = chart.addLineSeries({
      color: "#e879f9",
      lineWidth: 1,
      priceScaleId: "rsi",
      priceLineVisible: true,
      lastValueVisible: true,
    });
    chart.priceScale("rsi").applyOptions({ scaleMargins: { top: 0.74, bottom: 0.14 }, visible: false });

    c.macdHist = chart.addHistogramSeries({ priceScaleId: "macd", priceLineVisible: false, base: 0 });
    c.macdLine = chart.addLineSeries({
      color: "#3b82f6",
      lineWidth: 1,
      priceScaleId: "macd",
      priceLineVisible: false,
      lastValueVisible: true, // show the live MACD value on the axis
    });
    c.macdSig = chart.addLineSeries({
      color: "#f97316",
      lineWidth: 1,
      priceScaleId: "macd",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("macd").applyOptions({ scaleMargins: { top: 0.86, bottom: 0.02 }, visible: false });

    // OI overlay panes
    c.callOI = chart.addLineSeries({
      color: "#f87171",
      lineWidth: 2,
      priceScaleId: "oi",
      priceLineVisible: false,
      lastValueVisible: true,
    });
    c.putOI = chart.addLineSeries({
      color: "#4ade80",
      lineWidth: 2,
      priceScaleId: "oi",
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chart.priceScale("oi").applyOptions({ scaleMargins: { top: 0.72, bottom: 0.16 }, visible: false });

    c.ceChg = chart.addHistogramSeries({ priceScaleId: "oichg", priceLineVisible: false, base: 0, color: "#f8717199" });
    c.peChg = chart.addHistogramSeries({ priceScaleId: "oichg", priceLineVisible: false, base: 0, color: "#4ade8099" });
    chart.priceScale("oichg").applyOptions({ scaleMargins: { top: 0.86, bottom: 0.02 }, visible: false });

    return () => {
      wrapRef.current?.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      chart.remove();
      chartRef.current = null;
      s.current = {};
    };
  }, []);

  // seconds on the time axis / crosshair only for sub-minute intervals
  useEffect(() => {
    _tfSecs = intervalS < 60;
    chartRef.current?.applyOptions({ timeScale: { secondsVisible: intervalS < 60 } });
  }, [intervalS]);

  const [dataSrc, setDataSrc] = useState<"auto" | "broker" | "upstox">(getDataSrc);

  // adopt a default changed in Settings without a reload
  useEffect(() => {
    const h = () => {
      setDataSrc(getDataSrc());
      setIntervalS(getIntervalS());
    };
    window.addEventListener("gt-prefs", h);
    return () => window.removeEventListener("gt-prefs", h);
  }, []);

  // Refresh cadence: normally 15s (chart motion between refreshes comes from the
  // live nudge below). Only when the broker feed is *expected but down* — so the
  // backend is serving ~3s REST quotes and there are no WS ticks — drop to 4s so
  // the chart still moves. Both flags live in refs, updated by small effects, so
  // the fetch loop isn't torn down (blanking the chart) on every flip.
  const tickFreshRef = useRef(false);
  const feedDownRef = useRef(false);
  const lastSymRef = useRef("");
  const lastFrameRef = useRef("");
  useEffect(() => {
    let alive = true;
    let lastAt = 0;
    const load = (force = false) => {
      const now = Date.now();
      const minGap =
        intervalS < 60 ? 3000 : feedDownRef.current && !tickFreshRef.current ? 4000 : 15000;
      if (!force && now - lastAt < minGap) return;
      lastAt = now;
      api
        .chart(symbol, intervalS, instrument || undefined, dataSrc)
        .then((d) => {
          if (!alive) return;
          setLoadErr(null);
          const nd = d as ChartData;
          // keep the good candles on screen rather than redraw with a collapsed set; give up after
          // ~5 minutes so a feed that really has shrunk can't leave the chart frozen
          if (isDegraded(dataRef.current, nd) && degradedRef.current < DEGRADED_MAX) {
            degradedRef.current += 1;
            setFeedLimited(true);
            return;
          }
          degradedRef.current = 0;
          setFeedLimited(false);
          setData(nd);
        })
        // never fail silently: a chart that can't load says so (and offers a retry)
        // instead of sitting on "loading…" forever
        .catch((e) => alive && setLoadErr(String(e?.message || e)));
    };
    // only blank when the underlying instrument actually changed — a plain
    // timeframe / source switch keeps the current candles on screen and just
    // swaps them in when the new set lands (~1s), so it doesn't flash "loading".
    const symKey = `${symbol}|${instrument}`;
    if (lastSymRef.current !== symKey) {
      setData(null);
      setLoadErr(null);
      lastSymRef.current = symKey;
    }
    const frameKey = `${symKey}|${intervalS}`;
    if (lastFrameRef.current !== frameKey) {
      reframeRef.current = true;
      lastFrameRef.current = frameKey;
      degradedRef.current = 0;
      setFeedLimited(false);
    }
    load(true);
    const t = setInterval(() => load(false), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [symbol, intervalS, instrument, dataSrc, reloadTick]);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  useEffect(() => {
    intervalRef.current = intervalS;
  }, [intervalS]);

  const candles = useMemo(() => data?.candles ?? [], [data]);

  const priceCandles = useMemo(
    () => (ctype === "heikin" ? heikinAshi(candles) : candles),
    [candles, ctype]
  );

  // heavy indicator maths, memoised on the candle set so a re-render that
  // doesn't change the candles (toggles, ticks) doesn't recompute them
  const ind = useMemo(() => {
    const cd = priceCandles;
    const bb = bollinger(cd, 20, 2);
    return {
      ema9: ema(cd, 9),
      ema21: ema(cd, 21),
      ema50: ema(cd, 50),
      sma20: sma(cd, 20),
      vwap: vwap(cd),
      bu: bb.upper,
      bl: bb.lower,
      st: supertrend(cd, 10, 3),
      rsi: rsi(cd, 14),
      macd: macd(cd),
    };
  }, [priceCandles]);
  const prevPriceRef = useRef<{ key: string; candles: Candle[] }>({ key: "", candles: [] });
  useEffect(() => {
    priceCandlesRef.current = priceCandles;
  }, [priceCandles]);

  /** The time of the bar that contains `t`, so a drawing anchored to a time that is no longer exactly a bar (saved
   *  before the 30m-4h bars moved to the 09:15 grid) still lands on the right bar instead of disappearing. Times
   *  outside the loaded candles are left alone. */
  const snapToBar = (t: number): number => {
    const cs = priceCandlesRef.current;
    if (!cs.length) return t;
    if (t < (cs[0].time as number) || t > (cs[cs.length - 1].time as number) + intervalRef.current) return t;
    let lo = 0;
    let hi = cs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((cs[mid].time as number) <= t) lo = mid;
      else hi = mid - 1;
    }
    return cs[lo].time as number;
  };

  useEffect(() => {
    if (!chartRef.current) return;
    if (!data) {
      // a new symbol / instrument is loading: drop the previous chart's candles and
      // overlays, so the old chart never sits on screen under the new name
      Object.values(s.current).forEach((ser) => ser.setData([]));
      prevPriceRef.current = { key: "", candles: [] };
      return;
    }
    const c = s.current;

    // route price data to the selected chart-type series. When only the tail
    // changed (same series, new/updated last bar) patch it in with update()
    // rather than re-seeding the whole array on every 4-15s refresh.
    const asLine = priceCandles.map((k) => ({ time: k.time as any, value: k.close }));
    const pkey = `${symbol}|${instrument}|${intervalS}|${ctype}`;
    const prevP = prevPriceRef.current;
    const canPatch =
      prevP.key === pkey &&
      prevP.candles.length > 0 &&
      priceCandles.length >= prevP.candles.length &&
      priceCandles.length - prevP.candles.length <= 3 &&
      prevP.candles[0]?.time === priceCandles[0]?.time;
    if (canPatch) {
      for (let i = prevP.candles.length - 1; i < priceCandles.length; i++) {
        const k = priceCandles[i];
        (c.candle as ISeriesApi<"Candlestick">).update(k as any);
        (c.barS as ISeriesApi<"Bar">).update(k as any);
        (c.lineS as ISeriesApi<"Line">).update({ time: k.time as any, value: k.close } as any);
        (c.areaS as ISeriesApi<"Area">).update({ time: k.time as any, value: k.close } as any);
      }
    } else {
      (c.candle as ISeriesApi<"Candlestick">).setData(priceCandles as any);
      (c.barS as ISeriesApi<"Bar">).setData(priceCandles as any);
      (c.lineS as ISeriesApi<"Line">).setData(asLine as any);
      (c.areaS as ISeriesApi<"Area">).setData(asLine as any);
    }
    prevPriceRef.current = { key: pkey, candles: priceCandles };
    (c.candle as any).applyOptions({ visible: ctype === "candle" || ctype === "heikin" });
    (c.barS as any).applyOptions({ visible: ctype === "bar" });
    (c.lineS as any).applyOptions({ visible: ctype === "line" });
    (c.areaS as any).applyOptions({ visible: ctype === "area" });

    const setLine = (key: string, pts: Pt[], visible: boolean) => {
      const ser = c[key] as ISeriesApi<"Line">;
      ser.applyOptions({ visible });
      ser.setData((visible ? pts : []) as any);
    };
    const cd = priceCandles;
    setLine("ema9", ind.ema9, eff.ema9);
    setLine("ema21", ind.ema21, eff.ema21);
    setLine("ema50", ind.ema50, eff.ema50);
    setLine("sma20", ind.sma20, eff.sma20);
    setLine("vwap", ind.vwap, eff.vwap && !!data.hasVolume);
    setLine("bu", ind.bu, eff.boll);
    setLine("bl", ind.bl, eff.boll);
    setLine("st", ind.st, eff.supertrend);

    // multi-timeframe indicator overlay (dashed cyan) — indicator computed on
    // candles resampled to `mtf.tf`, then stepped back onto the chart timeline.
    // Price-scale indicators go on c.mtf; oscillators (RSI/MACD) on c.mtf2's
    // hidden auto-scaled axis so their shape reads without swamping price.
    {
      const mser = c.mtf as ISeriesApi<"Line">;
      const mser2 = c.mtf2 as ISeriesApi<"Line">;
      if (mtf && mtf.ind !== "fibpivot" && cd.length && !indHidden) {
        const rc = mtf.tf > (intervalS || 0) ? resampleCandles(cd, mtf.tf) : cd;
        const L = mtf.len || 21;
        let raw: Pt[] = [];
        if (mtf.ind === "ema") raw = ema(rc, L);
        else if (mtf.ind === "sma") raw = sma(rc, L);
        else if (mtf.ind === "vwap") raw = vwap(rc);
        else if (mtf.ind === "boll") raw = bollinger(rc, L, 2).mid;
        else if (mtf.ind === "bollu") raw = bollinger(rc, L, 2).upper;
        else if (mtf.ind === "bolll") raw = bollinger(rc, L, 2).lower;
        else if (mtf.ind === "supertrend") raw = supertrend(rc, mtf.len || 10, 3);
        else if (mtf.ind === "rsi") raw = rsi(rc, mtf.len || 14);
        else if (mtf.ind === "macd") raw = macd(rc).macd;
        else if (mtf.ind === "macdsig") raw = macd(rc).signal;
        const pts = stepOnto(cd, raw);
        const osc = MTF_OSC.has(mtf.ind);
        (osc ? mser2 : mser).setData(pts as any);
        (osc ? mser2 : mser).applyOptions({ visible: pts.length > 0 });
        (osc ? mser : mser2).setData([]);
        (osc ? mser : mser2).applyOptions({ visible: false });
      } else {
        mser.applyOptions({ visible: false });
        mser.setData([]);
        mser2.applyOptions({ visible: false });
        mser2.setData([]);
      }
    }

    // volume
    const vser = c.vol as ISeriesApi<"Histogram">;
    const showVol = eff.vol && !!data.hasVolume;
    chartRef.current.priceScale("vol").applyOptions({ visible: showVol });
    vser.applyOptions({ visible: showVol });
    vser.setData(
      showVol
        ? cd.map((k) => ({
            time: k.time as any,
            value: k.volume ?? 0,
            color: k.close >= k.open ? "#16a34a66" : "#dc262666",
          }))
        : []
    );

    // rsi
    chartRef.current.priceScale("rsi").applyOptions({ visible: eff.rsi });
    const rsiPts = ind.rsi;
    setLine("rsi", rsiPts, eff.rsi);
    lastRsiRef.current = eff.rsi && rsiPts.length ? rsiPts[rsiPts.length - 1].value : null;
    setRsiVal(lastRsiRef.current);

    // macd
    const m = eff.macd ? ind.macd : { macd: [], signal: [], hist: [] };
    chartRef.current.priceScale("macd").applyOptions({ visible: eff.macd });
    (c.macdLine as ISeriesApi<"Line">).applyOptions({ visible: eff.macd });
    (c.macdSig as ISeriesApi<"Line">).applyOptions({ visible: eff.macd });
    (c.macdHist as ISeriesApi<"Histogram">).applyOptions({ visible: eff.macd });
    (c.macdLine as ISeriesApi<"Line">).setData(m.macd as any);
    (c.macdSig as ISeriesApi<"Line">).setData(m.signal as any);
    (c.macdHist as ISeriesApi<"Histogram">).setData(
      m.hist.map((h) => ({ time: h.time as any, value: h.value, color: h.value >= 0 ? "#16a34a66" : "#dc262666" })) as any
    );

    setLine("straddle", dedupe(data.series.straddle), eff.straddle);
    setLine("score", dedupe(data.series.score), eff.score);

    const greekCap = greekSel[0].toUpperCase() + greekSel.slice(1);
    setLine("greeksCe", dedupe(data.series[`ce${greekCap}`]), eff.greeks);
    setLine("greeksPe", dedupe(data.series[`pe${greekCap}`]), eff.greeks);

    // OI overlay — total Call / Put OI lines + day ΔOI columns (from the
    // per-poll chain-history snapshots; dense during a session, sparse otherwise)
    setLine("callOI", dedupe(data.series.ceOI ?? []), eff.oi);
    setLine("putOI", dedupe(data.series.peOI ?? []), eff.oi);
    const chgBars = (key: "ceOIChg" | "peOIChg", col: string) =>
      dedupe(data.series[key] ?? []).map((p) => ({
        time: p.time as any,
        value: p.value,
        color: p.value >= 0 ? col : "#71717199",
      }));
    (c.ceChg as ISeriesApi<"Histogram">).applyOptions({ visible: eff.oichg });
    (c.peChg as ISeriesApi<"Histogram">).applyOptions({ visible: eff.oichg });
    (c.ceChg as ISeriesApi<"Histogram">).setData((eff.oichg ? chgBars("ceOIChg", "#f8717199") : []) as any);
    (c.peChg as ISeriesApi<"Histogram">).setData((eff.oichg ? chgBars("peOIChg", "#4ade8099") : []) as any);

    // ---- stack every lower pane so they never overlap each other, volume,
    //      or the straddle / blast-score overlays (which used to be pinned to
    //      the same bottom slot as RSI/MACD) ----
    {
      type SubKey = "vol" | "oi" | "oichg" | "straddle" | "score" | "greeks" | "rsi" | "macd";
      const sub: SubKey[] = [];
      if (showVol) sub.push("vol");
      if (eff.oi) sub.push("oi");
      if (eff.oichg) sub.push("oichg");
      if (eff.straddle) sub.push("straddle");
      if (eff.score) sub.push("score");
      if (eff.greeks) sub.push("greeks");
      if (eff.rsi) sub.push("rsi");
      if (eff.macd) sub.push("macd");
      const n = sub.length;
      const band = n === 0 ? 0 : n === 1 ? 0.2 : n === 2 ? 0.16 : n === 3 ? 0.13 : n === 4 ? 0.1 : n === 5 ? 0.085 : 0.07;
      const gap = n >= 4 ? 0.02 : 0.03;
      const reserve = n === 0 ? 0.06 : Math.min(0.74, n * band + (n - 1) * gap + 0.05);
      chartRef.current.priceScale("right").applyOptions({
        scaleMargins: { top: 0.06, bottom: reserve },
      });
      let oscTopFrac: number | null = null;
      sub.forEach((p, i) => {
        const bottom = 0.02 + (n - 1 - i) * (band + gap); // i=0 sits highest
        const topFrac = 1 - bottom - band;
        // oscillators (RSI / MACD / Greeks) get their own labelled axis, like
        // a TradingView lower pane -- unlike straddle/score, a bare Greek
        // number (0.51 delta, -14 theta) isn't self-explanatory without one
        const labelled = p === "rsi" || p === "macd" || p === "greeks";
        chartRef.current!.priceScale(p).applyOptions({
          scaleMargins: { top: topFrac, bottom },
          visible: labelled,
        });
        if (labelled && (oscTopFrac == null || topFrac < oscTopFrac))
          oscTopFrac = topFrac;
      });
      setOscTop(oscTopFrac);
    }

    // ---- RSI 30 / 50 / 70 guides + MACD zero line (TradingView-style) ----
    for (const g of rsiGuidesRef.current) {
      try {
        (c.rsi as ISeriesApi<"Line">).removePriceLine(g);
      } catch {
        /* ignore */
      }
    }
    rsiGuidesRef.current = [];
    if (eff.rsi) {
      // guide lines only — no 70 / 30 axis tags; the axis just carries the
      // live RSI value (series lastValueVisible)
      const mk = (price: number, color: string, style: LineStyle) =>
        (c.rsi as ISeriesApi<"Line">).createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle: style,
          axisLabelVisible: false,
          title: "",
        });
      rsiGuidesRef.current = [
        mk(70, "#ef4444aa", LineStyle.Dashed),
        mk(50, "#64748b66", LineStyle.Dotted),
        mk(30, "#22c55eaa", LineStyle.Dashed),
      ];
    }
    if (macdZeroRef.current) {
      try {
        (c.macdHist as ISeriesApi<"Histogram">).removePriceLine(macdZeroRef.current);
      } catch {
        /* ignore */
      }
      macdZeroRef.current = null;
    }
    if (eff.macd) {
      macdZeroRef.current = (c.macdHist as ISeriesApi<"Histogram">).createPriceLine({
        price: 0,
        color: "#64748b66",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: "",
      });
    }

    // first candles for a new symbol / instrument / interval: always re-frame (the
    // "don't snap back" guard compares the old view position with the NEW candle
    // count and could otherwise leave the chart parked on a stale stretch)
    const reframe = reframeRef.current && priceCandles.length > 0;
    if (reframe) reframeRef.current = false;
    applyRange(reframe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceCandles, ctype, data, eff, mtf, indHidden, intervalS, greekSel]);

  // clamp the visible window to the chosen lookback (1D / 3M / 6M / 1Y / All).
  // `force` = a deliberate re-frame (window / instrument / interval change or the
  // reset button). On a plain data refresh we DON'T re-frame if the user has
  // scrolled back to study an earlier stretch — that was snapping their view
  // back to "now" on every poll.
  const applyRange = (force: boolean) => {
    const ts = chartRef.current?.timeScale();
    if (!ts || priceCandles.length === 0) return;
    if (!force) {
      const vr = ts.getVisibleLogicalRange();
      if (vr) {
        const scrolledAway = vr.to < priceCandles.length - 2; // panned back from the live edge
        const applied = lastAppliedRangeRef.current;
        // zoomed in/out manually: bar count on screen no longer matches what we last set —
        // width alone (not position) so the built-in realtime auto-scroll (which translates
        // from/to together, same width) doesn't get mistaken for a manual zoom
        const zoomed = !!applied && Math.abs(vr.to - vr.from - (applied.to - applied.from)) > 0.5;
        if (scrolledAway || zoomed) return;
      }
    }
    if (rangeD <= 0) {
      ts.fitContent();
    } else {
      const last = priceCandles[priceCandles.length - 1].time as number;
      const first = priceCandles[0].time as number;
      const from = Math.max(first, last - rangeD * 86400);
      try {
        ts.setVisibleRange({ from: from as any, to: last as any });
      } catch {
        ts.fitContent();
      }
    }
    lastAppliedRangeRef.current = ts.getVisibleLogicalRange();
  };
  // deliberate re-frames: window change, or instrument / interval switch
  useEffect(() => applyRange(true), [rangeD]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => applyRange(true), [symbol, instrument, intervalS]); // eslint-disable-line react-hooks/exhaustive-deps

  // switching to Daily candles while still on an intraday-sized visible
  // window (e.g. the "1D" range preset) would only fit a couple of daily
  // bars on screen -- default it out to 6 months, same as a human would.
  useEffect(() => {
    if (pendingRangeRef.current != null) return; // a layout is setting its own window
    if (intervalS >= 86400 && rangeD > 0 && rangeD < 180) setRangeD(180);
  }, [intervalS]); // eslint-disable-line react-hooks/exhaustive-deps

  // mirror case: coming back down to an intraday timeframe while the window
  // is still sized for daily browsing (left over from the case above, or a
  // manual pick) would try to cram months of intraday bars on screen --
  // snap back to that timeframe's default window.
  useEffect(() => {
    if (pendingRangeRef.current != null) {
      setRangeD(pendingRangeRef.current);
      pendingRangeRef.current = null;
      return;
    }
    if (intervalS < 86400) setRangeD(defaultRangeDays(intervalS));
  }, [intervalS]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    chartRef.current?.timeScale().applyOptions({ visible: showTime });
  }, [showTime]);

  // live last-price nudge — move the last candle toward the latest price for
  // whatever instrument is charted: the underlying tick, the charted option
  // leg's LTP, or the ATM straddle — not always the underlying spot.
  const tickAgeOk = !!liveTick && Date.now() / 1000 - liveTick.ts < 15;
  useEffect(() => {
    tickFreshRef.current = tickAgeOk;
  }, [tickAgeOk]);
  useEffect(() => {
    feedDownRef.current = feedStale;
  }, [feedStale]);

  const optLegPx = useMemo(() => {
    if (!isOption || !chain) return null;
    const [sym, , kS, ot] = instrument.split("|");
    if (sym !== chain.symbol) return null;
    const row = chain.rows.find((r) => r.strike === Number(kS));
    const leg = row && (ot === "CE" ? row.call : row.put);
    return leg && leg.ltp != null ? leg.ltp : null;
  }, [isOption, instrument, chain]);

  // only trust the chain if it belongs to the symbol on screen (a late response for a
  // symbol you've stepped past must never nudge this chart's last candle)
  const chainMine = chain?.symbol === symbol ? chain : null;
  const livePx = isOption
    ? optLegPx
    : instrument.toUpperCase() === "STRADDLE"
    ? chainMine?.atmStraddle ?? null
    : tickAgeOk
    ? liveTick!.ltp
    : chainMine?.spot ?? null;

  useEffect(() => {
    if (!chartRef.current || !data || !priceCandles.length || livePx == null) return;
    const last = priceCandles[priceCandles.length - 1];
    // only the bar that is still forming moves with the live price: nudging a
    // closed one (yesterday's daily bar when today's hasn't arrived, the 15:29
    // bar after the close) repaints it with today's price
    if (bucketStart(Math.floor(Date.now() / 1000), intervalS) !== (last.time as number)) return;
    if (ctype === "line") {
      (s.current.lineS as ISeriesApi<"Line">).update({ time: last.time as any, value: livePx });
      return;
    }
    if (ctype === "area") {
      (s.current.areaS as ISeriesApi<"Area">).update({ time: last.time as any, value: livePx });
      return;
    }
    const bar = {
      time: last.time as any,
      open: last.open,
      high: Math.max(last.high, livePx),
      low: Math.min(last.low, livePx),
      close: livePx,
    };
    (s.current.candle as ISeriesApi<"Candlestick">).update(bar);
    (s.current.barS as ISeriesApi<"Bar">).update(bar);
  }, [livePx, symbol, priceCandles, data, ctype, intervalS]);

  // candlestick patterns: a symbol on the bar that completes one. Found on the REAL
  // candles (not Heikin-Ashi) and on closed bars only -- the forming bar would
  // flash a pattern in and out with every tick.
  useEffect(() => {
    const c = s.current;
    if (!chartRef.current || !c.candle) return;
    const priceType = (ctype === "candle" || ctype === "heikin" || ctype === "bar") && candles.length > 0;
    const closed =
      candles.length && bucketStart(Math.floor(Date.now() / 1000), intervalS) === (candles[candles.length - 1].time as number)
        ? candles.slice(0, -1)
        : candles;
    // 30m..4h bars sit on the 09:15 grid, so the day's last one can be a stub (1h: 15:15-15:30
    // is 15 min). A stub compared with full bars reads as a harami / doji / crow that isn't
    // there -- candle patterns skip any bar shorter than half the timeframe.
    const CLOSE_S = 15 * 3600 + 30 * 60;
    const full =
      intervalS >= 1800 && intervalS < 86400
        ? closed.filter((k) => {
            const sod = ((k.time as number) + 19800) % 86400;
            return Math.min(sod + intervalS, CLOSE_S) - sod >= intervalS / 2;
          })
        : closed;
    const hits: PatternHit[] = priceType && eff.patterns ? detectPatterns(full) : [];
    // range boxes / opening range / double tops, H&S, triangles -- lines + breakout markers
    const auto =
      priceType && (eff.ranges || eff.chartpat || eff.structure)
        ? detectChartPatterns(closed, intervalS, { ranges: eff.ranges, patterns: eff.chartpat, structure: eff.structure })
        : { shapes: [], events: [] };
    autoPrimRef.current?.candle.setShapes(ctype === "bar" ? [] : auto.shapes);
    autoPrimRef.current?.bar.setShapes(ctype === "bar" ? auto.shapes : []);
    const evMap = new Map<number, ChartEvent[]>();
    auto.events.forEach((e) => evMap.set(e.time, [...(evMap.get(e.time) ?? []), e]));
    eventsRef.current = evMap;
    patternsRef.current = new Map(hits.map((h) => [h.time, h]));
    // labels on bars close together run into each other on a phone ("HRIH"): a
    // pattern closer than ~26 px (at this zoom) to the previous labelled one on
    // the same side keeps its arrow and drops the label (the crosshair legend
    // still names it); zooming in brings the labels back
    const gap = Math.max(1, Math.ceil(26 / Math.max(0.5, barSpacing)));
    const idx = new Map(candles.map((k, i) => [k.time as number, i]));
    const lastAt: Record<string, number> = {};
    const markers = hits.map((h) => {
      const side = h.bias === "bull" ? "below" : "above";
      const i = idx.get(h.time) ?? 0;
      const crowded = lastAt[side] != null && i - lastAt[side] < gap;
      if (!crowded) lastAt[side] = i;
      return { h, text: crowded ? "" : h.short };
    }).map(({ h, text }) => ({
      time: h.time as any,
      position: h.bias === "bull" ? ("belowBar" as const) : ("aboveBar" as const),
      shape: h.bias === "bull" ? ("arrowUp" as const) : h.bias === "bear" ? ("arrowDown" as const) : ("circle" as const),
      color: h.bias === "bull" ? "#16a34a" : h.bias === "bear" ? "#dc2626" : "#eab308",
      text,
      size: 1,
    }));
    // breakouts always keep their label (they're the point); markers must be time-sorted
    const evMarkers = auto.events.map((e) => ({
      time: e.time as any,
      position: e.dir === "up" ? ("belowBar" as const) : ("aboveBar" as const),
      shape: e.dir === "up" ? ("arrowUp" as const) : ("arrowDown" as const),
      color: e.dir === "up" ? "#16a34a" : "#dc2626",
      text: e.short,
      size: 2,
    }));
    markers.push(...evMarkers);
    markers.sort((x, y) => (x.time as number) - (y.time as number));
    (c.candle as ISeriesApi<"Candlestick">).setMarkers(ctype === "bar" ? [] : markers);
    (c.barS as ISeriesApi<"Bar">).setMarkers(ctype === "bar" ? markers : []);
  }, [candles, priceCandles, data, eff.patterns, eff.ranges, eff.chartpat, eff.structure, ctype, intervalS, barSpacing]);

  // log / linear price scale
  useEffect(() => {
    chartRef.current
      ?.priceScale("right")
      .applyOptions({ mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
  }, [logScale]);

  // sync drawn horizontal lines (the "hline" subset of `drawings`)
  useEffect(() => {
    const cs = s.current.candle as ISeriesApi<"Candlestick"> | undefined;
    if (!cs) return;
    plRefs.current.forEach((pl) => cs.removePriceLine(pl));
    plRefs.current = drawings
      .filter((d): d is Drawing & { type: "hline" } => d.type === "hline")
      .map((d) =>
        cs.createPriceLine({
          price: d.price,
          color: "#eab308",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: String(d.price),
        })
      );
  }, [drawings, data]);

  // sync drawn trendlines / fib retracements (the two-point subset of
  // `drawings`) to attached chart primitives -- diff against what's
  // currently attached rather than detach-all/reattach-all, so an in-place
  // edit (none exist yet, but this keeps it correct if one's added later)
  // wouldn't flicker.
  useEffect(() => {
    const cs = s.current.candle as ISeriesApi<"Candlestick"> | undefined;
    if (!cs) return;
    const wanted = new Map(
      drawings.filter((d) => d.type === "trend" || d.type === "fib").map((d) => [d.id, d])
    );
    const live = linePrimitives.current;
    for (const [id, prim] of live) {
      if (!wanted.has(id)) {
        cs.detachPrimitive(prim);
        live.delete(id);
      }
    }
    for (const [id, d] of wanted) {
      if (!live.has(id)) {
        const prim = new DrawingPrimitive(d as any);
        prim.snap = snapToBar;
        cs.attachPrimitive(prim);
        live.set(id, prim);
      }
    }
  }, [drawings, data]);

  // disable pan/zoom while actively drawing a trendline/fib so the drag
  // gesture draws instead of panning the chart out from under it
  useEffect(() => {
    const active = drawTool === "trend" || drawTool === "fib";
    chartRef.current?.applyOptions({ handleScroll: !active, handleScale: !active });
  }, [drawTool]);

  // load this chart's saved drawings whenever "what is this a chart of"
  // changes (matches how a trendline on NIFTY 5m shouldn't show up on NIFTY
  // 1D or a NIFTY option leg's own chart)
  const drawKey = `${instrument || symbol}|${intervalS}`;
  useEffect(() => {
    let alive = true;
    // a view-only user starts clean: the saved drawings are the owner's
    if (isViewer()) {
      setDrawings([]);
      return;
    }
    api.chartDrawings(drawKey).then(
      (d) => alive && setDrawings(Array.isArray(d.drawings) ? (d.drawings as Drawing[]) : []),
      () => alive && setDrawings([])
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawKey]);

  // debounce-persist on any add/delete -- not on every pointermove. Skip the
  // render where drawKey just changed: `drawings` on that render still
  // describes the OLD key (the load for the new key hasn't resolved yet),
  // so saving there would write the old symbol's drawings under the new
  // key. Once drawKey has "settled" for a render, any drawings change on
  // that same key is a real edit (or the harmless redundant save-back of
  // what was just loaded) and is safe to persist.
  const prevDrawKeyRef = useRef(drawKey);
  useEffect(() => {
    if (prevDrawKeyRef.current !== drawKey) {
      prevDrawKeyRef.current = drawKey;
      return;
    }
    const t = setTimeout(() => {
      if (!isViewer()) api.saveChartDrawings(drawKey, drawings).catch(() => {});
    }, 1000);
    return () => clearTimeout(t);
  }, [drawings, drawKey]);

  // pivot points from the previous session — classic or Fibonacci (PP / R1-3 / S1-3)
  useEffect(() => {
    const cs = s.current.candle as ISeriesApi<"Candlestick"> | undefined;
    if (!cs) return;
    pvtRefs.current.forEach((pl) => cs.removePriceLine(pl));
    pvtRefs.current = [];
    if (!eff.pivot && !eff.fibpivot) return;
    const fib = eff.fibpivot; // fib wins if both are on
    const p = pivots(priceCandles, fib);
    if (!p) return;
    const tag = fib ? "f" : "";
    const rows: [string, number, string, LineStyle][] = [
      [`${tag}R3`, p.r3, "#f87171", LineStyle.Dotted],
      [`${tag}R2`, p.r2, "#f87171", LineStyle.Dashed],
      [`${tag}R1`, p.r1, "#f87171", LineStyle.Dashed],
      [`${tag}PP`, p.pp, "#eab308", LineStyle.Solid],
      [`${tag}S1`, p.s1, "#4ade80", LineStyle.Dashed],
      [`${tag}S2`, p.s2, "#4ade80", LineStyle.Dashed],
      [`${tag}S3`, p.s3, "#4ade80", LineStyle.Dotted],
    ];
    pvtRefs.current = rows.map(([title, price, color, lineStyle]) =>
      cs.createPriceLine({
        price: Number(price.toFixed(2)),
        color,
        lineWidth: 1,
        lineStyle,
        axisLabelVisible: true,
        title,
      })
    );
  }, [eff.pivot, eff.fibpivot, priceCandles, data]);

  // MTF Fib Pivots — same PP/R1-3/S1-3 math as above, but driven by the MTF
  // picker's own period (Day/Week/Month) instead of always "previous day",
  // and kept on a separate ref array so it can coexist with the plain
  // same-timeframe toggle above (dashed to tell them apart at a glance).
  useEffect(() => {
    const cs = s.current.candle as ISeriesApi<"Candlestick"> | undefined;
    if (!cs) return;
    mtfPvtRefs.current.forEach((pl) => cs.removePriceLine(pl));
    mtfPvtRefs.current = [];
    if (!mtf || mtf.ind !== "fibpivot" || indHidden) return;
    const p = pivots(priceCandles, true, mtf.period ?? "D");
    if (!p) return;
    const tag = { D: "D", W: "W", M: "M" }[mtf.period ?? "D"];
    const rows: [string, number, string][] = [
      [`${tag}R3`, p.r3, "#22d3ee"],
      [`${tag}R2`, p.r2, "#22d3ee"],
      [`${tag}R1`, p.r1, "#22d3ee"],
      [`${tag}PP`, p.pp, "#67e8f9"],
      [`${tag}S1`, p.s1, "#22d3ee"],
      [`${tag}S2`, p.s2, "#22d3ee"],
      [`${tag}S3`, p.s3, "#22d3ee"],
    ];
    mtfPvtRefs.current = rows.map(([title, price, color]) =>
      cs.createPriceLine({
        price: Number(price.toFixed(2)),
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title,
      })
    );
  }, [mtf, priceCandles, data, indHidden]);

  // dealer gamma-flip level (see lib/gammaFlip.ts — same formula OI Profile's
  // "weekly gex" panel and chart marker use), drawn as one reference line
  useEffect(() => {
    const cs = s.current.candle as ISeriesApi<"Candlestick"> | undefined;
    if (!cs) return;
    if (gfRef.current) {
      cs.removePriceLine(gfRef.current);
      gfRef.current = null;
    }
    if (!eff.gammaFlip || !chain?.rows.length) return;
    const gf = computeGammaFlip(chain.rows, chain.liveSpot?.ltp ?? chain.spot);
    if (!gf) return;
    gfRef.current = cs.createPriceLine({
      price: Number(gf.strike.toFixed(2)),
      color: "#e879f9",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "γ-flip",
    });
  }, [eff.gammaFlip, chain?.rows, data]);

  // what the on-canvas loading / error / empty message calls this chart
  const chartLabel = isOption
    ? instrument.split("|").filter((_, i) => i !== 1).join(" ")
    : instrument.toUpperCase() === "STRADDLE"
    ? `${symbol} straddle`
    : symbol;
  const noCandles = !!data && priceCandles.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TrendCompass symbol={symbol} />
      {!barOpen && (
        <div className="flex items-center gap-1 self-start rounded-br border-b border-r border-term-border bg-term-panel2 px-1.5 py-0.5 text-2xs">
          <button
            onClick={() => setBar(true)}
            title="Show the chart settings bar"
            className="rounded border border-term-accent/50 bg-term-accent/15 px-2 py-0.5 font-semibold text-term-text hover:bg-term-accent/25"
          >
            ⚙ settings
          </button>
          <ChartStepper />
          <button
            onClick={() => setInd(!indHidden)}
            title={indHidden ? "Show indicators" : "Hide all indicators"}
            className={`rounded border px-2 py-0.5 font-semibold ${
              indHidden
                ? "border-amber-500/60 bg-amber-500/15 text-amber-400"
                : "border-term-dim/70 text-term-dim hover:text-term-text"
            }`}
          >
            {indHidden ? "▨ ind off" : "▨ hide ind"}
          </button>
        </div>
      )}
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs"
        style={barOpen ? undefined : { display: "none" }}
      >
        {view !== "scalper" && (
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                ["chain", "Chain"],
                ["scrip", "OI"],
                ["trendingoi", "Trend OI"],
                ["flow", "Flow"],
                ["oiprofile", "OI Profile"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                title={`Open ${label} for ${symbol}`}
                className={`rounded border px-2 py-0.5 ${
                  view === v
                    ? "border-term-accent/50 bg-term-accent/15 text-term-text"
                    : "border-term-dim/70 text-term-dim hover:bg-term-border hover:text-term-text"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <SelectMenu
          value={symbol}
          options={symOptions.map((s) => [s, s] as [string, string])}
          onChange={(v) => selectSymbol(v, true)}
          title="Index / stock to chart"
          width={150}
        />
        <ChartStepper />
        <SelectMenu
          value={instrument}
          options={[
            [`${symbol} spot`, ""],
            [`${symbol} ATM straddle`, "STRADDLE"],
            ...instrOptions.map(
              (w) => [`${w.symbol} ${w.strike} ${w.optionType}`, w.key] as [string, string]
            ),
          ]}
          onChange={setInstrument}
          title="Instrument to chart"
          width={170}
        />

        <button
          onClick={() =>
            setSplit((v) => {
              const next = !v;
              if (next) setCmpInstrument(instrument === "" ? "STRADDLE" : "");
              return next;
            })
          }
          className={`rounded border px-1.5 py-0.5 ${
            split ? "border-term-accent/50 bg-term-accent/15 text-term-text" : "border-term-dim/70 text-term-dim hover:bg-term-border hover:text-term-text"
          }`}
          title="Split view — underlying + derivative in one window"
        >
          ⊞ Split
        </button>
        {split && (
          <SelectMenu
            value={cmpInstrument}
            options={[
              [`${symbol} spot`, ""],
              [`${symbol} ATM straddle`, "STRADDLE"],
              ...instrOptions.map(
                (w) => [`${w.symbol} ${w.strike} ${w.optionType}`, w.key] as [string, string]
              ),
            ]}
            onChange={setCmpInstrument}
            title="Second pane instrument"
            width={170}
          />
        )}

        {/* pick any strike's CE / PE */}
        {strikes.length > 0 && (
          <div className="flex items-center gap-0.5 rounded border border-term-dim/70 px-1">
            <SelectMenu
              value={pickStrike}
              options={shownStrikes.map(
                (k) =>
                  [`${k}${k === chain?.atmStrike ? " (ATM)" : ""}`, k] as [string, number]
              )}
              onChange={(k) => setPickStrike(Number(k))}
              title="Strike to chart"
              width={100}
              highlightValue={chain?.atmStrike}
            />
            <button
              onClick={() => chartLeg("CE")}
              className={`rounded border px-1 text-[10px] font-bold ${
                instrument === `${symbol}|${chain?.expiry}|${pickStrike}|CE`
                  ? "border-up bg-up text-white"
                  : "border-up/50 text-up hover:bg-up/20"
              }`}
            >
              CE
            </button>
            <button
              onClick={() => chartLeg("PE")}
              className={`rounded border px-1 text-[10px] font-bold ${
                instrument === `${symbol}|${chain?.expiry}|${pickStrike}|PE`
                  ? "border-down bg-down text-white"
                  : "border-down/70 text-down hover:bg-down/20"
              }`}
            >
              PE
            </button>
          </div>
        )}

        {/* fast execution -- BUY / SELL the contract this chart is showing, at scalpLots.
            An index / the straddle can't be bought itself: greyed out until a CE / PE is charted. */}
        {(() => {
          const [iSym, iExp, iK, iOt] = isOption ? instrument.split("|") : [];
          const tradable = isOption && !!iExp && Number(iK) > 0 && (iOt === "CE" || iOt === "PE");
          const what = tradable ? `${iSym} ${iK} ${iOt}` : "";
          const go = (side: "BUY" | "SELL") =>
            tradable && quickTradeAt(iSym, iExp, Number(iK), iOt as "CE" | "PE", side);
          return (
            <div
              className="flex items-center gap-1 rounded border border-term-dim/70 px-1"
              title={tradable ? `${what} × ${scalpLots} lot(s)` : "Chart a CE or PE (buttons on the left) to trade it from here"}
            >
              <button
                disabled={!tradable}
                onClick={() => go("BUY")}
                className="rounded bg-up px-2 py-0.5 text-[10px] font-bold text-white hover:bg-up/80 disabled:bg-term-border disabled:text-term-dim"
              >
                BUY
              </button>
              <button
                disabled={!tradable}
                onClick={() => go("SELL")}
                className="rounded bg-down px-2 py-0.5 text-[10px] font-bold text-white hover:bg-down/80 disabled:bg-term-border disabled:text-term-dim"
              >
                SELL
              </button>
              <span className="whitespace-nowrap text-[10px] text-term-dim">
                {tradable ? `${iK} ${iOt} · ${scalpLots} lot${scalpLots === 1 ? "" : "s"}` : "chart a CE / PE"}
              </span>
            </div>
          );
        })()}

        <SelectMenu
          value={intervalS}
          options={TIMEFRAMES}
          onChange={setIntervalS}
          title="Candle timeframe"
        />

        <SelectMenu
          value={rangeD}
          options={
            [
              ["1D", 1],
              ["7D", 7],
              ["15D", 15],
              ["1M", 30],
              ["3M", 90],
              ["6M", 180],
              ["1Y", 365],
              ["All", 0],
            ] as const
          }
          onChange={setRangeD}
          title="Visible history window"
          width={100}
        />

        <SelectMenu
          value={dataSrc}
          options={
            [
              ["Src: Auto", "auto"],
              ["Src: Flattrade", "broker"],
              ["Src: Upstox", "upstox"],
            ] as const
          }
          onChange={(v) => setDataSrc(v as any)}
          title="Candle data source"
          width={120}
        />

        <SelectMenu
          value={ctype}
          options={
            [
              ["Candles", "candle"],
              ["Heikin-Ashi", "heikin"],
              ["Bars", "bar"],
              ["Line", "line"],
              ["Area", "area"],
            ] as const
          }
          onChange={(v) => setCtype(v as any)}
          title="Chart type"
          width={120}
        />
        <button
          onClick={() => setLogScale((v) => !v)}
          className={`rounded border px-1.5 py-0.5 ${
            logScale ? "border-term-accent/50 bg-term-accent/15 text-term-text" : "border-term-dim/70 text-term-dim hover:bg-term-border hover:text-term-text"
          }`}
          title="Logarithmic price scale"
        >
          Log
        </button>
        <div className="seg">
          {(
            [
              ["hline", "─ Line"],
              ["trend", "╱ Trend"],
              ["fib", "Fib"],
            ] as const
          ).map(([t, label]) => (
            <button
              key={t}
              onClick={() => setDrawTool((cur) => (cur === t ? "none" : t))}
              className={drawTool === t ? "on" : ""}
              title={
                t === "hline"
                  ? "Click the chart to drop a horizontal line"
                  : t === "trend"
                  ? "Drag on the chart to draw a trendline"
                  : "Drag on the chart to draw a Fib retracement"
              }
            >
              {label}
            </button>
          ))}
        </div>
        {drawings.length > 0 && (
          <span className="relative">
            <button
              onClick={() => setDrawingsOpen((o) => !o)}
              className={`rounded border px-1.5 py-0.5 ${
                drawingsOpen
                  ? "border-term-accent/50 bg-term-accent/15 text-term-text"
                  : "border-term-dim/70 text-term-dim hover:bg-term-border hover:text-term-text"
              }`}
              title="Drawings on this chart"
            >
              ✎ {drawings.length}
            </button>
            {drawingsOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setDrawingsOpen(false)} />
                <div className="absolute left-0 top-full z-50 mt-1 max-h-[50vh] w-[220px] overflow-y-auto rounded-lg border border-term-border bg-term-panel p-1.5 text-2xs shadow-2xl">
                  <div className="flex items-center justify-between px-1 py-1 text-term-dim">
                    <span className="font-semibold uppercase tracking-wide">Drawings</span>
                    <button
                      onClick={() => {
                        setDrawings([]);
                        setDrawingsOpen(false);
                      }}
                      className="underline underline-offset-2 hover:text-down"
                    >
                      clear all
                    </button>
                  </div>
                  {drawings.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-term-border"
                    >
                      <span className="truncate text-term-text">{describeDrawing(d)}</span>
                      <button
                        onClick={() => setDrawings((ds) => ds.filter((x) => x.id !== d.id))}
                        className="shrink-0 text-term-dim hover:text-down"
                        title="Delete"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </span>
        )}
        <button
          onClick={() => applyRange(true)}
          className="rounded border border-term-dim/70 px-1.5 py-0.5 text-term-dim hover:text-term-text"
          title="Reset view to the selected window"
        >
          ⤢
        </button>
        <button
          onClick={toggleTime}
          className={`rounded border px-2 py-0.5 font-semibold ${
            showTime
              ? "border-term-dim/70 text-term-dim hover:text-term-text"
              : "border-amber-500/60 bg-amber-500/15 text-amber-400"
          }`}
          title="Show / hide the time axis labels"
        >
          {showTime ? "🕒 time" : "🕒 time off"}
        </button>

        {/* multi-timeframe indicator overlay */}
        <span className="relative">
          <button
            onClick={() => setMtfOpen((o) => !o)}
            title="Multi-timeframe indicator overlay"
            className={`rounded border px-2 py-0.5 font-semibold ${
              mtfOpen || mtf
                ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-200"
                : "border-term-dim/70 text-term-dim hover:bg-term-border hover:text-term-text"
            }`}
          >
            MTF
            {mtf
              ? ` · ${MTF_INDS.find(([v]) => v === mtf.ind)?.[1] ?? mtf.ind}`
              : ""}
          </button>
          {mtfOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMtfOpen(false)} />
              <div className="absolute left-0 top-full z-50 mt-1 w-[210px] space-y-1.5 rounded-lg border border-term-border bg-term-panel p-3 text-2xs shadow-2xl">
                <div className="flex items-center justify-between text-term-dim">
                  <span className="font-semibold uppercase tracking-wide">MTF overlay</span>
                  {mtf && (
                    <button onClick={() => setMtf(null)} className="underline underline-offset-2 hover:text-down">
                      off
                    </button>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-term-dim">Indicator</span>
                  <SelectMenu
                    value={mtf?.ind ?? ""}
                    options={[
                      ["off", ""],
                      ...MTF_INDS.map(([v, l]) => [l, v] as [string, string]),
                    ]}
                    onChange={(v) =>
                      setMtf(
                        v ? { ind: v, len: mtf?.len ?? 21, tf: mtf?.tf ?? 900 } : null
                      )
                    }
                    title="MTF indicator"
                    align="right"
                    width={150}
                  />
                </div>
                {mtf && mtf.ind !== "vwap" && mtf.ind !== "fibpivot" && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-term-dim">Length</span>
                    <input
                      type="number"
                      min={2}
                      max={400}
                      value={mtf.len}
                      onChange={(e) =>
                        setMtf({ ...mtf, len: Math.max(2, Number(e.target.value) || 21) })
                      }
                      className="w-16 rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text outline-none focus:border-term-accent"
                    />
                  </div>
                )}
                {mtf && mtf.ind === "fibpivot" ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-term-dim">Pivot period</span>
                    <div className="segx">
                      {(
                        [
                          ["D", "Day"],
                          ["W", "Week"],
                          ["M", "Month"],
                        ] as [PivotPeriod, string][]
                      ).map(([p, l]) => (
                        <button
                          key={p}
                          onClick={() => setMtf({ ...mtf, period: p })}
                          className={`px-1.5 py-0.5 ${
                            (mtf.period ?? "D") === p
                              ? "bg-cyan-500/25 text-cyan-200"
                              : "text-term-dim hover:bg-term-border hover:text-term-text"
                          }`}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  mtf && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-term-dim">On timeframe</span>
                      <SelectMenu
                        value={mtf.tf}
                        options={TIMEFRAMES.map(([l, v]) => ["@ " + l, v] as [string, number])}
                        onChange={(v) => setMtf({ ...mtf, tf: v })}
                        title="MTF source timeframe"
                        align="right"
                        width={110}
                      />
                    </div>
                  )
                )}
              </div>
            </>
          )}
        </span>

        <button
          onClick={() => setInd(!indHidden)}
          className={`rounded border px-2 py-0.5 font-semibold ${
            indHidden
              ? "border-amber-500/60 bg-amber-500/15 text-amber-400"
              : "border-term-dim/70 text-term-dim hover:text-term-text"
          }`}
          title={
            indHidden
              ? "Indicators hidden — click to bring your overlays back"
              : "Hide every indicator / overlay (price only)"
          }
        >
          {indHidden ? "▨ indicators off" : "▨ hide indicators"}
        </button>
        <button
          onClick={() => setBar(false)}
          className="rounded border border-term-accent/50 bg-term-accent/15 px-2 py-0.5 font-semibold text-term-text hover:bg-term-accent/25"
          title="Hide the whole settings bar for a bigger chart"
        >
          ⌃ hide bar
        </button>

        <span className="relative">
          <button
            onClick={() => setFxOpen((o) => !o)}
            title="Indicators"
            className={`rounded border px-2 py-0.5 font-semibold ${
              fxOpen || activeInd
                ? "border-term-accent/50 bg-term-accent/15 text-term-text"
                : "border-term-dim/70 text-term-dim hover:bg-term-border hover:text-term-text"
            }`}
          >
            ƒx{activeInd ? ` · ${activeInd}` : ""}
          </button>
          {fxOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setFxOpen(false)} />
              <div className="absolute left-0 top-full z-50 mt-1 max-h-[60vh] w-[190px] overflow-y-auto rounded-lg border border-term-border bg-term-panel p-1 text-2xs shadow-2xl">
                <div className="flex items-center justify-between px-2 py-1 text-term-dim">
                  <span className="font-semibold uppercase tracking-wide">Indicators</span>
                  {activeInd > 0 && (
                    <button
                      onClick={() =>
                        setOn((o) => {
                          const z = { ...o };
                          (Object.keys(z) as ToggleKey[]).forEach((k) => {
                            if (!PATTERN_KEYS.has(k)) z[k] = false;
                          });
                          return z;
                        })
                      }
                      className="underline underline-offset-2 hover:text-down"
                    >
                      clear
                    </button>
                  )}
                </div>
                {TOGGLES.filter(([k]) => !PATTERN_KEYS.has(k)).map(([k, lbl]) => {
                  const dis = isOption && (k === "straddle" || k === "score" || k === "greeks");
                  return (
                    <div key={k}>
                      <button
                        disabled={dis}
                        onClick={() => setOn((o) => ({ ...o, [k]: !o[k] }))}
                        className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left ${
                          dis
                            ? "cursor-not-allowed text-term-dim/40"
                            : on[k]
                            ? "bg-term-accent/15 text-term-text"
                            : "text-term-dim hover:bg-term-border hover:text-term-text"
                        }`}
                      >
                        <span>{lbl}</span>
                        {on[k] && <span className="text-term-accent">✓</span>}
                      </button>
                      {k === "greeks" && on.greeks && !dis && (
                        <div
                          className="mb-1 mt-0.5 ml-2 grid grid-cols-2 gap-1 overflow-hidden rounded border border-term-dim/70"
                          title="ATM call (red) / put (green) — from the same per-poll history the live chain reads"
                        >
                          {(["delta", "gamma", "theta", "vega"] as const).map((g) => (
                            <button
                              key={g}
                              onClick={(e) => {
                                e.stopPropagation();
                                setGreek(g);
                              }}
                              className={`px-1.5 py-0.5 capitalize ${
                                greekSel === g
                                  ? "bg-term-accent/25 text-term-text"
                                  : "text-term-dim hover:bg-term-border hover:text-term-text"
                              }`}
                            >
                              {g}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {indHidden && activeInd > 0 && (
                  <div className="px-2 py-1 text-[9px] text-amber-400">
                    indicators are hidden — “▨ hide indicators” to show them
                  </div>
                )}
              </div>
            </>
          )}
        </span>
        <span className="relative">
          <button
            onClick={() => setPatOpen((o) => !o)}
            title="Candle patterns, range breakouts, chart patterns, market structure"
            className={`rounded border px-2 py-0.5 font-semibold ${
              patOpen || activePat
                ? "border-amber-500/50 bg-amber-500/15 text-term-text"
                : "border-term-dim/70 text-term-dim hover:bg-term-border hover:text-term-text"
            }`}
          >
            ◇ Patterns{activePat ? ` · ${activePat}` : ""}
          </button>
          {patOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setPatOpen(false)} />
              <div className="absolute left-0 top-full z-50 mt-1 max-h-[60vh] w-[210px] overflow-y-auto rounded-lg border border-term-border bg-term-panel p-1 text-2xs shadow-2xl">
                <div className="flex items-center justify-between px-2 py-1 text-term-dim">
                  <span className="font-semibold uppercase tracking-wide">Patterns</span>
                  <button
                    onClick={() =>
                      setOn((o) => {
                        const all = [...PATTERN_KEYS].every((k) => o[k]);
                        const z = { ...o };
                        PATTERN_KEYS.forEach((k) => (z[k] = !all));
                        return z;
                      })
                    }
                    className="underline underline-offset-2 hover:text-term-text"
                  >
                    {activePat === PATTERN_KEYS.size ? "none" : "all"}
                  </button>
                </div>
                {TOGGLES.filter(([k]) => PATTERN_KEYS.has(k)).map(([k, lbl]) => (
                  <div key={k}>
                    <button
                      onClick={() => setOn((o) => ({ ...o, [k]: !o[k] }))}
                      className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left ${
                        on[k] ? "bg-amber-500/15 text-term-text" : "text-term-dim hover:bg-term-border hover:text-term-text"
                      }`}
                    >
                      <span>{lbl}</span>
                      {on[k] && <span className="text-amber-400">✓</span>}
                    </button>
                      {k === "patterns" && on.patterns && (
                        <div className="mb-1 ml-2 mt-0.5 grid grid-cols-1 gap-y-0.5 rounded border border-term-dim/40 px-1.5 py-1 text-[10px]">
                          {PATTERN_LEGEND.map((p) => (
                            <div key={p.name} className="flex items-center gap-1.5">
                              <span
                                className={`w-11 shrink-0 whitespace-nowrap font-semibold ${
                                  p.bias === "bull" ? "text-up" : p.bias === "bear" ? "text-down" : "text-amber-400"
                                }`}
                              >
                                {p.bias === "bull" ? "▲" : p.bias === "bear" ? "▼" : "●"} {p.short}
                              </span>
                              <span className="text-term-dim">{p.name}</span>
                            </div>
                          ))}
                          <div className="mt-0.5 text-[9px] leading-snug text-term-dim">
                            Marked when the bar closes. Reversal patterns only count after a move into them.
                          </div>
                        </div>
                      )}
                      {k === "ranges" && on.ranges && (
                        <div className="mb-1 ml-2 mt-0.5 rounded border border-term-dim/40 px-1.5 py-1 text-[10px] leading-snug text-term-dim">
                          <div>▭ box = sideways range (grey while price is still in it)</div>
                          <div>
                            <span className="text-up">▲ BO</span> / <span className="text-down">▼ BD</span> = first close out of it
                          </div>
                          <div>
                            <span className="text-violet-400">ORH / ORL</span> = 09:15–09:30 high / low,{" "}
                            <span className="text-term-text">ORB</span> = first close beyond (15m and below)
                          </div>
                        </div>
                      )}
                      {k === "structure" && on.structure && (
                        <div className="mb-1 ml-2 mt-0.5 rounded border border-term-dim/40 px-1.5 py-1 text-[10px] leading-snug text-term-dim">
                          <div>
                            <span className="text-up">HH / HL</span> = higher high / low (uptrend),{" "}
                            <span className="text-down">LH / LL</span> = lower high / low (downtrend)
                          </div>
                          <div>BOS = close beyond the last swing, with the trend (continuation)</div>
                          <div>CHoCH = first close beyond it against the trend (possible reversal)</div>
                        </div>
                      )}
                      {k === "chartpat" && on.chartpat && (
                        <div className="mb-1 ml-2 mt-0.5 rounded border border-term-dim/40 px-1.5 py-1 text-[10px] leading-snug text-term-dim">
                          <div>
                            <span className="text-down">DT</span> / <span className="text-up">DB</span> = double top / bottom
                          </div>
                          <div>
                            <span className="text-down">H&amp;S</span> / <span className="text-up">iH&amp;S</span> = head &amp; shoulders / inverse
                          </div>
                          <div>
                            <span className="text-cyan-400">△</span> = triangle breakout (ascending / descending / symmetrical)
                          </div>
                          <div>Marker = neckline / line broken on a close. Dashed with “?” = not confirmed yet.</div>
                        </div>
                      )}
                  </div>
                ))}
                {indHidden && activePat > 0 && (
                  <div className="px-2 py-1 text-[9px] text-amber-400">
                    hidden — “▨ hide indicators” is on
                  </div>
                )}
              </div>
            </>
          )}
        </span>
        <span className="relative">
          <button
            onClick={(e) => {
              if (layoutOpen) return setLayoutOpen(null);
              const r = e.currentTarget.getBoundingClientRect();
              setLayoutOpen({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 248)) });
            }}
            title="Save / load chart layouts: timeframe, indicators, patterns, chart type and every other setting"
            className={`max-w-[150px] truncate rounded border px-2 py-0.5 font-semibold ${
              layoutOpen || activeLayout
                ? "border-sky-500/50 bg-sky-500/15 text-term-text"
                : "border-term-dim/70 text-term-dim hover:bg-term-border hover:text-term-text"
            }`}
          >
            ▦ {activeLayout ? activeLayout.name : "Layout"}
            {layoutModified && <span className="text-amber-400"> •</span>}
          </button>
          {layoutOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setLayoutOpen(null)} />
              <div
                className="fixed z-50 max-h-[70vh] w-[240px] overflow-y-auto rounded-lg border border-term-border bg-term-panel p-1.5 text-2xs shadow-2xl"
                style={{ top: layoutOpen.top, left: layoutOpen.left }}
              >
                <div className="px-1.5 py-1 font-semibold uppercase tracking-wide text-term-dim">Chart layouts</div>
                {activeLayout && (
                  <button
                    onClick={saveLayout}
                    className={`mb-1 w-full rounded px-2 py-1.5 text-left font-semibold ${
                      layoutModified ? "bg-sky-600 text-white" : "bg-term-border/60 text-term-dim"
                    }`}
                  >
                    💾 Save “{activeLayout.name}”{layoutModified ? "" : " · saved ✓"}
                  </button>
                )}
                <div className="mb-1.5 flex gap-1">
                  <input
                    id="chart-layout-name"
                    value={layoutName}
                    onChange={(e) => setLayoutName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveLayoutAs()}
                    placeholder="New layout name"
                    className="min-w-0 flex-1 rounded border border-term-border bg-term-bg px-1.5 py-1 text-[12px] text-term-text outline-none focus:border-sky-500"
                  />
                  <button
                    disabled={!layoutName.trim()}
                    onClick={saveLayoutAs}
                    className="rounded bg-sky-600 px-2 py-1 font-semibold text-white disabled:opacity-40"
                  >
                    Save as
                  </button>
                </div>
                {book.layouts.map((l) => (
                  <div
                    key={l.id}
                    className={`flex items-center gap-1 rounded ${l.id === book.active ? "bg-sky-500/15" : "hover:bg-term-border"}`}
                  >
                    <button onClick={() => loadLayout(l)} className="min-w-0 flex-1 px-2 py-1 text-left">
                      <div className="truncate text-[12px] text-term-text">
                        {l.id === book.active ? "✓ " : ""}
                        {l.name}
                      </div>
                      <div className="truncate text-[10px] text-term-dim">
                        {l.layout.symbol ?? ""} · {TIMEFRAMES.find(([, v]) => v === l.layout.intervalS)?.[0] ?? `${l.layout.intervalS}s`} ·{" "}
                        {new Date(l.saved).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}
                      </div>
                    </button>
                    <button onClick={() => deleteLayout(l)} title="Delete" className="px-2 py-1 text-term-dim hover:text-down">
                      ×
                    </button>
                  </div>
                ))}
                <button
                  onClick={resetLayout}
                  className={`mt-1 w-full rounded px-2 py-1 text-left ${book.active ? "text-term-dim hover:bg-term-border hover:text-term-text" : "bg-sky-500/15 text-term-text"}`}
                >
                  {book.active ? "" : "✓ "}Default (EMA 9 / 21, VWAP, volume)
                </button>
                <div className="mt-1.5 px-1.5 text-[10px] leading-snug text-term-dim">
                  Saves the timeframe, history window, indicators, patterns, chart type, log scale, split view and toolbar.
                  Same layouts on the web and the app. Drawings are kept per chart already.
                </div>
              </div>
            </>
          )}
        </span>
        {/* ml-auto lives on this wrapper permanently (not on whichever child
            happens to be present) so the badge appearing/disappearing never
            shifts the "N bars · Flattrade" text or the rest of the toolbar. */}
        <span className="ml-auto flex items-center gap-1.5">
          {feedLimited && (
            <span
              className="flex items-center gap-1 rounded border border-amber-500/60 bg-amber-500/15 px-1.5 py-0.5 font-semibold text-amber-400"
              title="The data feed sent back far fewer candles than before (usually a rate limit), so the chart is keeping its last full set instead of redrawing with a partial one. It updates by itself once the feed recovers."
            >
              ⚠ feed limited · showing last data
            </span>
          )}
          {feedStale && (
            <span
              className="flex items-center gap-1 rounded border border-down/60 bg-down/15 px-1.5 py-0.5 font-semibold text-down"
              title="Broker live feed is down — chart is on ~3s REST quotes, not tick-by-tick. Hit ↻ refresh in the header."
            >
              ⚠ FEED STALE · REST
            </span>
          )}
          <span className="text-term-dim">
            {data
              ? data.candleSource === "broker"
                ? `${data.candles.length} bars · Flattrade${data.hasVolume ? " + vol" : ""}`
                : data.candleSource === "upstox"
                ? `${data.candles.length} bars · Upstox${data.hasVolume ? " + vol" : ""}`
                : `${data.points} samples · sampled (connect Flattrade / Upstox for real bars)`
              : loadErr
              ? "⚠ load failed"
              : "loading…"}
          </span>
        </span>
      </div>

      <div className={`relative min-h-[220px] ${split ? "flex-[3]" : "flex-1"}`}>
        <div ref={wrapRef} className="absolute inset-0" />
        {(!data || noCandles) && (
          <div
            className={`absolute inset-0 z-20 flex items-center justify-center p-4 ${
              loadErr && !data ? "" : "pointer-events-none"
            }`}
          >
            <div className="max-w-[320px] rounded-lg border border-term-dim/70 bg-term-panel/95 px-4 py-3 text-center text-xs shadow-xl">
              {!data && !loadErr && (
                <div className="flex items-center justify-center gap-2 text-term-text">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-term-dim/50 border-t-term-accent" />
                  Loading {chartLabel}…
                </div>
              )}
              {!data && loadErr && (
                <>
                  <div className="font-semibold text-down">Couldn't load {chartLabel}</div>
                  <div className="mt-1 break-words text-[10px] text-term-dim">{loadErr}</div>
                  <button
                    onClick={() => {
                      setLoadErr(null);
                      setReloadTick((t) => t + 1);
                    }}
                    className="chipbtn mt-2 text-term-text"
                  >
                    Retry
                  </button>
                </>
              )}
              {noCandles && (
                <>
                  <div className="font-semibold text-term-text">No chart data for {chartLabel}</div>
                  <div className="mt-1 text-[10px] text-term-dim">
                    The data source returned no candles for this timeframe. Try another timeframe.
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {oscTop != null && (
          <>
            <div
              className="pointer-events-none absolute inset-x-0 z-10 border-t border-term-border/80"
              style={{ top: `${oscTop * 100}%` }}
            />
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 z-0 bg-term-bg/25"
              style={{ top: `${oscTop * 100}%` }}
            />
          </>
        )}
        {legend && (
          <div className="pointer-events-none absolute left-2 top-1 z-10 rounded bg-term-panel/80 px-2 py-0.5 text-[10px] num text-term-text">
            {symbol} · {legend}
          </div>
        )}
        {eff.rsi && rsiVal != null && (
          <div
            className="pointer-events-none absolute left-2 z-10 rounded bg-term-panel/80 px-2 py-0.5 text-[10px] num"
            style={{ top: eff.macd ? "58%" : "72%" }}
          >
            <span style={{ color: "#e879f9" }}>RSI(14)</span>{" "}
            <span
              className={
                rsiVal >= 70 ? "text-down" : rsiVal <= 30 ? "text-up" : "text-term-text"
              }
            >
              {rsiVal.toFixed(1)}
            </span>
          </div>
        )}
        {drawTool !== "none" && (
          <div className="pointer-events-none absolute right-2 top-1 z-10 rounded bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-400">
            {drawTool === "hline" ? "click chart to add a line" : "drag on chart to draw"}
          </div>
        )}
        {data && data.candles.length < 3 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-xs text-term-dim">
            Collecting data — connect Flattrade for full history, volume and higher timeframes.
          </div>
        )}
      </div>

      {split && (
        <div className="min-h-0 flex-[2] border-t-2 border-term-border">
          <MiniChart
            symbol={symbol}
            instrument={cmpInstrument}
            intervalS={intervalS}
            label={
              cmpInstrument === ""
                ? `${symbol} spot`
                : cmpInstrument === "STRADDLE"
                ? `${symbol} ATM straddle`
                : (instrOptions.find((w) => w.key === cmpInstrument) &&
                    `${symbol} ${instrOptions.find((w) => w.key === cmpInstrument)!.strike} ${
                      instrOptions.find((w) => w.key === cmpInstrument)!.optionType
                    }`) || cmpInstrument
            }
          />
        </div>
      )}
    </div>
  );
}
