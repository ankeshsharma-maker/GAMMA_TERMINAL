import type {
  Alert,
  Analysis,
  BrokerStatus,
  Chain,
  FlowData,
  PcrSeries,
  JournalStats,
  JournalTrade,
  PaperState,
  SavedStrategy,
  ScanRow,
  ScreenerProgress,
  ScreenerRow,
  ShortGuardLeg,
  StrategyLeg,
} from "../types";
import { getToken, handleUnauthorized } from "./auth";

// When the app is served from the same origin as the API (browser / server
// deploy) this stays "" and every call is a relative /api/... path. In the
// packaged Android app there is no backend on the WebView origin, so
// VITE_API_BASE points at the real backend (e.g. http://92.4.84.13).
/** one recorded reading of the OI walls: cw / pw = the strike with the most
 *  call / put OI (cw2 / pw2 the runners-up), OI in shares */
export type OiWallPt = {
  t: number;
  expiry: string;
  spot: number | null;
  cw: number;
  cwOI: number;
  cw2: number | null;
  cw2OI: number | null;
  pw: number;
  pwOI: number;
  pw2: number | null;
  pw2OI: number | null;
};

export const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");

export type VolRow = {
  symbol: string;
  name?: string | null;
  fo: boolean;
  ltp: number;
  chgPct: number | null;
  vol: number;
  value: number;
  avgVol: number | null;
  rvol: number | null;
  volXAvg: number | null;
  pdh: number | null;
  pdl: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  signal: "PDH" | "PDL" | "HIGH" | "LOW" | null;
  w52h: number | null;
  w52l: number | null;
  fromHighPct: number | null;
  fromLowPct: number | null;
  new52h: boolean;
  new52l: boolean;
  open: number | null;
  gapPct: number | null;
  gapFilled: boolean;
  vwap: number | null;
  rangePos: number;
  /** which side has been in control today (vs VWAP + where price sits in the day's range) */
  dir: "BUY" | "SELL" | "MIXED";
};
export type VolSnapshot = {
  universe: "fo" | "all";
  asOf: number | null;
  market: "open" | "closed";
  sessionFraction: number;
  baseline: { ready: number; total: number; date: string | null };
  cfg: { alertLevel: number; minValueCr: number };
  rows: VolRow[];
};

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const tok = getToken();
  const res = await fetch(/^https?:\/\//.test(url) ? url : API_BASE + url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401) {
    handleUnauthorized();
    throw new Error("Login required");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

type Role = "owner" | "viewer";
export type ViewerUser = { id: string; name: string; role: "viewer"; created: number | null };

export const auth = {
  status: () =>
    j<{ required: boolean; ok: boolean; role?: Role | null; name?: string | null }>("/api/auth/status"),
  /** the owner: password only; a view-only user: name + password */
  login: (password: string, name?: string) =>
    j<{ token: string; required: boolean; role?: Role; name?: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(name ? { name, password } : { password }),
    }),
};

/** sign out EVERY device (this one too): the server changes its session key, so
 *  every owner and viewer token stops working and open live sockets close */
export const sessions = {
  logoutAll: () => j<{ ok: boolean }>("/api/sessions/logout-all", { method: "POST" }),
};

/** the owner's view-only users (max 5) -- every call is owner-only on the server */
export const users = {
  list: () => j<{ users: ViewerUser[]; max: number }>("/api/users"),
  add: (name: string, password: string) =>
    j<{ users: ViewerUser[]; max: number }>("/api/users", {
      method: "POST",
      body: JSON.stringify({ name, password }),
    }),
  setPassword: (id: string, password: string) =>
    j<{ users: ViewerUser[]; max: number }>(`/api/users/${encodeURIComponent(id)}/password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  remove: (id: string) =>
    j<{ users: ViewerUser[]; max: number }>(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export const api = {
  symbols: () =>
    j<{ indices: string[]; defaults: string[]; fo?: string[]; watchlist: string[] }>("/api/symbols"),

  indicesHeader: (symbols?: string[]) =>
    j<{
      indices: {
        symbol: string;
        spot: number | null;
        chgPct: number | null;
        chgPts?: number | null;
      }[];
    }>(`/api/indices/header?symbols=${encodeURIComponent((symbols ?? []).join(","))}`),
  indicesHeaderOptions: () => j<{ options: string[] }>("/api/indices/header/options"),

  chain: (symbol: string, expiry?: string) =>
    j<Chain>(
      `/api/option-chain/${symbol}` + (expiry ? `?expiry=${encodeURIComponent(expiry)}` : "")
    ),

  history: (symbol: string) =>
    j<{
      symbol: string;
      points: {
        t: number;
        spot: number;
        pcr: number | null;
        atmIV: number | null;
        maxPain: number;
        netGex: number;
        gammaFlip?: number | null;
        ceOIChg?: number | null;
        peOIChg?: number | null;
        ceOI?: number | null;
        peOI?: number | null;
        ceVol?: number | null;
        peVol?: number | null;
      }[];
    }>(`/api/history/${symbol}`),

  volumeScreener: (universe: "fo" | "all") => j<VolSnapshot>(`/api/volume-screener?universe=${universe}`),
  volumeScreenerConfigGet: () => j<VolSnapshot["cfg"]>("/api/volume-screener/config"),
  volumeScreenerConfig: (body: { alertLevel?: number; minValueCr?: number }) =>
    j<VolSnapshot["cfg"]>("/api/volume-screener/config", { method: "POST", body: JSON.stringify(body) }),
  gexIntraday: (symbol: string, day: string | null) =>
    j<{ symbol: string; day: string | null; days: string[]; live: boolean; points: [number, number | null, number | null, number | null][] }>(
      `/api/gex-intraday/${symbol}` + (day ? `?day=${encodeURIComponent(day)}` : "")
    ),
  pcr: (symbol: string, day: string | null, bucket: number) =>
    j<PcrSeries>(`/api/pcr/${symbol}?bucket=${bucket}` + (day ? `&day=${encodeURIComponent(day)}` : "")),

  flow: (symbol: string, expiry: string | undefined, window: string) =>
    j<FlowData>(
      `/api/flow/${symbol}?window=${encodeURIComponent(window)}` +
        (expiry ? `&expiry=${encodeURIComponent(expiry)}` : "")
    ),

  oiChange: (symbol: string, expiry: string | undefined, minutes: number) =>
    j<{
      symbol: string;
      expiry: string;
      minutes: number;
      coverageMin: number;
      baseTs: number | null;
      curTs: number | null;
      strikes: Record<string, { ceOi: number; peOi: number; ceOiChg: number; peOiChg: number }>;
    }>(
      `/api/oi-change/${symbol}?minutes=${minutes}` +
        (expiry ? `&expiry=${encodeURIComponent(expiry)}` : "")
    ),

  /** where the call / put OI walls (biggest-OI strikes) sat through today */
  oiWalls: (symbol: string, expiry?: string) =>
    j<{ symbol: string; expiry: string; points: OiWallPt[] }>(
      `/api/oi-walls/${symbol}` + (expiry ? `?expiry=${encodeURIComponent(expiry)}` : "")
    ),

  addWatch: (symbol: string) =>
    j<{ watchlist: string[] }>("/api/watchlist", {
      method: "POST",
      body: JSON.stringify({ symbol }),
    }),

  removeWatch: (symbol: string) =>
    j<{ watchlist: string[] }>(`/api/watchlist/${symbol}`, { method: "DELETE" }),

  /** names, plus option contracts for a strike query ("23400 CE"); `sym` = the
   *  symbol on screen, whose contracts are listed first */
  symbolSearch: (q: string, sym?: string) =>
    j<{
      results: {
        label: string;
        add: string;
        kind: "index" | "stock" | "vix" | "option" | "equity";
        optionable: boolean;
        category?: string;
        name?: string;
      }[];
    }>(`/api/symbols/search?q=${encodeURIComponent(q)}${sym ? `&sym=${encodeURIComponent(sym)}` : ""}`),

  chartDrawings: (key: string) =>
    j<{ drawings: import("./chartDrawings").Drawing[] }>(
      `/api/chart/drawings?key=${encodeURIComponent(key)}`
    ),
  chartLayouts: () => j<{ active: string | null; layouts: any[] }>("/api/chart/layouts"),
  saveChartLayouts: (d: { active: string | null; layouts: any[] }) =>
    j<{ active: string | null; layouts: any[] }>("/api/chart/layouts", {
      method: "POST",
      body: JSON.stringify(d),
    }),
  saveChartDrawings: (key: string, drawings: import("./chartDrawings").Drawing[]) =>
    j<{ drawings: import("./chartDrawings").Drawing[] }>("/api/chart/drawings", {
      method: "POST",
      body: JSON.stringify({ key, drawings }),
    }),

  watchlists: () => j<import("../types").Watchlists>("/api/watchlists"),
  wlSetActive: (index: number) =>
    j<import("../types").Watchlists>("/api/watchlists/active", {
      method: "POST",
      body: JSON.stringify({ index }),
    }),
  wlAddList: () =>
    j<import("../types").Watchlists>("/api/watchlists/add", { method: "POST" }),
  wlDeleteList: (index: number) =>
    j<import("../types").Watchlists>(`/api/watchlists/${index}`, { method: "DELETE" }),
  wlAdd: (index: number, symbol: string) =>
    j<import("../types").Watchlists>(`/api/watchlists/${index}/add`, {
      method: "POST",
      body: JSON.stringify({ symbol }),
    }),
  wlRemove: (index: number, symbol: string) =>
    j<import("../types").Watchlists>(
      `/api/watchlists/${index}/${encodeURIComponent(symbol)}`,
      { method: "DELETE" }
    ),
  wlClear: (index: number, optionsOnly = false) =>
    j<import("../types").Watchlists>(`/api/watchlists/${index}/clear`, {
      method: "POST",
      body: JSON.stringify({ optionsOnly }),
    }),
  wlRename: (index: number, name: string) =>
    j<import("../types").Watchlists>(`/api/watchlists/${index}/rename`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  wlAddStrikes: (
    index: number,
    body: { symbol: string; expiry?: string; count?: number; sides?: ("CE" | "PE")[] }
  ) =>
    j<import("../types").Watchlists & { quotes: import("../types").WatchQuote[] }>(
      `/api/watchlists/${index}/add-strikes`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  wlAddFuture: (index: number, body: { symbol: string; expiry: string }) =>
    j<import("../types").Watchlists & { quotes: import("../types").WatchQuote[] }>(
      `/api/watchlists/${index}/add-future`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  watchQuotes: () =>
    j<{ watchlist: string[]; quotes: import("../types").WatchQuote[] }>("/api/watchlist"),

  chart: (symbol: string, interval = 60, instrument?: string, src?: "auto" | "broker" | "upstox", lite?: boolean) =>
    j<{
      symbol: string;
      candles: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume?: number;
      }[];
      series: Record<string, { time: number; value: number }[]>;
      lastSpot: number | null;
      points: number;
      candleSource?: "broker" | "sampled" | "upstox";
      hasVolume?: boolean;
    }>(
      `/api/chart/${symbol}?interval=${interval}` +
        (instrument ? `&instrument=${encodeURIComponent(instrument)}` : "") +
        (src && src !== "auto" ? `&src=${src}` : "") +
        (lite ? "&lite=1" : "")
    ),

  scan: () => j<{ rows: ScanRow[]; alerts: Alert[] }>("/api/scan"),

  unusual: () => j<{ events: import("../types").UnusualEvent[] }>("/api/unusual"),

  screener: () =>
    j<{
      rows: ScreenerRow[];
      progress: ScreenerProgress;
      presets: Record<string, Record<string, unknown>>;
    }>("/api/screener"),

  scanSymbol: (symbol: string) =>
    j<{ symbol: string; row: ScanRow | null; series: Record<string, number>[] }>(
      `/api/scan/${symbol}`
    ),

  paper: () => j<PaperState>("/api/paper"),

  placeOrder: (body: {
    symbol: string;
    expiry: string;
    strike: number;
    option_type: "CE" | "PE" | "FUT";
    side: "BUY" | "SELL";
    qty_lots: number;
    price?: number | null;
    note?: string;
  }) =>
    j<{ state: PaperState }>("/api/paper/order", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** a strategy's legs as PAPER fills only (view-only users' Builder Execute) */
  paperStrategy: (body: { symbol: string; expiry: string; legs: StrategyLeg[] }) =>
    j<{ mode: "paper"; paper: PaperState }>("/api/paper/strategy", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  closePosition: (position_id: string) =>
    j<PaperState>("/api/paper/close", {
      method: "POST",
      body: JSON.stringify({ position_id }),
    }),

  setStop: (body: {
    position_id: string;
    mode: "points" | "amount";
    value: number; // 0 = no stop-loss (target only)
    trailValue: number;
    targetValue?: number;
  }) => j<PaperState>("/api/paper/stop", { method: "POST", body: JSON.stringify(body) }),

  clearStop: (position_id: string) =>
    j<PaperState>(`/api/paper/stop/${position_id}`, { method: "DELETE" }),

  strategyTemplates: (symbol: string, expiry?: string) =>
    j<{
      symbol: string;
      expiry: string;
      atmStrike: number;
      strikeStep: number;
      templates: Record<string, StrategyLeg[]>;
    }>(`/api/strategy/templates?symbol=${symbol}` + (expiry ? `&expiry=${encodeURIComponent(expiry)}` : "")),

  analyzeStrategy: (body: {
    symbol: string;
    expiry?: string;
    legs: StrategyLeg[];
    priceRange?: number;
  }) =>
    j<Analysis>("/api/strategy/analyze", { method: "POST", body: JSON.stringify(body) }),

  volatility: (symbol: string, expiry?: string) =>
    j<import("../types").VolatilityData>(
      `/api/volatility/${encodeURIComponent(symbol)}` +
        (expiry ? `?expiry=${encodeURIComponent(expiry)}` : "")
    ),

  portfolioScenario: (source: "paper" | "broker" | "all", daysForward = 0) =>
    j<import("../types").ScenarioData>("/api/portfolio/scenario", {
      method: "POST",
      body: JSON.stringify({ source, daysForward }),
    }),

  strategyChart: (body: {
    symbol: string;
    expiry?: string;
    legs: Pick<StrategyLeg, "optionType" | "strike" | "side" | "lots">[];
    interval: number;
    days: number;
  }) =>
    j<import("../types").StrategyChartData>("/api/strategy/chart", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  findHedge: (body: {
    symbol: string;
    expiry?: string;
    legs: StrategyLeg[];
    maxLoss: number;
    maxLots?: number;
    maxProfitCap?: number;
    minPop?: number;
    maxAbsDelta?: number;
    maxAbsTheta?: number;
    maxAbsVega?: number;
    maxAbsGamma?: number;
    maxHedgeIv?: number;
  }) =>
    j<{
      target: number;
      current: {
        maxLoss: number;
        maxLossUnbounded: boolean;
        maxProfit: number;
        maxProfitUnbounded: boolean;
        netPremium: number;
        pop: number | null;
        rr: number | null;
        breakevens: number[];
        greeks: Record<string, number>;
      };
      suggestions: {
        leg: StrategyLeg | StrategyLeg[];
        label: string;
        entry: number;
        cost: number;
        profitGiveUp: number;
        resultMaxLoss: number;
        resultMaxProfit: number;
        resultMaxProfitUnbounded: boolean;
        resultPop: number | null;
        resultRR: number | null;
        resultBreakevens: number[];
        resultGreeks: Record<string, number>;
        resultMargin: number;
      }[];
      note: string;
    }>("/api/strategy/hedge", { method: "POST", body: JSON.stringify(body) }),

  strategyFromPaper: () =>
    j<{ symbol: string; expiry: string; legs: StrategyLeg[]; analysis: Analysis }>(
      "/api/strategy/from-paper",
      { method: "POST", body: "{}" }
    ),
  strategyFromBroker: (symbol?: string) =>
    j<{ symbol: string; expiry: string; legs: StrategyLeg[]; analysis: Analysis }>(
      "/api/strategy/from-broker",
      { method: "POST", body: JSON.stringify({ symbol: symbol || null }) }
    ),

  listStrategies: () => j<{ strategies: SavedStrategy[] }>("/api/strategies"),

  saveStrategy: (body: { name: string; symbol: string; expiry: string; legs: StrategyLeg[] }) =>
    j<{ saved: SavedStrategy; strategies: SavedStrategy[] }>("/api/strategies", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteStrategy: (id: string) =>
    j<{ strategies: SavedStrategy[] }>(`/api/strategies/${id}`, { method: "DELETE" }),

  strategySchedules: () =>
    j<{ schedules: import("../types").StrategySchedule[] }>("/api/strategy/schedules"),
  strategyScheduleAdd: (body: {
    symbol: string;
    expiry: string;
    legs: StrategyLeg[];
    entryTime?: string | null;
    exitTime?: string | null;
    repeat?: boolean;
    mode?: "paper" | "live";
    note?: string;
  }) =>
    j<{ schedule: import("../types").StrategySchedule; schedules: import("../types").StrategySchedule[] }>(
      "/api/strategy/schedule",
      { method: "POST", body: JSON.stringify(body) }
    ),
  strategyScheduleDel: (id: string) =>
    j<{ schedules: import("../types").StrategySchedule[] }>(`/api/strategy/schedule/${id}`, {
      method: "DELETE",
    }),

  legRules: () => j<{ rules: any[] }>("/api/leg-rules"),
  legRuleAdd: (body: Record<string, unknown>) =>
    j<{ rule: any; rules: any[] }>("/api/leg-rules", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  legRuleDel: (id: string) =>
    j<{ rules: any[] }>(`/api/leg-rules/${id}`, { method: "DELETE" }),
  legRulesClear: () => j<{ rules: any[] }>("/api/leg-rules/clear", { method: "POST" }),
  legRuleAttach: (body: Record<string, unknown>) =>
    j<{ rule: any; rules: any[] }>("/api/leg-rules/attach", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  oiAlerts: () => j<{ rules: any[] }>("/api/oi-alerts"),
  oiAlertAdd: (body: Record<string, unknown>) =>
    j<{ rule: any; rules: any[] }>("/api/oi-alerts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  oiAlertDel: (id: string) =>
    j<{ rules: any[] }>(`/api/oi-alerts/${id}`, { method: "DELETE" }),

  priceAlerts: () => j<{ alerts: any[] }>("/api/price-alerts"),
  priceAlertAdd: (body: Record<string, unknown>) =>
    j<{ alert: any; alerts: any[] }>("/api/price-alerts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  priceAlertDel: (id: string) =>
    j<{ alerts: any[] }>(`/api/price-alerts/${id}`, { method: "DELETE" }),

  shortGuard: () => j<{ legs: ShortGuardLeg[]; levels: number[]; target: number }>("/api/short-guard"),
  indicatorAlerts: () => j<{ alerts: any[] }>("/api/indicator-alerts"),
  indicatorAlertAdd: (body: Record<string, unknown>) =>
    j<{ alert: any; alerts: any[] }>("/api/indicator-alerts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  indicatorAlertDel: (id: string) =>
    j<{ alerts: any[] }>(`/api/indicator-alerts/${id}`, { method: "DELETE" }),

  mtmAlerts: () => j<{ alerts: any[] }>("/api/mtm-alerts"),
  mtmAlertAdd: (body: Record<string, unknown>) =>
    j<{ alert: any; alerts: any[] }>("/api/mtm-alerts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  mtmAlertDel: (id: string) =>
    j<{ alerts: any[] }>(`/api/mtm-alerts/${id}`, { method: "DELETE" }),

  journal: (params: { limit?: number; symbol?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.symbol) q.set("symbol", params.symbol);
    const qs = q.toString();
    return j<JournalTrade[]>(`/api/journal${qs ? `?${qs}` : ""}`);
  },
  journalStats: () => j<JournalStats>("/api/journal/stats"),
  journalReview: (day?: string) =>
    j<import("../types").JournalReview>(`/api/journal/review${day ? `?day=${encodeURIComponent(day)}` : ""}`),
  journalSyncLive: () =>
    j<{ ok: boolean; orders?: number; new?: number; reason?: string }>("/api/journal/sync-live", { method: "POST" }),

  portfolioGreeks: () =>
    j<{
      paper: { delta: number; gamma: number; theta: number; vega: number; positions: number };
      paperBySymbol: {
        symbol: string;
        delta: number;
        gamma: number;
        theta: number;
        vega: number;
        positions: number;
      }[];
      live: { delta: number; gamma: number; theta: number; vega: number; positions: number };
      liveBySymbol: {
        symbol: string;
        delta: number;
        gamma: number;
        theta: number;
        vega: number;
        positions: number;
      }[];
    }>("/api/portfolio-greeks"),

  /** Rough pre-trade margin check (not real SPAN) for a prospective live
   *  order -- OrderConfirm.tsx compares this against actual available
   *  margin so a shortfall is caught before submitting, not from a broker
   *  rejection after the fact. */
  brokerMargin: (body: {
    symbol: string;
    expiry?: string;
    legs: { strike: number; optionType: string; side: "BUY" | "SELL"; lots: number; price: number }[];
  }) =>
    j<{ ok: boolean; margin?: number; accountMarginAfter?: number | null; remarks?: string | null; reason?: string }>(
      "/api/broker/margin",
      { method: "POST", body: JSON.stringify(body) }
    ),
  marginEstimate: (legs: { side: "BUY" | "SELL"; strike: number; lots: number; price: number }[], lotSize: number) =>
    j<{ estimated: number }>("/api/margin-estimate", {
      method: "POST",
      body: JSON.stringify({ legs, lotSize }),
    }),

  alertDeliveryGet: () =>
    j<{
      enabled: boolean;
      minSeverity: "info" | "warning" | "critical";
      autobotAlerts: "all" | "important" | "off";
      greeksAlerts?: "big" | "all" | "off";
      symbols?: string[];
      webhookUrlSet: boolean;
      telegramSet: boolean;
    }>("/api/alert-delivery"),
  alertDeliverySet: (body: Record<string, unknown>) =>
    j<{ enabled: boolean; minSeverity: string; webhookUrlSet: boolean; telegramSet: boolean }>(
      "/api/alert-delivery",
      { method: "POST", body: JSON.stringify(body) }
    ),
  alertDeliveryClear: (field: "webhookUrl" | "telegramBotToken" | "telegramChatId") =>
    j<{ webhookUrlSet: boolean; telegramSet: boolean }>(`/api/alert-delivery/${field}`, {
      method: "DELETE",
    }),
  alertDeliveryTest: () =>
    j<{ ok: boolean; webhook?: boolean; telegram?: boolean }>("/api/alert-delivery/test", {
      method: "POST",
    }),

  pushVapidKey: () => j<{ configured: boolean; key: string }>("/api/push/vapid-key"),
  pushSubscribe: (sub: unknown) =>
    j<{ ok: boolean; count: number }>("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub) }),
  pushUnsubscribe: (endpoint: string) =>
    j<{ ok: boolean; count: number }>("/api/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint }),
    }),
  pushTest: () => j<{ ok: boolean; sent: number; total: number }>("/api/push/test", { method: "POST" }),

  orderModeGet: () =>
    j<{ mode: "paper" | "live"; brokerAuthed: boolean }>("/api/order/mode"),
  orderModeSet: (mode: "paper" | "live") =>
    j<{ mode: "paper" | "live" }>("/api/order/mode", {
      method: "POST",
      body: JSON.stringify({ mode }),
    }),
  placeUnifiedOrder: (body: {
    symbol: string;
    expiry: string;
    strike: number;
    optionType: "CE" | "PE";
    side: "BUY" | "SELL";
    qtyLots: number;
    orderType?: "MKT" | "LMT";
    price?: number | null;
    product?: "NRML" | "MIS";
    mode?: "paper" | "live";
  }) =>
    j<{ result: any; paper: PaperState; mode: string }>("/api/order", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  placeFutureOrder: (body: {
    symbol: string;
    expiry: string;
    side: "BUY" | "SELL";
    qtyLots: number;
    orderType?: "MKT" | "LMT";
    price?: number | null;
    product?: "NRML" | "MIS";
    mode?: "paper" | "live";
  }) =>
    j<{ result: any; paper: PaperState; mode: string }>("/api/order/future", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  executeStrategy: (body: {
    symbol: string;
    expiry: string;
    legs: StrategyLeg[];
    orderType?: "MKT" | "LMT";
    product?: "NRML" | "MIS";
    mode?: "paper" | "live";
  }) =>
    j<{ mode: string; results: any[]; paper: PaperState }>("/api/strategy/execute", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  liveOrderLog: () => j<{ orders: any[] }>("/api/order/live-log"),

  autobot: () => j<import("../types").AutoBotState>("/api/autobot"),
  autobotStructures: () =>
    j<{ structures: import("../types").AutoStructureDef[] }>("/api/autobot/structures"),
  autobotStructurePreview: (q: { symbol: string; structure: string; offset?: number; width?: number; expiry?: string | null }) =>
    j<import("../types").StructurePreview>(
      `/api/autobot/structure-preview?symbol=${encodeURIComponent(q.symbol)}&structure=${encodeURIComponent(q.structure)}` +
        (q.offset != null ? `&offset=${q.offset}` : "") +
        (q.width != null ? `&width=${q.width}` : "") +
        (q.expiry ? `&expiry=${encodeURIComponent(q.expiry)}` : "")
    ),
  autobotStats: (limit = 60) => j<import("../types").AutoStats>(`/api/autobot/stats?limit=${limit}`),
  autobotResume: (id: string) =>
    j<import("../types").AutoBotState>(`/api/autobot/rules/${encodeURIComponent(id)}/resume`, { method: "POST" }),
  autobotMaster: (on: boolean) =>
    j<import("../types").AutoBotState>("/api/autobot/master", {
      method: "POST",
      body: JSON.stringify({ on }),
    }),
  autobotMaxLoss: (value: number) =>
    j<import("../types").AutoBotState>("/api/autobot/max-loss", {
      method: "POST",
      body: JSON.stringify({ value }),
    }),
  autobotSaveRule: (rule: Partial<import("../types").AutoRule>) =>
    j<import("../types").AutoBotState>("/api/autobot/rules", {
      method: "POST",
      body: JSON.stringify(rule),
    }),
  autobotEnableRule: (id: string, on: boolean) =>
    j<import("../types").AutoBotState>(`/api/autobot/rules/${id}/enabled`, {
      method: "POST",
      body: JSON.stringify({ on }),
    }),
  autobotDeleteRule: (id: string) =>
    j<import("../types").AutoBotState>(`/api/autobot/rules/${id}`, { method: "DELETE" }),
  autobotKill: () =>
    j<import("../types").AutoBotState>("/api/autobot/kill", { method: "POST" }),

  // Upstox = data feed only (orders stay on Flattrade)
  upstoxStatus: () =>
    j<{
      configured: boolean;
      authed: boolean;
      static?: boolean;
      tokenDate: string | null;
      redirectUrl: string;
    }>("/api/upstox/status"),
  upstoxLoginUrl: () => j<{ url: string }>("/api/upstox/login-url"),
  upstoxSetToken: (token: string) =>
    j<{ configured: boolean; authed: boolean }>("/api/upstox/token", {
      method: "POST",
      body: JSON.stringify({ token, longLived: true }),
    }),
  upstoxHistoryChain: (symbol: string, expiry: string, from: string, to: string) =>
    j<{
      symbol: string;
      expiry: string;
      from: string;
      to: string;
      cached: boolean;
      series: {
        date: string;
        spot: number | null;
        ceOI: number;
        peOI: number;
        pcr: number | null;
        maxPain: number | null;
        dSpot?: number;
        dOI?: number;
        state?: string;
      }[];
    }>(
      `/api/upstox/history-chain?symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(
        expiry
      )}&from=${from}&to=${to}`
    ),
  upstoxBacktest: (body: {
    symbol: string;
    expiry: string;
    legs: { strike: number; optionType: string; side: string; lots: number }[];
    from: string;
    to: string;
  }) =>
    j<{
      symbol: string;
      expiry: string;
      entryDate: string;
      lot: number;
      netEntry: number;
      legs: { strike: number; optionType: string; side: string; lots: number; entryPx: number }[];
      series: { date: string; pnl: number; spot: number | null }[];
      summary: {
        finalPnl: number;
        maxProfit: number;
        maxLoss: number;
        maxDrawdown: number;
        days: number;
      };
    }>("/api/upstox/backtest", { method: "POST", body: JSON.stringify(body) }),
  autobotBacktest: (body: {
    rule?: unknown;
    ruleId?: string;
    from: string;
    to: string;
    interval?: number;
    bars?: number;
    /** brokerage / STT / exchange charges + slippage; ON by default server-side */
    costs?: { enabled?: boolean; slippagePct?: number; brokerage?: number };
  }) =>
    j<{
      symbol: string;
      expiry: string | null;
      instrument: string;
      side: string;
      lot: number;
      days: number;
      interval?: number;
      candles?: number;
      pricing: "historical" | "synthetic" | "mixed";
      hasChain: boolean;
      hasGreeksHistory: boolean;
      synIV: number;
      synDTE: number;
      costs?: { enabled: boolean; slippagePct: number; brokerage: number };
      /** rule settings a backtest can't reproduce (no real expiry calendar / quotes) */
      notSimulated?: string[];
      trades: {
        entryDate: string;
        exitDate: string;
        /** "HH:MM" IST -- only present for intraday (interval<86400) runs;
         *  daily-bar trades have no intraday time to show. */
        entryTime?: string;
        exitTime?: string;
        strike: number;
        ot: string;
        entryPx: number;
        exitPx: number;
        /** a structure's summary and legs (absent for a single option) */
        label?: string;
        structure?: string;
        legs?: { ot: string; strike: number; side: string }[];
        pnlPct: number;
        /** NET of charges and slippage when costs are on */
        pnlRs: number;
        grossRs?: number;
        chargesRs?: number;
        slippageRs?: number;
        lots?: number;
        /** booked part of the position early (scale-out) */
        scaled?: boolean;
        holdMin?: number | null;
        reason: string;
      }[];
      equity: number[];
      summary: {
        total: number;
        count: number;
        wins: number;
        losses: number;
        winRate: number;
        totalWin: number;
        totalLoss: number;
        avgWin: number;
        avgLoss: number;
        profitFactor: number | null;
        maxDrawdown: number;
        expectancy?: number;
        payoff?: number | null;
        maxWinStreak?: number;
        maxLossStreak?: number;
        best?: number;
        worst?: number;
        avgHoldMin?: number | null;
        grossTotal?: number;
        chargesTotal?: number;
        slippageTotal?: number;
        byReason?: Record<string, { n: number; pnl: number }>;
      };
    }>("/api/autobot/backtest", { method: "POST", body: JSON.stringify(body) }),
  upstoxScanHistory: (symbols: string[], from: string, to: string) =>
    j<{
      from: string;
      to: string;
      rows: {
        symbol: string;
        date: string;
        spot: number | null;
        dSpot: number;
        spotMove: number;
        ceOI: number;
        peOI: number;
        netOI: number;
        pcr: number | null;
        maxPain: number | null;
        state: string | null;
        states: (string | null)[];
        smartBias: "BULLISH" | "BEARISH" | "NEUTRAL";
        smartSignals: string[];
        smartScore: number;
      }[];
    }>("/api/upstox/scan-history", { method: "POST", body: JSON.stringify({ symbols, from, to }) }),
  upstoxIndicatorScan: (symbols: string[], date: string) =>
    j<{
      date: string;
      rows: {
        symbol: string;
        date: string;
        spot: number;
        rsi: number | null;
        ema9: number | null;
        ema21: number | null;
        ema50: number | null;
        macdHist: number | null;
        signals: string[];
        score: number;
        trend: "BULLISH" | "BEARISH" | "NEUTRAL";
      }[];
    }>("/api/upstox/indicator-scan", { method: "POST", body: JSON.stringify({ symbols, date }) }),
  weeklyGex: (symbol: string, days = 7) =>
    j<{
      symbol: string;
      source: "nse_bhavcopy" | "upstox";
      series: {
        date: string;
        spot: number;
        netGex: number;
        gammaFlip: number;
        atmCEDelta: number;
        atmCEGamma: number;
        atmPEDelta: number;
        atmPEGamma: number;
        expiry: string;
      }[];
    }>(`/api/upstox/weekly-gex?symbol=${symbol}&days=${days}`),
  moversHistory: () =>
    j<{
      date: string;
      rows: {
        symbol: string;
        date: string;
        spot: number;
        changePct1d: number | null;
        changePct7d: number | null;
      }[];
    }>("/api/upstox/movers-history"),
  dataSource: () => j<{ source: "nse" | "upstox" }>("/api/upstox/data-source"),
  setDataSource: (source: "nse" | "upstox") =>
    j<{ source: "nse" | "upstox" }>("/api/upstox/data-source", {
      method: "POST",
      body: JSON.stringify({ source }),
    }),

  brokerStatus: () => j<BrokerStatus>("/api/broker/status"),
  brokerLogin: () => j<{ url: string }>("/api/broker/login"),
  brokerLogout: () => j<{ ok: boolean }>("/api/broker/logout", { method: "POST" }),
  brokerRefresh: () =>
    j<BrokerStatus & { ok: boolean; error?: string | null }>("/api/broker/refresh", {
      method: "POST",
    }),
  brokerSetToken: (token: string, client?: string) =>
    j<BrokerStatus>("/api/broker/token", {
      method: "POST",
      body: JSON.stringify({ token, client }),
    }),
  brokerDirectLogin: (b: { uid: string; pwd: string; totp: string; vc?: string }) =>
    j<BrokerStatus>("/api/broker/direct-login", { method: "POST", body: JSON.stringify(b) }),
  brokerFunds: () => j<import("../types").BrokerFunds>("/api/broker/funds"),
  brokerPositions: () => j<{ positions: any[] }>("/api/broker/positions"),
  brokerHoldings: () => j<{ holdings: any[] }>("/api/broker/holdings"),
  brokerOrders: () => j<{ orders: any[] }>("/api/broker/orders"),
  brokerOrderCancel: (orderId: string) =>
    j<{ ok: boolean }>(`/api/broker/orders/${orderId}/cancel`, { method: "POST" }),
  brokerOrderModify: (
    orderId: string,
    body: { price?: number; qty?: number; priceType?: "LMT" | "MKT"; triggerPrice?: number }
  ) =>
    j<{ ok: boolean }>(`/api/broker/orders/${orderId}/modify`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  brokerSquareOff: (body: { tsym: string; exch?: string; qty: number; prd?: string }) =>
    j<{ ok: boolean; orderId?: string; raw?: any }>("/api/broker/square-off", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  brokerOrderTsym: (body: {
    tsym: string;
    exch?: string;
    side: "BUY" | "SELL";
    lots?: number;
    prd?: string;
  }) =>
    j<{ ok: boolean; orderId?: string; qty: number; raw?: any }>("/api/broker/order-tsym", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  brokerBracket: () => j<BrokerBracket>("/api/broker/bracket"),
  brokerBracketSet: (
    body: Partial<
      Pick<BrokerBracket, "enabled" | "slAmount" | "targetAmount" | "trailAmount" | "floorAmount" | "basis">
    >
  ) => j<BrokerBracket>("/api/broker/bracket", { method: "POST", body: JSON.stringify(body) }),
  brokerBracketClear: () => j<BrokerBracket>("/api/broker/bracket/clear", { method: "POST" }),
};

export interface BrokerBracket {
  enabled: boolean;
  slAmount: number;
  targetAmount: number;
  trailAmount: number;
  floorAmount: number;
  basis: "today" | "mtm";
  armedAt: number | null;
  triggeredAt: number | null;
  lastReason: string;
  lastPnl: number | null;
  peakPnl: number | null;
}
