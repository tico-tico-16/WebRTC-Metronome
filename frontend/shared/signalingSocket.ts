import type { SignalMessage } from "../../shared/types.ts";

/** Carrier NATs and proxies drop idle TCP connections after minutes, so an open socket pings this often. */
export const SIGNALING_PING_INTERVAL_MS = 30_000;
/** The server answers pings at once; without a pong this soon the connection is treated as lost. */
export const SIGNALING_PONG_TIMEOUT_MS = 10_000;

const PING = "ping";
const PONG = "pong";

export type SignalListener = (message: SignalMessage) => void;
export type CloseListener = () => void;

export function signalingBaseUrl(): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const configuredUrl = env?.VITE_SIGNALING_BASE_URL?.replace(/\/$/, "");
  if (configuredUrl) return configuredUrl;

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.hostname}:3001/ws`;
}

/**
 * The signaling WebSocket shared by the host and participant clients: registers once open,
 * keeps the connection alive with ping/pong, and passes on messages and the close.
 */
export class SignalingSocket {
  private socket: WebSocket | null = null;
  private readonly listeners = new Set<SignalListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private pingTimer: number | null = null;
  private pongTimer: number | null = null;

  /** Opens `url` unless a socket is already connecting or open, and sends `register` once it opens. */
  connect(url: string, register: SignalMessage): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.send(register);
      this.stopKeepalive();
      this.pingTimer = window.setInterval(() => this.ping(socket), SIGNALING_PING_INTERVAL_MS);
    });

    socket.addEventListener("message", (event) => this.receive(socket, event.data));

    socket.addEventListener("close", () => this.handleClose(socket));
  }

  onMessage(listener: SignalListener): void {
    this.listeners.add(listener);
  }

  onClose(listener: CloseListener): void {
    this.closeListeners.add(listener);
  }

  send(message: SignalMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private receive(socket: WebSocket, data: unknown): void {
    if (this.socket !== socket) return;
    if (data === PONG) {
      this.clearPongTimer();
      return;
    }

    let message: SignalMessage;
    try {
      message = JSON.parse(String(data)) as SignalMessage;
    } catch (error) {
      console.warn("Ignoring a signaling message that is not JSON.", error);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  private ping(socket: WebSocket): void {
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(PING);
    if (this.pongTimer === null) {
      this.pongTimer = window.setTimeout(() => this.pongMissed(socket), SIGNALING_PONG_TIMEOUT_MS);
    }
  }

  private pongMissed(socket: WebSocket): void {
    this.pongTimer = null;
    if (this.socket !== socket) return;
    console.warn(`No pong from the signaling server within ${SIGNALING_PONG_TIMEOUT_MS} ms; closing the socket.`);
    socket.close();
    // On a dead connection the browser can take a long time to fire close, so handle it now;
    // the later close event from this socket is ignored.
    this.handleClose(socket);
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.stopKeepalive();
    for (const listener of this.closeListeners) listener();
  }

  private clearPongTimer(): void {
    if (this.pongTimer !== null) {
      window.clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private stopKeepalive(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimer();
  }
}
