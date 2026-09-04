import type {
  Alert,
  Analysis,
  BrokerStatus,
  Chain,
  PaperState,
  SavedStrategy,
  ScanRow,
  ScreenerProgress,
  ScreenerRow,
  StrategyLeg,
} from "../types";

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  symbols: () =>
    j<{ indices: string[]; defaults: string[]; fo?: string[]; watchlist: string[] }>("/api/symbols"),

  indicesHeader: (symbols?: string[]) =>
    j<{ indices: { symbol: string; spot: number | null; chgPct: number | null }[] }>(
      `/api/indices/header?symbols=${encodeURIComponent((symbols ?? []).join(","))}`
    ),
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
      }[];
    }>(`/api/history/${symbol}`),

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

  addWatch: (symbol: string) =>
    j<{ watchlist: string[] }>("/api/watchlist", {
      method: "POST",
      body: JSON.stringify({ symbol }),
    }),

  removeWatch: (symbol: string) =>
    j<{ watchlist: string[] }>(`/api/watchlist/${symbol}`, { method: "DELETE" }),

  symbolSearch: (q: string) =>
    j<{
      results: {
        label: string;
        add: string;
        kind: "index" | "stock" | "vix";
        optionable: boolean;
        category?: string;
      }[];
    }>(`/api/symbols/search?q=${encodeURIComponent(q)}`),

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
  watchQuotes: () =>
    j<{ watchlist: string[]; quotes: import("../types").WatchQuote[] }>("/api/watchlist"),

  chart: (symbol: string, interval = 60, instrument?: string) =>
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
      candleSource?: "broker" | "sampled";
      hasVolume?: boolean;
    }>(
      `/api/chart/${symbol}?interval=${interval}` +
        (instrument ? `&instrument=${encodeURIComponent(instrument)}` : "")
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
    option_type: "CE" | "PE";
    side: "BUY" | "SELL";
    qty_lots: number;
    price?: number | null;
    note?: string;
  }) =>
    j<{ state: PaperState }>("/api/paper/order", {
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
    value: number;
    trailValue: number;
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

  findHedge: (body: {
    symbol: string;
    expiry?: string;
    legs: StrategyLeg[];
    maxLoss: number;
    maxLots?: number;
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
  strategyFromBroker: () =>
    j<{ symbol: string; expiry: string; legs: StrategyLeg[]; analysis: Analysis }>(
      "/api/strategy/from-broker",
      { method: "POST", body: "{}" }
    ),

  listStrategies: () => j<{ strategies: SavedStrategy[] }>("/api/strategies"),

  saveStrategy: (body: { name: string; symbol: string; expiry: string; legs: StrategyLeg[] }) =>
    j<{ saved: SavedStrategy; strategies: SavedStrategy[] }>("/api/strategies", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteStrategy: (id: string) =>
    j<{ strategies: SavedStrategy[] }>(`/api/strategies/${id}`, { method: "DELETE" }),

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
};
