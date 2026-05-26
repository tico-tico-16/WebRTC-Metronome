import type { SignalMessage } from "../../shared/types.ts";

type Listener = (message: SignalMessage) => void;

export class SignalingClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();

  connect(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${location.hostname}:3001/ws`);

    this.socket.addEventListener("open", () => {
      this.send({ type: "register", role: "host", name: "Host" });
    });

    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as SignalMessage;
      for (const listener of this.listeners) listener(message);
    });

    this.socket.addEventListener("close", () => {
      this.socket = null;
    });
  }

  onMessage(listener: Listener): void {
    this.listeners.add(listener);
  }

  send(message: SignalMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
