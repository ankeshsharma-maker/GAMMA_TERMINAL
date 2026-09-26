import { create } from "zustand";
import { api } from "./lib/api";
import { TerminalSocket } from "./lib/ws";
import { getDefaultLots } from "./lib/prefs";
import { isViewer } from "./lib/auth";
import { viewFor } from "./lib/navGroups";
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

// --- live-tick coalescing -------------------------------------------------
// The broker feed can push a tick per symbol every ~0.5s; during market hours
// that is a steady stream across the watchlist + subscribed symbols. Applying
// each one with a full `set()` re-rendered every component selecting
// `liveSpots`. Instead we buffer incoming ticks and flush them in one `set`
// at ~5 Hz, which is faster than any eye can follow and keeps React quiet.
const _tickBuf: Record<string, import("./types").LiveSpot> = {};
let _tickFlushTimer: number | null = null;

// same idea for the live-MTM `positions` push: the backend fans it out ~2/s,
// but the header P&L only needs ~1/s. Coalescing stops the strip from
// re-rendering (and micro-reflowing) twice a second.
let _posLiveBuf: State["positionsLive"] = null;
let _posLiveTimer: number | null = null;

export type PendingOrder =
  | {
      kind: "single";
      symbol: string;
      expiry: string;
      strike: number;
      optionType: "CE" | "PE" | "FUT";
      side: "BUY" | "SELL";
      lots: number;
      /** known live price when there's no option chain to look one up from
       *  (futures) -- OrderConfirm uses this instead of a chain-row lookup */
      price?: number | null;
      // from the watchlist order sheet:
      orderType?: "MKT" | "LMT";
      limitPrice?: number | null;
      product?: "NRML" | "MIS";
      /** SL / target PRICES attached to the leg once it fills */
      sl?: number | null;
      target?: number | null;
      /** trailing stop distance in points, attached with the SL / target */
      trail?: number | null;
      lotSize?: number;
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
  /** the list the current chart was opened from (Screener / Movers / Watchlist ...),
   *  in the order it was showing -- the chart's Prev / Next buttons step through it */
  chartQueue: { source: string; symbols: string[] } | null;
  paper: PaperState | null;
  brokerFunds: import("./types").BrokerFunds | null;
  view: View;
  scan: ScanRow[];
  alerts: Alert[];
  alertsSeen: number;
  unusual: UnusualEvent[];
  unusualSeen: number;
  notifOpen: boolean;
  notifDock: boolean;
  notifTab: "alerts" | "unusual" | "oiwatch" | "pricewatch" | "indicatorwatch" | "mtmwatch";
  screener: ScreenerRow[];
  screenerProgress: ScreenerProgress | null;
  screenerPresets: Record<string, Record<string, unknown>>;
  broker: BrokerStatus | null;
  liveSpots: Record<string, LiveSpot>;
  /** tick-by-tick broker MTM pushed over the socket (re-marked from live leg ticks) */
  positionsLive: {
    rows: any[];
    total: number;
    realized: number;
    dayPnl: number;
    ts: number;
    feedTs: number;
  } | null;
  orderMode: "paper" | "live";
  pending: PendingOrder | null;
  autobot: import("./types").AutoBotState | null;
  symClass: "all" | "index" | "stock";
  indexSet: string[];

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
  /** the watchlist order sheet: LIVE -> the confirm dialog; paper -> filled now */
  orderFromSheet: (o: {
    symbol: string;
    expiry: string;
    strike: number;
    optionType: "CE" | "PE" | "FUT";
    side: "BUY" | "SELL";
    lots: number;
    orderType: "MKT" | "LMT";
    limitPrice: number | null;
    product: "NRML" | "MIS";
    sl: number | null;
    target: number | null;
    trail: number | null;
    lotSize: number;
    ltp: number | null;
  }) => Promise<void>;
  confirmPending: () => Promise<void>;
  cancelPending: () => void;
  selectSymbol: (s: string, keepView?: boolean) => void;
  selectExpiry: (e: string) => void;
  refreshChain: () => Promise<void>;
  setView: (v: View) => void;
  markAlertsSeen: () => void;
  openNotif: (tab?: "alerts" | "unusual" | "oiwatch" | "pricewatch" | "indicatorwatch" | "mtmwatch") => void;
  closeNotif: () => void;
  setNotifDock: (v: boolean) => void;
  setNotifTab: (t: "alerts" | "unusual" | "oiwatch" | "pricewatch" | "indicatorwatch" | "mtmwatch") => void;
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
  wlAddFuture: (i: number) => Promise<void>;
  wlClear: (i: number, optionsOnly?: boolean) => Promise<void>;
  setChartInstrument: (v: string) => void;
  setChartQueue: (source: string, symbols: string[]) => void;
  chartStep: (dir: 1 | -1) => void;
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
  quickTradeFuture: (
    symbol: string,
    expiry: string,
    side: "BUY" | "SELL",
    lots?: number
  ) => Promise<void>;
  refreshPaper: () => Promise<void>;
  loadBrokerFunds: () => Promise<void>;
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
    trailValue: number,
    targetValue?: number
  ) => Promise<void>;
  clearStop: (position_id: string) => Promise<void>;
  builderQueue: import("./types").StrategyLeg[];
  queueBuilderLeg: (leg: import("./types").StrategyLeg, goToBuilder?: boolean) => void;
  clearBuilderQueue: () => void;
  setSymClass: (c: "all" | "index" | "stock") => void;
  symClassOk: (sym: string) => boolean;
  loadAutobot: () => Promise<void>;
  autobotMaster: (on: boolean) => Promise<void>;
  autobotMaxLoss: (v: number) => Promise<void>;
  autobotSaveRule: (r: Partial<import("./types").AutoRule>) => Promise<void>;
  autobotEnableRule: (id: string, on: boolean) => Promise<void>;
  autobotDeleteRule: (id: string) => Promise<void>;
  autobotKill: () => Promise<void>;
  autobotResume: (id: string) => Promise<void>;
}

/** a paper fill: the owner via /api/order (mode paper); a view-only user via the
 *  paper-only route (/api/order can go live, so it's closed to them) */
async function paperFill(o: {
  symbol: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE" | "FUT";
  side: "BUY" | "SELL";
  lots: number;
}): Promise<import("./types").PaperState> {
  if (isViewer()) {
    const r = await api.placeOrder({
      symbol: o.symbol, expiry: o.expiry, strike: o.strike, option_type: o.optionType, side: o.side, qty_lots: o.lots,
    });
    return r.state;
  }
  if (o.optionType === "FUT") {
    const r = await api.placeFutureOrder({ symbol: o.symbol, expiry: o.expiry, side: o.side, qtyLots: o.lots, mode: "paper" });
    return r.paper;
  }
  const r = await api.placeUnifiedOrder({
    symbol: o.symbol, expiry: o.expiry, strike: o.strike, optionType: o.optionType, side: o.side, qtyLots: o.lots, mode: "paper",
  });
  return r.paper;
}

/** After a live order from the sheet: wait (up to ~60 s, e.g. a limit order
 *  filling) for the leg to appear in the PositionBook, then bracket it with the
 *  SL / target PRICES. Tells the user if it never filled in that time. */
async function attachWhenFilled(tsym: string, sl: number | null, target: number | null, trail: number | null = null): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    try {
      const d = await api.brokerPositions();
      const row = (d.positions || []).find((x: any) => x.tsym === tsym && Number(x.netqty));
      if (!row) continue;
      await api.legRuleAttach({
        tsym, exch: row.exch || "NFO", netqty: row.netqty, entryPx: Number(row.netavgprc), prd: row.prd,
        unit: "px", sl, target, trail, // px: SL / target are prices, trail stays points
      });
      return;
    } catch (e: any) {
      try {
        window.alert(`Order placed, but the SL / target couldn't be attached: ${e?.message || e}. Set it on the position card.`);
      } catch {
        /* ignore */
      }
      return;
    }
  }
  try {
    window.alert("The order hasn't filled yet, so the SL / target wasn't attached. Set it on the position card once it fills.");
  } catch {
    /* ignore */
  }
}

/** a view-only user can't trade LIVE: say so instead of sending an order the server refuses */
function viewOnly(): boolean {
  if (!isViewer()) return false;
  try {
    window.alert("View-only account — trading is switched off.");
  } catch {
    /* ignore */
  }
  return true;
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
  scalpLots: getDefaultLots(),
  chartInstrument: "",
  chartQueue: null,
  paper: null,
  brokerFunds: null,
  view: "home", // the app opens on the Home dashboard (asked for 24-Sep)
  builderQueue: [],
  scan: [],
  alerts: [],
  alertsSeen: 0,
  unusual: [],
  unusualSeen: 0,
  notifOpen: false,
  notifDock: (() => {
    try {
      return localStorage.getItem("notif.dock") === "1";
    } catch {
      return false;
    }
  })(),
  notifTab: "unusual",
  screener: [],
  screenerProgress: null,
  screenerPresets: {},
  broker: null,
  liveSpots: {},
  positionsLive: null,
  orderMode: "paper",
  pending: null,
  autobot: null,
  symClass: (() => {
    try {
      return (localStorage.getItem("symClass") as "all" | "index" | "stock") || "all";
    } catch {
      return "all";
    }
  })(),
  indexSet: ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX", "BANKEX"],

  setOrderMode: async (m) => {
    if (isViewer()) return "View-only account";
    try {
      const { mode } = await api.orderModeSet(m);
      set({ orderMode: mode });
      return null;
    } catch (e: any) {
      return String(e.message || e);
    }
  },

  requestStrategyExecute: (legs) => {
    if (isViewer()) {
      const { symbol, chain, expiry } = get();
      const exp = expiry ?? chain?.expiry;
      if (!exp || legs.length === 0) return;
      api.paperStrategy({ symbol, expiry: exp, legs }).then((r) => set({ paper: r.paper }), () => {});
      return;
    }
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

  orderFromSheet: async (o) => {
    if (get().orderMode === "live" && !isViewer()) {
      set({
        pending: {
          kind: "single", symbol: o.symbol, expiry: o.expiry, strike: o.strike, optionType: o.optionType,
          side: o.side, lots: o.lots, price: o.orderType === "LMT" ? o.limitPrice : o.ltp,
          orderType: o.orderType, limitPrice: o.limitPrice, product: o.product, sl: o.sl, target: o.target,
          trail: o.trail, lotSize: o.lotSize,
        },
      });
      return;
    }
    set({ paper: await paperFill({ symbol: o.symbol, expiry: o.expiry, strike: o.strike, optionType: o.optionType, side: o.side, lots: o.lots }) });
  },

  confirmPending: async () => {
    const p = get().pending;
    if (!p) return;
    if (viewOnly()) return set({ pending: null });
    set({ pending: null });
    if (p.kind === "single") {
      if (p.optionType === "FUT") {
        const r = await api.placeFutureOrder({
          symbol: p.symbol,
          expiry: p.expiry,
          side: p.side,
          qtyLots: p.lots,
          mode: "live",
        });
        set({ paper: r.paper });
      } else {
        const r = await api.placeUnifiedOrder({
          symbol: p.symbol,
          expiry: p.expiry,
          strike: p.strike,
          optionType: p.optionType,
          side: p.side,
          qtyLots: p.lots,
          mode: "live",
          ...(p.orderType ? { orderType: p.orderType, price: p.orderType === "LMT" ? p.limitPrice : null } : {}),
          ...(p.product ? { product: p.product } : {}),
        });
        set({ paper: r.paper });
        // SL / target from the order sheet: attach to the leg once it shows as filled
        const tsym = r.result?.tsym;
        if (tsym && (p.sl != null || p.target != null || p.trail != null))
          void attachWhenFilled(tsym, p.sl ?? null, p.target ?? null, p.trail ?? null);
      }
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
        } else if (msg.type === "positions") {
          _posLiveBuf = msg.data;
          const prev = get().positionsLive;
          if (!prev || Date.now() / 1000 - (prev.feedTs || prev.ts || 0) > 5) {
            // stale on screen (just unlocked / reconnected): show this one now
            if (_posLiveTimer != null) window.clearTimeout(_posLiveTimer);
            _posLiveTimer = null;
            set({ positionsLive: msg.data });
          } else if (_posLiveTimer == null) {
            _posLiveTimer = window.setTimeout(() => {
              _posLiveTimer = null;
              if (_posLiveBuf) set({ positionsLive: _posLiveBuf });
            }, 1000);
          }
        } else if (msg.type === "tick") {
          const d = msg.data;
          _tickBuf[d.symbol] = { ltp: d.ltp, chgPct: d.chgPct, ts: d.ts };
          if (_tickFlushTimer == null) {
            _tickFlushTimer = window.setTimeout(() => {
              _tickFlushTimer = null;
              const batch = { ..._tickBuf };
              for (const k in _tickBuf) delete _tickBuf[k];
              set({ liveSpots: { ...get().liveSpots, ...batch } });
            }, 200);
          }
        } else if (msg.type === "error" && msg.symbol === get().symbol) {
          set({ chainError: msg.message });
        }
      },
      (conn) => set({ conn })
    );
    socket.connect();
    socket.subscribe(get().symbol, get().expiry);
    set({ socket });
    // phone unlocked / app back in front: live data again at once, not after the socket
    // notices it died + a 2 s retry + the next timer ticks (was ~3-4 s of stale MTM)
    if (typeof document !== "undefined") {
      let lastResume = 0;
      const onResume = () => {
        if (document.hidden || Date.now() - lastResume < 1000) return;
        lastResume = Date.now();
        socket.resume();
        window.dispatchEvent(new Event("gt-resume"));
      };
      document.addEventListener("visibilitychange", onResume);
      window.addEventListener("focus", onResume);
    }
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
    // the owner's book: broker, funds, order mode, paper, AutoBot. A view-only
    // user has none of it (the server answers 403), so don't ask.
    if (!isViewer()) {
      const pollBroker = () => {
        if (typeof document !== "undefined" && document.hidden) return;
        api.brokerStatus().then((b) => set({ broker: b }), () => {});
        api.brokerFunds().then((f) => set({ brokerFunds: f }), () => {});
      };
      pollBroker();
      setInterval(pollBroker, 10000);
      window.addEventListener("gt-resume", pollBroker);
      api.orderModeGet().then(
        (d) => set({ orderMode: d.mode }),
        () => {}
      );
      get().loadAutobot();
      setInterval(() => {
        if (!(typeof document !== "undefined" && document.hidden)) get().loadAutobot();
      }, 15000);
    } else if (viewFor(get().view) !== get().view) {
      set({ view: "home" });
    }
    // the paper book (a view-only user's is their own): polls skip while the tab
    // is hidden and only `set()` when something actually changed
    get().refreshPaper();
    setInterval(() => {
      if (!(typeof document !== "undefined" && document.hidden)) get().refreshPaper();
    }, 8000);
    api.symbols().then(
      (d) =>
        d.indices?.length &&
        set({
          // merge — never drop the hand-kept BSE indices (SENSEX / BANKEX)
          indexSet: [
            ...new Set([...get().indexSet, ...d.indices.map((s) => s.toUpperCase())]),
          ],
        }),
      () => {}
    );
  },

  setSymClass: (c) => {
    try {
      localStorage.setItem("symClass", c);
    } catch {
      /* ignore */
    }
    set({ symClass: c });
  },
  symClassOk: (sym) => {
    const { symClass, indexSet } = get();
    if (symClass === "all") return true;
    const isIdx = indexSet.includes((sym || "").toUpperCase());
    return symClass === "index" ? isIdx : !isIdx;
  },

  loadAutobot: async () => {
    try {
      const a = await api.autobot();
      if (JSON.stringify(get().autobot) !== JSON.stringify(a)) set({ autobot: a });
    } catch {
      /* ignore */
    }
  },
  autobotResume: async (id) => set({ autobot: await api.autobotResume(id) }),
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
      ...(keepView ? {} : { view: "scrip" }),
    });
    socket?.subscribe(s, null);
    // a slow response for a symbol you've already stepped past (Next / Prev clicked
    // quickly) must not land on the symbol you're looking at now
    api.chain(s).then(
      (c) => get().symbol === s && set({ chain: c, expiry: c.expiry }),
      (e) => get().symbol === s && set({ chainError: String(e.message || e) })
    );
  },

  selectExpiry: (e) => {
    const { socket, symbol } = get();
    set({ expiry: e });
    socket?.subscribe(symbol, e);
    api.chain(symbol, e).then(
      (c) => get().symbol === symbol && set({ chain: c, chainError: null }),
      (err) => get().symbol === symbol && set({ chainError: String(err.message || err) })
    );
  },

  refreshChain: () => {
    const { symbol, expiry } = get();
    if (!symbol) return Promise.resolve();
    return api.chain(symbol, expiry ?? undefined).then(
      (c) => void (get().symbol === symbol && set({ chain: c, chainError: null })),
      (err) => void (get().symbol === symbol && set({ chainError: String(err.message || err) }))
    );
  },

  setView: (want) => {
    const v = viewFor(want); // a viewer asking for Positions / Orders / Funds / ... lands on Home
    set({ view: v, ...(v === "scanner" ? { alertsSeen: get().alerts.length } : {}) });
  },

  queueBuilderLeg: (leg, goToBuilder = true) =>
    set((s) => ({
      builderQueue: [...s.builderQueue, leg],
      ...(goToBuilder ? { view: "builder" as const } : {}),
    })),
  clearBuilderQueue: () => set({ builderQueue: [] }),

  markAlertsSeen: () => set({ alertsSeen: get().alerts.length }),

  openNotif: (tab) => {
    const t = tab ?? get().notifTab;
    // when the alerts panel is docked it's already on screen — just switch
    // tab / clear the badge, don't stack a pop-over on top of it
    set({
      notifOpen: get().notifDock ? false : true,
      notifTab: t,
      ...(t === "alerts"
        ? { alertsSeen: get().alerts.length }
        : t === "unusual"
          ? { unusualSeen: get().unusual.length }
          : {}),
    });
  },
  closeNotif: () => set({ notifOpen: false }),
  setNotifDock: (v) => {
    try {
      localStorage.setItem("notif.dock", v ? "1" : "0");
    } catch {}
    set({
      notifDock: v,
      notifOpen: v ? false : get().notifOpen,
      // opening the dock clears the badge
      ...(v ? { alertsSeen: get().alerts.length, unusualSeen: get().unusual.length } : {}),
    });
  },
  setNotifTab: (t) =>
    set({
      notifTab: t,
      ...(t === "alerts"
        ? { alertsSeen: get().alerts.length }
        : t === "unusual"
          ? { unusualSeen: get().unusual.length }
          : {}),
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
    // the newly-added strikes are filtered the same way as their underlying
    // symbol -- don't let them land invisibly behind the current filter.
    if (!get().symClassOk(sym)) get().setSymClass("all");
  },
  wlAddFuture: async (i) => {
    const sym = get().symbol;
    const exp = get().expiry ?? get().chain?.expiry;
    if (!exp) return;
    const res = await api.wlAddFuture(i, { symbol: sym, expiry: exp });
    set({ watchlists: { active: res.active, lists: res.lists }, watch: res.quotes });
    if (!get().symClassOk(sym)) get().setSymClass("all");
  },
  wlClear: async (i, optionsOnly = false) => {
    set({ watchlists: await api.wlClear(i, optionsOnly) });
    await get().refreshWatch();
  },
  setChartInstrument: (v) => set({ chartInstrument: v }),
  setChartQueue: (source, symbols) => {
    const seen = new Set<string>();
    const list = symbols.filter((s) => s && !seen.has(s) && !!seen.add(s));
    set({ chartQueue: list.length > 1 ? { source, symbols: list } : null });
  },
  chartStep: (dir) => {
    const { chartQueue, symbol, selectSymbol } = get();
    if (!chartQueue) return;
    const list = chartQueue.symbols;
    const i = list.indexOf(symbol);
    // not in the list (symbol picked from the dropdown): Next -> first, Prev -> last
    const j = i === -1 ? (dir === 1 ? 0 : list.length - 1) : i + dir;
    if (j < 0 || j >= list.length) return;
    selectSymbol(list[j], true);
  },

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
    set({ paper: await paperFill({ symbol, expiry, strike, optionType: ot, side, lots: qty }) });
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
    set({ paper: await paperFill({ symbol, expiry, strike, optionType: ot, side, lots: qty }) });
  },

  quickTradeFuture: async (symbol, expiry, side, lots) => {
    symbol = symbol.toUpperCase();
    const qty = lots ?? get().scalpLots;
    // known live price, if any -- lets the LIVE confirm dialog show a real
    // estimate instead of ₹0 (futures have no option chain to price against)
    const wq = get().watch.find(
      (w) => w.kind === "future" && w.symbol === symbol && w.expiry === expiry
    );
    if (get().orderMode === "live") {
      set({
        pending: {
          kind: "single", symbol, expiry, strike: 0, optionType: "FUT", side, lots: qty,
          price: wq?.ltp ?? null,
        },
      });
      return;
    }
    set({ paper: await paperFill({ symbol, expiry, strike: 0, optionType: "FUT", side, lots: qty }) });
  },

  refreshPaper: async () => {
    try {
      const p = await api.paper();
      if (JSON.stringify(get().paper) !== JSON.stringify(p)) set({ paper: p });
    } catch {
      /* ignore */
    }
  },

  loadBrokerFunds: async () => {
    try {
      set({ brokerFunds: await api.brokerFunds() });
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
    set({ paper: await paperFill({ symbol, expiry: exp, strike, optionType, side, lots }) });
  },

  closePosition: async (id) => {
    set({ paper: await api.closePosition(id) });
  },

  setStop: async (position_id, mode, value, trailValue, targetValue = 0) => {
    set({ paper: await api.setStop({ position_id, mode, value, trailValue, targetValue }) });
  },
  clearStop: async (position_id) => {
    set({ paper: await api.clearStop(position_id) });
  },
}));
