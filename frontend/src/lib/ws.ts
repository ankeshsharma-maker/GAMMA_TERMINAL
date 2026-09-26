import { getToken } from "./auth";

type Handler = (msg: any) => void;

export class TerminalSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private handler: Handler;
  private onStatus: (s: "connecting" | "open" | "closed") => void;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private closed = false;
  private lastMsgAt = 0; // any message from the server (a pong counts)
  private attempts = 0; // reconnects since the last open
  private subs = new Map<string, string | null>(); // symbol -> expiry

  constructor(
    handler: Handler,
    onStatus: (s: "connecting" | "open" | "closed") => void
  ) {
    // In the packaged app VITE_WS_BASE (e.g. ws://92.4.84.13) points at the
    // real backend; in the browser / server deploy it's unset and we use the
    // page's own origin.
    const wsBase = import.meta.env.VITE_WS_BASE as string | undefined;
    if (wsBase) {
      this.url = `${wsBase.replace(/\/+$/, "")}/ws`;
    } else {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      this.url = `${proto}://${location.host}/ws`;
    }
    this.handler = handler;
    this.onStatus = onStatus;
  }

  connect() {
    this.closed = false;
    this.onStatus("connecting");
    const tok = getToken();
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.ws = new WebSocket(tok ? `${this.url}?token=${encodeURIComponent(tok)}` : this.url);

    this.ws.onopen = () => {
      this.attempts = 0;
      this.lastMsgAt = Date.now();
      this.onStatus("open");
      for (const [sym, exp] of this.subs) this.send({ action: "subscribe", symbol: sym, expiry: exp });
      this.pingTimer = window.setInterval(() => this.send({ action: "ping" }), 20000);
    };
    this.ws.onmessage = (e) => {
      this.lastMsgAt = Date.now();
      try {
        this.handler(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
    this.ws.onclose = () => {
      this.onStatus("closed");
      if (this.pingTimer) window.clearInterval(this.pingTimer);
      // first retry fast, then every 2 s
      if (!this.closed) this.reconnectTimer = window.setTimeout(() => this.connect(), this.attempts++ === 0 ? 300 : 2000);
    };
    this.ws.onerror = () => this.ws?.close();
  }

  private send(obj: any) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  subscribe(symbol: string, expiry: string | null) {
    this.subs.set(symbol, expiry);
    this.send({ action: "subscribe", symbol, expiry });
  }

  unsubscribe(symbol: string) {
    this.subs.delete(symbol);
    this.send({ action: "unsubscribe", symbol });
  }

  /** Back in the foreground (phone unlocked, tab shown). A socket frozen with the app is
   *  usually dead even when it still reads OPEN: reconnect now if it's closed, otherwise
   *  ping it and replace it if nothing comes back within 1 s -- instead of waiting for
   *  the browser to notice and then the 2 s retry. */
  resume() {
    if (this.closed) return;
    const st = this.ws?.readyState;
    if (st === WebSocket.CONNECTING) return;
    if (st !== WebSocket.OPEN) {
      if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.connect();
      return;
    }
    const since = this.lastMsgAt;
    this.send({ action: "ping" });
    window.setTimeout(() => {
      if (this.lastMsgAt === since && this.ws?.readyState === WebSocket.OPEN) this.reconnectNow();
    }, 1000);
  }

  private reconnectNow() {
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onclose = old.onerror = old.onmessage = null;
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.onStatus("closed");
    this.connect();
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
