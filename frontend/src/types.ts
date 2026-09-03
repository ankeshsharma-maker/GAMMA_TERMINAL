export interface Leg {
  oi: number;
  oiChg: number;
  oiChgPct: number;
  volume: number;
  iv: number | null;
  ivCalc: number | null;
  ltp: number;
  chg: number;
  chgPct: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  gex: number;
}

export interface ChainRow {
  strike: number;
  isATM: boolean;
  moneyness: "ITM" | "OTM" | "ATM";
  call: Leg;
  put: Leg;
}

export interface Chain {
  symbol: string;
  expiry: string;
  expiries: string[];
  spot: number;
  atmStrike: number;
  strikeStep: number;
  lotSize: number;
  dte: number;
  nseTimestamp: string | null;
  atmIV: number | null;
  pcr: number | null;
  maxPain: number;
  netGex: number;
  totals: {
    ceOI: number;
    peOI: number;
    ceOIChg: number;
    peOIChg: number;
    ceVol: number;
    peVol: number;
  };
  rows: ChainRow[];
  fetchedAt?: number;
  liveSpot?: { ltp: number; chgPct: number | null; ts: number } | null;
  hotGreeks?: HotGreek[];
}

export type UnusualKind = "DELTA_JUMP" | "GAMMA_SPIKE" | "GAMMA_COLLAPSE";

export interface HotGreek {
  strike: number;
  optionType: "CE" | "PE";
  kind: UnusualKind;
  ts: number;
}

export interface UnusualEvent {
  ts: number;
  symbol: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  kind: UnusualKind;
  dDelta: number;
  dGamma: number;
  delta: number;
  gamma: number;
  prevDelta: number;
  prevGamma: number;
  severity: string;
  message: string;
}

export interface WatchQuote {
  key: string;
  kind?: "symbol" | "option" | "index";
  symbol: string;
  spot?: number | null;
  liveSpot?: number | null;
  liveChgPct?: number | null;
  variation?: number | null;
  optionable?: boolean;
  atmIV?: number | null;
  atmStrike?: number;
  pcr?: number | null;
  dte?: number;
  expiry?: string;
  lotSize?: number;
  fetchedAt?: number;
  error?: string;
  // option rows
  strike?: number;
  optionType?: "CE" | "PE";
  ltp?: number;
  chg?: number;
  chgPct?: number;
  iv?: number | null;
  oi?: number;
  oiChg?: number;
  delta?: number;
  gamma?: number;
  underlyingSpot?: number;
}

export interface Watchlists {
  active: number;
  lists: { name: string; symbols: string[] }[];
  hiddenDefaults?: string[];
}

export interface StopLoss {
  mode: "points" | "amount";
  value: number;
  trailValue: number;
  stopPrice: number;
  peak: number;
  createdTs: number;
}

export interface Position {
  id: string;
  symbol: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  qty: number;
  lotSize: number;
  avgPrice: number;
  ltp: number;
  pnl: number;
  openedTs: number;
  sl?: StopLoss;
}

export interface PaperOrder {
  id: string;
  ts: number;
  symbol: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  side: "BUY" | "SELL";
  qtyLots: number;
  qty: number;
  price: number;
  note: string;
}

export interface PaperState {
  positions: Position[];
  orders: PaperOrder[];
  realized: number;
  unrealized: number;
  total: number;
  capital: number;
  marginUsed: number;
  marginAvailable: number;
  equity: number;
}

export interface BrokerFunds {
  connected: boolean;
  available: number | null;
  used: number | null;
  total: number | null;
  error?: string;
  raw?: Record<string, unknown> | null;
}

export type ConnStatus = "connecting" | "open" | "closed";

export interface ScanRow {
  symbol: string;
  ts: number;
  score: number;
  bias: "UP" | "DOWN" | "NEUTRAL";
  dte: number;
  spot: number;
  atmIV: number | null;
  ivChg5m: number;
  straddle: number | null;
  straddlePct5m: number;
  move5mPct: number;
  range20m: number;
  netGex: number;
  atmGammaOI: number;
  pcr: number | null;
  maxPain: number;
  mpDistPct: number;
  oiImbalance: number;
  components: Record<string, number>;
  reasons: string[];
}

export interface Alert {
  ts: number;
  symbol: string;
  kind: string;
  severity: "critical" | "warning" | "info";
  message: string;
  score: number;
}

export type View = "chain" | "oiprofile" | "scanner" | "chart" | "builder" | "positions" | "scalper";

export type OptionType = "CE" | "PE" | "FUT";
export type Side = "BUY" | "SELL";

export interface StrategyLeg {
  optionType: OptionType;
  strike: number;
  side: Side;
  lots: number;
  price?: number | null;
}

export interface ResolvedLeg extends StrategyLeg {
  qty: number;
  entry: number;
  iv: number;
  greeks: Record<string, number>;
}

export interface Analysis {
  symbol: string;
  expiry: string;
  spot: number;
  lotSize: number;
  dte: number;
  legs: ResolvedLeg[];
  x: number[];
  expiryPnl: number[];
  nowPnl: number[];
  netPremium: number;
  netPremiumType: "DEBIT" | "CREDIT";
  maxProfit: number;
  maxLoss: number;
  maxProfitUnbounded: boolean;
  maxLossUnbounded: boolean;
  breakevens: number[];
  pop: number | null;
  rr: number | null;
  greeks: Record<string, number>;
  greeksPerLot: Record<string, number>;
  margin: { estimate: number; basis: string };
}

export interface SavedStrategy {
  id: string;
  name: string;
  symbol: string;
  expiry: string;
  legs: StrategyLeg[];
  savedAt: number;
}

export type OIBuildup =
  | "LONG_BUILDUP"
  | "SHORT_BUILDUP"
  | "SHORT_COVERING"
  | "LONG_UNWINDING"
  | "NEUTRAL";

export interface ScreenerRow {
  symbol: string;
  spot: number;
  sessionMovePct: number;
  expiry: string;
  dte: number;
  pcr: number | null;
  atmIV: number | null;
  ivRank: number | null;
  ivPct: number | null;
  straddle: number | null;
  straddlePctOfSpot: number | null;
  maxPain: number;
  maxPainDistPct: number;
  netGex: number | null;
  ceOIChg: number;
  peOIChg: number;
  oiBuildup: OIBuildup;
  ts: number;
}

export interface ScreenerProgress {
  scanned: number;
  total: number;
  cycleStart: number | null;
  lastFull: number | null;
  current: string | null;
}

export interface BrokerStatus {
  broker: string;
  configured: boolean;
  authed: boolean;
  clientId: string | null;
  wsConnected: boolean;
}

export interface LiveSpot {
  ltp: number;
  chgPct: number | null;
  ts: number;
}
