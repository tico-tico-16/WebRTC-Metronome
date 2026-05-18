import type { SignalMessage } from "../src/types.ts";

type Listener = (message: SignalMessage) => void;

export class SignalingClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();

  connect(name: string): void {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${location.hostname}:3001/ws`);

    this.socket.addEventListener("open", () => {
      this.send({ type: "register", role: "client", name });
    });

    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as SignalMessage;
      for (const listener of this.listeners) listener(message);
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
