import type { ClientMessage, ServerMessage } from "@bg/shared";

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export class Connection {
  private ws: WebSocket;
  open = false;

  constructor(
    url: string,
    private handlers: {
      onMessage: (msg: ServerMessage) => void;
      onOpen: () => void;
      onClose: () => void;
    },
  ) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.open = true;
      this.handlers.onOpen();
    };
    this.ws.onclose = () => {
      this.open = false;
      this.handlers.onClose();
    };
    this.ws.onmessage = (ev) => {
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

  close(): void {
    this.ws.close();
  }
}
