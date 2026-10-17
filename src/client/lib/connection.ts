// The tab's WebSocket to one project. Reconnects with backoff; requests carry
// a `ref` and resolve when the server's matching `ack` arrives.
import type { ClientMessage, ServerMessage } from "../../shared/protocol";

export type ConnState = "connecting" | "open" | "reconnecting" | "failed";

/** The request never reached the server (or its answer never came back). */
export class ConnectionError extends Error {}

type Outgoing = ClientMessage extends infer M ? (M extends { ref?: string } ? Omit<M, "ref"> : never) : never;

export class ProjectConnection {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private attempts = 0;
  private closed = false;
  private retryTimer: number | null = null;

  constructor(
    private readonly slug: string,
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onState: (state: ConnState, detail?: string) => void,
  ) {
    this.connect();
  }

  private connect(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/projects/${this.slug}`);
    this.ws = ws;
    this.onState(this.attempts === 0 ? "connecting" : "reconnecting");
    ws.onopen = () => {
      this.attempts = 0;
      this.onState("open");
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "ack") {
        const p = this.pending.get(msg.ref);
        if (p) {
          this.pending.delete(msg.ref);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error ?? "Rejected"));
        }
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      for (const p of this.pending.values()) p.reject(new ConnectionError("Connection lost — the change was not saved."));
      this.pending.clear();
      if (this.closed) return;
      if (ev.code === 4404) {
        this.onState("failed", ev.reason || "Project unavailable");
        return;
      }
      this.attempts++;
      const delay = Math.min(8000, 400 * 2 ** Math.min(this.attempts, 5)) + Math.random() * 300;
      this.onState("reconnecting");
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Fire and forget. */
  send(msg: Outgoing): void {
    if (this.isOpen) this.ws!.send(JSON.stringify(msg));
  }

  /** Send and wait for the server's ack; rejects with the server's reason. */
  request<T = unknown>(msg: Outgoing): Promise<T> {
    if (!this.isOpen) return Promise.reject(new ConnectionError("Not connected — reconnecting…"));
    const ref = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(ref, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify({ ...msg, ref }));
    });
  }

  /** Reconnect immediately (e.g. the tab became visible again). */
  nudge(): void {
    if (this.closed || this.isOpen || this.ws?.readyState === WebSocket.CONNECTING) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}
