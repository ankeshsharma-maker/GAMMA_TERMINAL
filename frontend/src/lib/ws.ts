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
    this.ws = new WebSocket(tok ? `${this.url}?token=${encodeURIComponent(tok)}` : this.url);

    this.ws.onopen = () => {
      this.onStatus("open");
      for (const [sym, exp] of this.subs) this.send({ action: "subscribe", symbol: sym, expiry: exp });
      this.pingTimer = window.setInterval(() => this.send({ action: "ping" }), 20000);
    };
    this.ws.onmessage = (e) => {
      try {
        this.handler(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
    this.ws.onclose = () => {
      this.onStatus("closed");
      if (this.pingTimer) window.clearInterval(this.pingTimer);
      if (!this.closed) this.reconnectTimer = window.setTimeout(() => this.connect(), 2000);
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

  close() {
    this.closed = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
