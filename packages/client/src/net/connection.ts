import type { ClientMessage, ServerMessage } from "@bg/shared";

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

interface Handlers {
  onMessage: (msg: ServerMessage) => void;
  onOpen: () => void;
  onClose: () => void;
  /** fired when the socket drops unexpectedly and a reconnect is being attempted */
  onReconnecting?: () => void;
}

/**
 * A WebSocket wrapper that transparently retries on unexpected drops, so a
 * flaky LAN link or a host hiccup doesn't end the match. After each reconnect
 * the store re-sends `join` (with the persisted clientId) to resume the game.
 */
export class Connection {
  private ws!: WebSocket;
  open = false;
  private intentional = false;
  private attempt = 0;

  constructor(
    private url: string,
    private handlers: Handlers,
  ) {
    this.dial();
  }

  private dial(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.attempt = 0;
      this.handlers.onOpen();
    };
    ws.onclose = () => {
      this.open = false;
      if (this.intentional) {
        this.handlers.onClose();
        return;
      }
      this.handlers.onReconnecting?.();
      this.attempt++;
      const delay = Math.min(5000, 600 * this.attempt);
      setTimeout(() => {
        if (!this.intentional) this.dial();
      }, delay);
    };
    ws.onmessage = (ev) => {
      try {
        this.handlers.onMessage(JSON.parse(ev.data as string) as ServerMessage);
      } catch {
        /* ignore malformed */
      }
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Stop retrying and close for good. */
  close(): void {
    this.intentional = true;
    this.ws.close();
  }
}
