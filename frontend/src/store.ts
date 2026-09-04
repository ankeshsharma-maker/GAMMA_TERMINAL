import { create } from "zustand";
import { api } from "./lib/api";
import { TerminalSocket } from "./lib/ws";
import type {
  Alert,
  BrokerStatus,
  Chain,
  ConnStatus,
  LiveSpot,
  PaperState,
  ScanRow,
  ScreenerProgress,
  ScreenerRow,
  StrategyLeg,
  UnusualEvent,
  View,
  WatchQuote,
  Watchlists,
} from "./types";

export type PendingOrder =
  | {
      kind: "single";
      symbol: string;
      expiry: string;
      strike: number;
      optionType: "CE" | "PE";
      side: "BUY" | "SELL";
      lots: number;
    }
  | {
      kind: "strategy";
      symbol: string;
      expiry: string;
      legs: StrategyLeg[];
    };

interface State {
  socket: TerminalSocket | null;
  conn: ConnStatus;
  symbol: string;
  expiry: string | null;
  chain: Chain | null;
  chainError: string | null;
  watch: WatchQuote[];
  watchlists: Watchlists | null;
  scalpLots: number;
  chartInstrument: string; // "" = underlying spot, "STRADDLE", or an option key
  paper: PaperState | null;
  brokerFunds: import("./types").BrokerFunds | null;
  view: View;
  scan: ScanRow[];
  alerts: Alert[];
  alertsSeen: number;
  unusual: UnusualEvent[];
  unusualSeen: number;
  notifOpen: boolean;
  notifTab: "alerts" | "unusual";
  screener: ScreenerRow[];
  screenerProgress: ScreenerProgress | null;
  screenerPresets: Record<string, Record<string, unknown>>;
  broker: BrokerStatus | null;
  liveSpots: Record<string, LiveSpot>;
  orderMode: "paper" | "live";
  pending: PendingOrder | null;
  autobot: import("./types").AutoBotState | null;

  init: () => void;
  connectBroker: () => Promise<void>;
  disconnectBroker: () => Promise<void>;
  refreshBroker: () => Promise<string | null>;
  setBrokerToken: (token: string) => Promise<void>;
  brokerDirectLogin: (creds: {
    uid: string;
    pwd: string;
    totp: string;
    vc?: string;
  }) => Promise<void>;
  setOrderMode: (m: "paper" | "live") => Promise<string | null>;
  requestStrategyExecute: (legs: import("./types").StrategyLeg[]) => void;
  confirmPending: () => Promise<void>;
  cancelPending: () => void;
  selectSymbol: (s: string, keepView?: boolean) => void;
  selectExpiry: (e: string) => void;
  setView: (v: View) => void;
  markAlertsSeen: () => void;
  openNotif: (tab?: "alerts" | "unusual") => void;
  closeNotif: () => void;
  setNotifTab: (t: "alerts" | "unusual") => void;
  addWatch: (s: string) => Promise<void>;
  removeWatch: (s: string) => Promise<void>;
  loadWatchlists: () => Promise<void>;
  refreshWatch: () => Promise<void>;
  wlSetActive: (i: number) => Promise<void>;
  wlAddList: () => Promise<void>;
  wlDeleteList: (i: number) => Promise<void>;
  wlAdd: (i: number, s: string) => Promise<void>;
  wlRemove: (i: number, s: string) => Promise<void>;
  wlRename: (i: number, name: string) => Promise<void>;
  wlAddStrikes: (i: number, count?: number) => Promise<void>;
  wlClear: (i: number, optionsOnly?: boolean) => Promise<void>;
  setChartInstrument: (v: string) => void;
  setScalpLots: (n: number) => void;
  quickTrade: (symbol: string, ot: "CE" | "PE", side: "BUY" | "SELL", lots?: number) => Promise<void>;
  quickTradeAt: (
    symbol: string,
    expiry: string,
    strike: number,
    ot: "CE" | "PE",
    side: "BUY" | "SELL",
    lots?: number
  ) => Promise<void>;
  refreshPaper: () => Promise<void>;
  placeOrder: (p: {
    strike: number;
    optionType: "CE" | "PE";
    side: "BUY" | "SELL";
    lots: number;
  }) => Promise<void>;
  closePosition: (id: string) => Promise<void>;
  setStop: (
    position_id: string,
    mode: "points" | "amount",
    value: number,
    trailValue: number
  ) => Promise<void>;
  clearStop: (position_id: string) => Promise<void>;
  builderQueue: import("./types").StrategyLeg[];
  queueBuilderLeg: (leg: import("./types").StrategyLeg, goToBuilder?: boolean) => void;
  clearBuilderQueue: () => void;
  loadAutobot: () => Promise<void>;
  autobotMaster: (on: boolean) => Promise<void>;
  autobotMaxLoss: (v: number) => Promise<void>;
  autobotSaveRule: (r: Partial<import("./types").AutoRule>) => Promise<void>;
  autobotEnableRule: (id: string, on: boolean) => Promise<void>;
  autobotDeleteRule: (id: string) => Promise<void>;
  autobotKill: () => Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  socket: null,
  conn: "connecting",
  symbol: "NIFTY",
  expiry: null,
  chain: null,
  chainError: null,
  watch: [],
  watchlists: null,
  scalpLots: 1,
  chartInstrument: "",
  paper: null,
  brokerFunds: null,
  view: "chain",
  builderQueue: [],
  scan: [],
  alerts: [],
  alertsSeen: 0,
  unusual: [],
  unusualSeen: 0,
  notifOpen: false,
  notifTab: "unusual",
  screener: [],
  screenerProgress: null,
  screenerPresets: {},
  broker: null,
  liveSpots: {},
  orderMode: "paper",
  pending: null,
  autobot: null,

  setOrderMode: async (m) => {
    try {
      const { mode } = await api.orderModeSet(m);
      set({ orderMode: mode });
      return null;
    } catch (e: any) {
      return String(e.message || e);
    }
  },

  requestStrategyExecute: (legs) => {
    const { symbol, chain, expiry, orderMode } = get();
    const exp = expiry ?? chain?.expiry;
    if (!exp || legs.length === 0) return;
    const p = { kind: "strategy" as const, symbol, expiry: exp, legs };
    if (orderMode === "live") {
      set({ pending: p });
    } else {
      api
        .executeStrategy({ symbol, expiry: exp, legs, mode: "paper" })
        .then((r) => set({ paper: r.paper }));
    }
  },

  confirmPending: async () => {
    const p = get().pending;
    if (!p) return;
    set({ pending: null });
    if (p.kind === "single") {
      const r = await api.placeUnifiedOrder({
        symbol: p.symbol,
        expiry: p.expiry,
        strike: p.strike,
        optionType: p.optionType,
        side: p.side,
        qtyLots: p.lots,
        mode: "live",
      });
      set({ paper: r.paper });
    } else {
      const r = await api.executeStrategy({
        symbol: p.symbol,
        expiry: p.expiry,
        legs: p.legs,
        mode: "live",
      });
      set({ paper: r.paper });
    }
  },

  cancelPending: () => set({ pending: null }),

  connectBroker: async () => {
    const { url } = await api.brokerLogin();
    window.open(url, "_blank", "noopener");
  },
  disconnectBroker: async () => {
    await api.brokerLogout();
    set({ broker: await api.brokerStatus().catch(() => null) });
  },
  refreshBroker: async () => {
    const b = await api.brokerRefresh();
    set({ broker: b });
    api.brokerFunds().then((f) => set({ brokerFunds: f }), () => {});
    return b.ok ? null : b.error || "refresh failed";
  },
  setBrokerToken: async (token: string) => {
    const b = await api.brokerSetToken(token.trim());
    set({ broker: b });
    api.brokerFunds().then((f) => set({ brokerFunds: f }), () => {});
  },
  brokerDirectLogin: async (creds: { uid: string; pwd: string; totp: string; vc?: string }) => {
    const b = await api.brokerDirectLogin(creds);
    set({ broker: b });
    api.brokerFunds().then((f) => set({ brokerFunds: f }), () => {});
  },

  init: () => {
    if (get().socket) return;
    const socket = new TerminalSocket(
      (msg) => {
        if (msg.type === "chain") {
          const c: Chain = msg.data;
          if (c.symbol !== get().symbol) return;
          set({
            chain: c,
            chainError: null,
            expiry: get().expiry && c.expiries.includes(get().expiry!) ? get().expiry : c.expiry,
          });
        } else if (msg.type === "watchlist") {
          set({ watch: msg.data });
        } else if (msg.type === "scan") {
          set({ scan: msg.data });
        } else if (msg.type === "alerts") {
          set({ alerts: msg.data });
        } else if (msg.type === "unusual") {
          set({ unusual: msg.data });
        } else if (msg.type === "screener") {
          set({ screener: msg.data, screenerProgress: msg.progress ?? get().screenerProgress });
        } else if (msg.type === "autobot") {
          set({ autobot: msg.data });
        } else if (msg.type === "tick") {
          const d = msg.data;
          set({ liveSpots: { ...get().liveSpots, [d.symbol]: { ltp: d.ltp, chgPct: d.chgPct, ts: d.ts } } });
        } else if (msg.type === "error" && msg.symbol === get().symbol) {
          set({ chainError: msg.message });
        }
      },
      (conn) => set({ conn })
    );
    socket.connect();
    socket.subscribe(get().symbol, get().expiry);
    set({ socket });
    api.chain(get().symbol).then(
      (c) => set({ chain: c, expiry: c.expiry, chainError: null }),
      (e) => set({ chainError: String(e.message || e) })
    );
    api.scan().then(
      (d) => set({ scan: d.rows, alerts: d.alerts }),
      () => {}
    );
    api.unusual().then((d) => set({ unusual: d.events }), () => {});
    get().loadWatchlists();
    api.screener().then(
      (d) =>
        set({ screener: d.rows, screenerProgress: d.progress, screenerPresets: d.presets }),
      () => {}
    );
    const pollBroker = () => {
      api.brokerStatus().then((b) => set({ broker: b }), () => {});
      api.brokerFunds().then((f) => set({ brokerFunds: f }), () => {});
    };
    pollBroker();
    setInterval(pollBroker, 10000);
    api.orderModeGet().then(
      (d) => set({ orderMode: d.mode }),
      () => {}
    );
    get().refreshPaper();
    setInterval(() => get().refreshPaper(), 5000);
    get().loadAutobot();
    setInterval(() => get().loadAutobot(), 15000);
  },

  loadAutobot: async () => {
    try {
      set({ autobot: await api.autobot() });
    } catch {
      /* ignore */
    }
  },
  autobotMaster: async (on) => set({ autobot: await api.autobotMaster(on) }),
  autobotMaxLoss: async (v) => set({ autobot: await api.autobotMaxLoss(v) }),
  autobotSaveRule: async (r) => set({ autobot: await api.autobotSaveRule(r) }),
  autobotEnableRule: async (id, on) => set({ autobot: await api.autobotEnableRule(id, on) }),
  autobotDeleteRule: async (id) => set({ autobot: await api.autobotDeleteRule(id) }),
  autobotKill: async () => set({ autobot: await api.autobotKill() }),

  selectSymbol: (s, keepView = false) => {
    const { socket, symbol } = get();
    if (s === symbol) return;
    socket?.unsubscribe(symbol);
    set({
      symbol: s,
      expiry: null,
      chain: null,
      chainError: null,
      chartInstrument: "",
      ...(keepView ? {} : { view: "chain" }),
    });
    socket?.subscribe(s, null);
    api.chain(s).then(
      (c) => set({ chain: c, expiry: c.expiry }),
      (e) => set({ chainError: String(e.message || e) })
    );
  },

  selectExpiry: (e) => {
    const { socket, symbol } = get();
    set({ expiry: e });
    socket?.subscribe(symbol, e);
    api.chain(symbol, e).then(
      (c) => set({ chain: c, chainError: null }),
      (err) => set({ chainError: String(err.message || err) })
    );
  },

  setView: (v) => set({ view: v, ...(v === "scanner" ? { alertsSeen: get().alerts.length } : {}) }),

  queueBuilderLeg: (leg, goToBuilder = true) =>
    set((s) => ({
      builderQueue: [...s.builderQueue, leg],
      ...(goToBuilder ? { view: "builder" as const } : {}),
    })),
  clearBuilderQueue: () => set({ builderQueue: [] }),

  markAlertsSeen: () => set({ alertsSeen: get().alerts.length }),

  openNotif: (tab) => {
    const t = tab ?? get().notifTab;
    set({
      notifOpen: true,
      notifTab: t,
      ...(t === "alerts"
        ? { alertsSeen: get().alerts.length }
        : { unusualSeen: get().unusual.length }),
    });
  },
  closeNotif: () => set({ notifOpen: false }),
  setNotifTab: (t) =>
    set({
      notifTab: t,
      ...(t === "alerts"
        ? { alertsSeen: get().alerts.length }
        : { unusualSeen: get().unusual.length }),
    }),

  addWatch: async (s) => {
    const wl = get().watchlists;
    if (wl) await get().wlAdd(wl.active, s);
    else await api.addWatch(s.trim().toUpperCase());
  },
  removeWatch: async (s) => {
    const wl = get().watchlists;
    if (wl) await get().wlRemove(wl.active, s);
    else {
      await api.removeWatch(s);
      set({ watch: get().watch.filter((w) => w.symbol !== s) });
    }
  },

  loadWatchlists: async () => {
    try {
      set({ watchlists: await api.watchlists() });
    } catch {
      /* ignore */
    }
  },
  refreshWatch: async () => {
    try {
      set({ watch: (await api.watchQuotes()).quotes });
    } catch {
      /* ignore */
    }
  },
  wlSetActive: async (i) => {
    set({ watchlists: await api.wlSetActive(i) });
    await get().refreshWatch();
  },
  wlAddList: async () => {
    set({ watchlists: await api.wlAddList() });
    await get().refreshWatch();
  },
  wlDeleteList: async (i) => {
    set({ watchlists: await api.wlDeleteList(i) });
    await get().refreshWatch();
  },
  wlAdd: async (i, s) => {
    set({ watchlists: await api.wlAdd(i, s.trim().toUpperCase()) });
    await get().refreshWatch();
  },
  wlRemove: async (i, s) => {
    set({ watchlists: await api.wlRemove(i, s) });
    await get().refreshWatch();
  },
  wlRename: async (i, name) => set({ watchlists: await api.wlRename(i, name) }),
  wlAddStrikes: async (i, count = 10) => {
    const sym = get().symbol;
    const exp = get().expiry ?? get().chain?.expiry;
    const res = await api.wlAddStrikes(i, { symbol: sym, expiry: exp ?? undefined, count });
    set({ watchlists: { active: res.active, lists: res.lists }, watch: res.quotes });
  },
  wlClear: async (i, optionsOnly = false) => {
    set({ watchlists: await api.wlClear(i, optionsOnly) });
    await get().refreshWatch();
  },
  setChartInstrument: (v) => set({ chartInstrument: v }),

  setScalpLots: (n) => set({ scalpLots: Math.max(1, n) }),

  quickTrade: async (symbol, ot, side, lots) => {
    symbol = symbol.toUpperCase();
    const qty = lots ?? get().scalpLots;
    const wq = get().watch.find((w) => w.symbol === symbol);
    let expiry = wq?.expiry;
    let strike = wq?.atmStrike;
    if (!expiry || strike == null) {
      try {
        const c = await api.chain(symbol);
        expiry = c.expiry;
        strike = c.atmStrike;
      } catch {
        return;
      }
    }
    if (get().orderMode === "live") {
      set({
        pending: { kind: "single", symbol, expiry, strike, optionType: ot, side, lots: qty },
      });
      return;
    }
    const r = await api.placeUnifiedOrder({
      symbol,
      expiry,
      strike,
      optionType: ot,
      side,
      qtyLots: qty,
      mode: "paper",
    });
    set({ paper: r.paper });
  },

  quickTradeAt: async (symbol, expiry, strike, ot, side, lots) => {
    symbol = symbol.toUpperCase();
    const qty = lots ?? get().scalpLots;
    if (get().orderMode === "live") {
      set({
        pending: { kind: "single", symbol, expiry, strike, optionType: ot, side, lots: qty },
      });
      return;
    }
    const r = await api.placeUnifiedOrder({
      symbol,
      expiry,
      strike,
      optionType: ot,
      side,
      qtyLots: qty,
      mode: "paper",
    });
    set({ paper: r.paper });
  },

  refreshPaper: async () => {
    try {
      set({ paper: await api.paper() });
    } catch {
      /* ignore */
    }
  },

  placeOrder: async ({ strike, optionType, side, lots }) => {
    const { symbol, chain, expiry, orderMode } = get();
    const exp = expiry ?? chain?.expiry;
    if (!exp) return;
    if (orderMode === "live") {
      set({
        pending: { kind: "single", symbol, expiry: exp, strike, optionType, side, lots },
      });
      return;
    }
    const r = await api.placeUnifiedOrder({
      symbol,
      expiry: exp,
      strike,
      optionType,
      side,
      qtyLots: lots,
      mode: "paper",
    });
    set({ paper: r.paper });
  },

  closePosition: async (id) => {
    set({ paper: await api.closePosition(id) });
  },

  setStop: async (position_id, mode, value, trailValue) => {
    set({ paper: await api.setStop({ position_id, mode, value, trailValue }) });
  },
  clearStop: async (position_id) => {
    set({ paper: await api.clearStop(position_id) });
  },
}));
