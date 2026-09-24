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
  /** pts this strike's last trades sit off put-call parity; null when a side has no trade */
  parityDev?: number | null;
  /** parityDev is big enough that the LTP is a stale print */
  parityStale?: boolean;
}

export interface Chain {
  symbol: string;
  expiry: string;
  expiries: string[];
  spot: number;
  /** the market's forward from put-call parity (a synthetic future); "model" = flat rate/dividend fallback */
  forward?: number;
  forwardSource?: "parity" | "model";
  /** carry used for every IV/Greek: the parity-implied dividend yield */
  carryQ?: number;
  atmStrike: number;
  strikeStep: number;
  lotSize: number;
  dte: number;
  nseTimestamp: string | null;
  atmIV: number | null;
  pcr: number | null;
  maxPain: number;
  netGex: number;
  gammaFlip?: number | null;
  atmStraddle?: number | null;
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
  kind?: "symbol" | "option" | "index" | "future";
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
  targetValue?: number;
  stopPrice: number | null;
  targetPrice?: number | null;
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
  todayRealized: number;
  todayPnl: number;
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

/** A near-ATM strike whose OI moved unusually hard (chg > 0 = build, < 0 = unwind). */
export interface HotStrike {
  strike: number;
  side: "CE" | "PE";
  chg: number;
  oi: number;
  pct: number;
  mins: number;
}

export interface ScanRow {
  symbol: string;
  ts: number;
  score: number;
  /** score points gained over the last 5 min; null until history reaches back that far */
  scoreChg5m?: number | null;
  hotStrikes?: HotStrike[];
  /** same trigger as the "starting to build" alert, minus its <60 cap */
  building?: boolean;
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

/* ---- option flow (put / call writing, call / put buying) ---- */
export type FlowDir = "bull" | "bear" | "mixed";
export type FlowKey = "pw" | "cw" | "cb" | "pb" | "cs" | "ps" | "cu" | "pu";

export interface FlowEvent {
  t: number;
  kind: "start" | "turn" | "reversal" | "fade" | "lead";
  from: FlowDir | null;
  to: FlowDir | null;
  bias: number;
  spot: number;
  window: string;
  /** minutes the direction that was lost had lasted (reversals) */
  heldMin: number | null;
  drivers: { strike: number; side: "CE" | "PE"; label: string; dOi: number }[];
  text: string;
  leadFrom?: FlowKey;
  leadTo?: FlowKey;
}

export interface FlowLeg {
  key: FlowKey | null;
  label: string | null;
  dOi: number;
  dPx: number;
  oi: number;
  ltp: number;
}

export interface FlowPoint {
  t: number;
  spot: number;
  /** what the state machine saw (0 when the market had not moved enough) */
  bias: number | null;
  /** the flows' own lean, before the movement gate */
  raw: number | null;
  sm: number | null;
  st: FlowDir | null;
  pw: number;
  cw: number;
  cb: number;
  pb: number;
}

export interface FlowData {
  symbol: string;
  expiry: string;
  window: string;
  windows: string[];
  /** the market is shut: the tracker only samples 09:15-15:30 IST, Mon-Fri */
  closed: boolean;
  spot: number | null;
  asOf: number | null;
  trackingSince: number | null;
  coverageMin: number;
  warming: boolean;
  warmupMin: number;
  quiet: boolean;
  lean: number | null;
  move: number | null;
  needMove: number;
  flat: boolean;
  state: {
    dir: FlowDir | null;
    since: number | null;
    heldMin: number | null;
    bias: number | null;
    strength: number | null;
    leader: FlowKey | null;
  };
  flows: Record<FlowKey, number>;
  bull: number;
  bear: number;
  top: Partial<Record<FlowKey, { strike: number; chg: number }>>;
  series: FlowPoint[];
  events: FlowEvent[];
  strikes: { strike: number; atm: boolean; ce?: FlowLeg; pe?: FlowLeg }[];
}

export interface Alert {
  ts: number;
  symbol: string;
  kind: string;
  severity: "critical" | "warning" | "info";
  message: string;
  score: number;
}

export type View =
  | "flow"
  | "orderflow"
  | "chain"
  | "scrip"
  | "oiprofile"
  | "scanner"
  | "chart"
  | "builder"
  | "positions"
  | "scalper"
  | "auto"
  | "funds"
  | "watchlist"
  | "orders"
  | "trendingoi"
  | "vol"
  | "journal";

/** `grp` = which condition group it sits in, when the list has been split into groups (see lib/condGroups.ts) */
export type AutoCondition = Record<string, unknown> & { kind: string; grp?: number };

/** One group of conditions: they hold when ALL of them do, or when ANY one does */
export interface LogicGroup {
  logic: "all" | "any";
}

export interface AutoRule {
  id: string;
  name: string;
  enabled: boolean;
  symbol: string;
  expiry?: string | null;
  instrument: string; // ATM_CE | OTM1_PE | ...
  side: Side;
  lots: number;
  product: "NRML" | "MIS";
  mode: "paper" | "live";
  /** intraday (default) = force-exit at squareOff / market close, same as
   *  before. positional = ignore squareOff and market close, ride the
   *  position across day boundaries until SL/target/an exit condition. */
  holdType?: "intraday" | "positional";
  entry: AutoCondition[];
  exit: AutoCondition[];
  /** no groups: whether ALL or ANY of the whole list must hold. With groups: how the groups combine. */
  entryLogic?: "all" | "any";
  exitLogic?: "all" | "any";
  /** mixed AND / OR: split the Entry (Exit) list into groups, each with its own AND / OR; absent = one flat list */
  entryGroups?: LogicGroup[];
  exitGroups?: LogicGroup[];
  entryFilter?: {
    premOp?: "" | "gt" | "lt" | "near";
    premVal?: number;
    premTol?: number;
    premPctMin?: number;
    premPctMax?: number;
    premPtsMin?: number;
    premPtsMax?: number;
    deltaMin?: number;
    deltaMax?: number;
  };
  /** unit for slPct / targetPct / trailPct / trailArmPct / beArmPct:
   *  "pct" = % of entry premium, "pts" = premium points, "rs" = rupee P&L */
  /** timeframe (seconds) the entry/exit indicators evaluate on. 0 = raw ticks */
  entryTf?: number;
  /** how many candles of history to keep for indicator warm-up */
  entryBars?: number;
  slBasis?: "pct" | "pts" | "rs";
  slPct?: number;
  targetPct?: number;
  trailPct?: number;
  trailArmPct?: number;
  beArmPct?: number;
  /** single-level scale-out: book target1LotsPct% of the position once it's
   *  target1Pct in favour, let the remainder ride to the target/trail above.
   *  Unset/0 = off. */
  target1Pct?: number;
  target1LotsPct?: number;
  maxTradesPerDay: number;
  cooldownMin: number;
  squareOff: string;
  noEntryAfter?: string;
  noEntryBefore?: string;
  /** ---- safety (all optional; blank / 0 = off) ---- */
  /** stop opening new trades for the week after this many */
  maxTradesPerWeek?: number;
  /** only trade when the expiry is this many whole days away or more / fewer (0 = expiry day) */
  minDte?: number | null;
  maxDte?: number | null;
  /** pause the rule for the rest of the day after this many losing trades in a row */
  maxConsecLosses?: number;
  /** pause the rule for the day once it has lost this many rupees today */
  ruleMaxLoss?: number;
  /** skip the entry when the option's bid-ask spread is wider than this % of its price */
  maxSpreadPct?: number;
  /** largest single live order in lots; bigger orders are split (blank = the engine default) */
  maxLotsPerOrder?: number;
  /** open ALL the legs of a structure as one trade (instrument / side are then ignored);
   *  absent or "single" = the usual one option */
  structure?: string | null;
  /** strikes from ATM to the first leg(s), and the wing / spread width, in whole strike steps */
  offset?: number;
  width?: number;
  _state?: {
    open: null | {
      side: Side;
      strike: number;
      ot: "CE" | "PE" | "STR";
      expiry: string;
      entryPx: number;
      lots: number;
      mode: string;
      peak?: number;
      stopPx?: number | null;
      /** e.g. "23350CE", or a structure's summary */
      label?: string;
      structure?: string;
      /** a structure's legs, with the price each was opened at */
      legs?: { ot: "CE" | "PE"; strike: number; side: Side; mult?: number; entryPx: number }[];
      /** a leg failed to close and the rest are being unwound */
      unwind?: boolean;
    };
    tradesToday: number;
    weekTrades?: number;
    lossStreak?: number;
    dayPnl?: number;
    /** why the rule is paused for today, when it is */
    paused?: string | null;
  };
  /** what the rule concluded on its last look: which conditions passed, or what held it back */
  _why?: {
    phase: "watching" | "blocked" | "open";
    reason?: string | null;
    list?: "entry" | "exit";
    logic?: "all" | "any";
    conds?: boolean[];
    /** with mixed AND / OR: each group's logic, and the group each chip in `conds` belongs to */
    groups?: ("all" | "any")[];
    grp?: number[];
    stop?: number | null;
    ts: number;
  } | null;
  _stats?: { trades: number; winRate: number; net: number; gross: number; today: number };
  /** live readout for the first prev_candle condition in whichever
   *  condition list (entry/exit) is currently active, or null/absent. */
  _live?: {
    field: "open" | "high" | "low" | "close";
    lookback: number;
    tf: number;
    ref: number;
    spot: number;
  } | null;
}

export interface AutoLogEntry {
  ts: number;
  ruleId: string;
  ruleName: string;
  level: string;
  msg: string;
  /** how many times this same message repeated (folded into one line) */
  count?: number;
}

/** GET /api/autobot/structures */
export interface AutoStructureDef {
  key: string;
  title: string;
  offset: number;
  width: number;
  blurb: string;
  legs: number;
  hasOffset: boolean;
  hasWidth: boolean;
}

/** GET /api/autobot/structure-preview -- the legs a structure would open right now */
export interface StructurePreview {
  symbol: string;
  expiry: string;
  atmStrike: number;
  strikeStep: number;
  lotSize: number;
  dte: number | null;
  params: { offset: number; width: number };
  label: string;
  legs: { ot: "CE" | "PE"; strike: number; side: Side; mult: number; price: number; inChain: boolean }[];
  /** points; negative = credit */
  net: number;
  kind: "DEBIT" | "CREDIT";
  perLot: number;
  /** rupees per lot at expiry; null = unlimited */
  maxProfit: number | null;
  maxLoss: number | null;
  missing: number[];
}

/** GET /api/autobot/stats -- every P&L is net of estimated charges unless named gross */
export interface AutoSummary {
  total: number;
  gross: number;
  charges: number;
  totalWin?: number;
  totalLoss?: number;
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;
  payoff: number | null;
  expectancy: number;
  maxDrawdown: number;
  maxWinStreak: number;
  maxLossStreak: number;
  best: number;
  worst: number;
  avgHoldMin?: number | null;
  byReason?: Record<string, { n: number; pnl: number }>;
  byWeekday?: Record<string, { n: number; pnl: number }>;
  equity: number[];
}

export interface AutoTradeRow {
  tid: string;
  ruleId: string;
  ruleName: string;
  symbol: string;
  label: string;
  structure?: string | null;
  side: Side;
  lots: number;
  entryPx: number;
  exitPx: number;
  pnl: number;
  charges: number;
  reason: string;
  partial: boolean;
  mode: string;
  exitTs: number;
  day: string;
}

export interface AutoStats {
  overall: AutoSummary;
  rules: Record<string, AutoSummary & { name: string }>;
  recent: AutoTradeRow[];
}

export interface AutoBotState {
  master: boolean;
  maxLossPerDay: number;
  marketOpen: boolean;
  dailyPnl: number;
  rules: AutoRule[];
  log: AutoLogEntry[];
}

export type OptionType = "CE" | "PE" | "FUT";
export type Side = "BUY" | "SELL";

export interface StrategyLeg {
  optionType: OptionType;
  strike: number;
  side: Side;
  lots: number;
  price?: number | null;
  /** client-only: leg is an already-open position (fetched from broker / paper).
   *  Counted in the payoff but skipped on Execute unless the user opts it in. */
  held?: boolean;
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

/** GET /api/pcr/{symbol}: one trading day of PCR + spot, points as arrays in `fields` order */
export interface PcrSeries {
  symbol: string;
  /** the trading day shown (IST, YYYY-MM-DD); null when nothing has been recorded yet */
  day: string | null;
  /** days that have data, newest first (indices keep whole days; other symbols only what is in memory) */
  days: string[];
  bucketMin: number;
  source: "archive" | "live" | "archive+live" | null;
  /** the chosen day is today, so the chart keeps polling */
  live: boolean;
  expiries: string[];
  fields: string[];
  points: (number | null)[][];
  asOf: number | null;
}

/** GET /api/volatility/{symbol} */
export interface VolExpiry {
  expiry: string;
  dte: number;
  atmStrike: number;
  atmIV: number | null;
  straddle: number | null;
  sigmaMovePct: number | null;
  straddleMovePct: number | null;
  call25: number | null;
  put25: number | null;
  rr25: number | null;
  fly25: number | null;
  stale?: boolean;
  smile?: { strike: number; m: number; iv: number; callIV: number | null; putIV: number | null }[];
}

export interface RvCone {
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  current: number;
  pct: number;
  n: number;
}

/** The Vol tab in plain words (backend volatility.summarize) */
export interface VolSummary {
  verdict: "expensive" | "cheap" | "fair" | null;
  lean: "sell" | "buy" | "none" | null;
  headline: string;
  points: { key: string; title: string; text: string; tone: "info" | "warn" }[];
  note: string;
}

/** how far the expiry curve reaches (backend volatility.curve_reach): the 7-day / 30-day IV are copied, not measured, beyond it */
export interface VolCurve {
  n: number;
  minDte: number | null;
  maxDte: number | null;
  covers7: boolean;
  covers30: boolean;
}

export interface VolatilityData {
  symbol: string;
  spot: number;
  expiry: string;
  asOf: number;
  expiries: VolExpiry[];
  term: VolExpiry[];
  iv30: number | null;
  iv7: number | null;
  curve?: VolCurve | null;
  rv: {
    available: boolean;
    source?: string;
    error?: string;
    days?: number;
    rv5?: number | null;
    rv10?: number | null;
    rv20?: number | null;
    rv30?: number | null;
    cone?: Record<string, RvCone>;
    series?: { d: string; rv: number }[];
    today?: { rv: number | null; bars: number; date: string } | null;
    lastClose?: number;
    lastDate?: string;
  };
  vrp: { iv30: number; rv20: number; spread: number; ratio: number; read: string } | null;
  summary?: VolSummary | null;
  skipped: string[];
}

/** POST /api/portfolio/scenario -- grids are [ivShift][spotShock] */
export interface ScenarioPosition {
  source: "paper" | "broker";
  symbol: string;
  expiry: string;
  strike: number;
  type: "CE" | "PE" | "FUT";
  qty: number;
  lots: number;
  entry: number;
  ltp: number;
  pnl: number;
  priced: boolean;
  iv: number | null;
  ivSource?: "mark" | "chain" | "atm";
  grid: number[][] | null;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
}

export interface ScenarioCell {
  delta: number;
  iv: number;
  spot: number;
}

export interface ScenarioData {
  spotShocks: number[];
  ivShifts: number[];
  daysForward: number;
  nearestDte: number | null;
  current: number;
  grid: number[][];
  positions: ScenarioPosition[];
  greeks: { delta: number; deltaRs1pct: number; gamma: number; theta: number; vega: number };
  byUnderlying: {
    symbol: string;
    spot: number | null;
    pnl: number;
    delta: number;
    deltaRs1pct: number;
    theta: number;
    vega: number;
    atmIV: number | null;
    sigma1dPct: number | null;
  }[];
  worst: ScenarioCell | null;
  best: ScenarioCell | null;
  errors: { symbol: string; expiry: string; error: string }[];
  skipped: string[];
  partial: boolean;
}

export type GreekKey = "delta" | "gamma" | "theta" | "vega" | "iv";

/** POST /api/strategy/chart -- every array is aligned to `times` (bar start, unix s). */
export interface StrategyChartData {
  symbol: string;
  expiry: string;
  interval: number;
  days: number;
  lotSize: number;
  sessions: string[];
  source: string[];
  /** net credit is charted as the positive premium collected (sign = -1) */
  kind: "DEBIT" | "CREDIT";
  sign: 1 | -1;
  times: number[];
  premium: { open: number[]; high: number[]; low: number[]; close: number[] };
  spot: (number | null)[];
  legs: { optionType: "CE" | "PE"; strike: number; side: Side; lots: number; close: number[] }[];
  greeks: {
    net: Record<GreekKey, (number | null)[]>;
    /** each leg's signed contribution to the net, so the legs add up to it */
    legs: Record<GreekKey, (number | null)[]>[];
  } | null;
  greeksNote: string | null;
  updated: number;
}

export interface SavedStrategy {
  id: string;
  name: string;
  symbol: string;
  expiry: string;
  legs: StrategyLeg[];
  savedAt: number;
}

export interface StrategySchedule {
  id: string;
  createdAt: number;
  symbol: string;
  expiry: string;
  legs: StrategyLeg[];
  mode: "paper" | "live";
  entryTime: string | null;
  exitTime: string | null;
  repeat: boolean;
  note: string;
  status: "armed" | "entered" | "done" | "cancelled";
  lastEntryDate: string | null;
  lastExitDate: string | null;
  log: { ts: number; msg: string }[];
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
  // smart-money read (optional; older rows may lack them)
  callWall?: number | null;
  putWall?: number | null;
  wallBreak?: "" | "ABOVE_CALL_WALL" | "BELOW_PUT_WALL";
  maxCallAddStrike?: number | null;
  maxCallAdd?: number;
  maxPutAddStrike?: number | null;
  maxPutAdd?: number;
  atmBias?: "PUT_WRITING" | "CALL_WRITING" | "MIXED";
  flowBias?: number;
  volOiRatio?: number;
  ivSkew?: number | null;
  gammaFlip?: number;
  gammaRegime?: "SHORT_GAMMA" | "LONG_GAMMA";
  gammaFlipDistPct?: number;
  compression?: boolean;
  smartMoneyScore?: number;
  smartBias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  smartSignals?: string[];
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

export interface JournalTrade {
  id: string;
  mode: "paper" | "live";
  symbol: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  side: "BUY" | "SELL";
  qty: number;
  lotSize: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  openedTs: number | null;
  closedTs: number;
  note: string;
}

export interface JournalStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgWin: number;
  avgLoss: number;
  bestTrade: number;
  worstTrade: number;
  profitFactor: number | null;
  avgHoldMin: number;
  equityCurve: { ts: number; cum: number }[];
  byDay: { date: string; pnl: number; trades: number }[];
  bySymbol: { symbol: string; pnl: number; trades: number; winRate: number }[];
}

export interface ShortGuardLeg {
  src: "paper" | "live";
  symbol: string;
  expiry: string;
  strike: number;
  ot: "CE" | "PE";
  qty: number;
  avg: number;
  name: string | null;
  delta: number | null;
  absDelta: number | null;
  /** 0 = under the first alert level, 1 = past it, 2 = past the second */
  level: number;
  spot: number | null;
  /** pts the strike is still out of the money; negative = in the money */
  distance: number | null;
  ltp: number | null;
  roll: {
    strike: number;
    delta: number;
    buyBack: number;
    sellNew: number;
    netPerUnit: number;
    netTotal: number;
  } | null;
  reason: string | null;
}

/** One day of live Flattrade trading, reviewed. */
export interface JournalReview {
  day: string;
  days: string[];
  orders: number;
  filled: number;
  rejected: number;
  gross: number;
  charges: number | null;
  net: number | null;
  byContract: { name: string; pnl: number }[];
  flags: { kind: "reentry" | "flip" | "churn" | "rejected"; text: string }[];
}
