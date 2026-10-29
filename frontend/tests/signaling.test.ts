import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SignalMessage } from "../../shared/types.ts";
import { SignalingClient as HostSignalingClient } from "../host/signaling.ts";
import { SignalingClient as ParticipantSignalingClient } from "../client/signaling.ts";
import { SIGNALING_PING_INTERVAL_MS, SIGNALING_PONG_TIMEOUT_MS, SignalingSocket } from "../shared/signalingSocket.ts";
import { ManualTimers } from "./helpers/browser.ts";

type FakeEvent = { data?: unknown };

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  closeCalls = 0;
  private listeners = new Map<string, ((event: FakeEvent) => void)[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("WebSocket is not open");
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    if (this.readyState < FakeWebSocket.CLOSING) this.readyState = FakeWebSocket.CLOSING;
  }

  // The server and network side of the fake.
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  receive(data: unknown): void {
    this.emit("message", { data });
  }

  /** The browser fires close once the closing handshake ends or the connection is lost. */
  closed(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  get pings(): number {
    return this.sent.filter((data) => data === "ping").length;
  }

  private emit(type: string, event: FakeEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("No WebSocket was created");
  return socket;
}

const hostRegister: SignalMessage = { type: "register", role: "host", name: "Host" };

// Serial because the suite replaces WebSocket, window, location and console.warn.
describe.serial("signaling socket", () => {
  let timers: ManualTimers;
  let warnings: unknown[][];
  let originals: Map<string, PropertyDescriptor | undefined>;
  let originalWarn: typeof console.warn;
  let originalBaseUrl: string | undefined;

  beforeEach(() => {
    timers = new ManualTimers();
    warnings = [];
    FakeWebSocket.instances = [];
    originals = new Map();
    const globals = {
      WebSocket: FakeWebSocket,
      window: timers,
      location: { protocol: "http:", hostname: "192.168.1.20" },
    };
    for (const [key, value] of Object.entries(globals)) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    originalBaseUrl = process.env.VITE_SIGNALING_BASE_URL;
    delete process.env.VITE_SIGNALING_BASE_URL;
  });

  afterEach(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    console.warn = originalWarn;
    if (originalBaseUrl === undefined) delete process.env.VITE_SIGNALING_BASE_URL;
    else process.env.VITE_SIGNALING_BASE_URL = originalBaseUrl;
  });

  function openSocket() {
    const signaling = new SignalingSocket();
    const messages: SignalMessage[] = [];
    let closes = 0;
    signaling.onMessage((message) => messages.push(message));
    signaling.onClose(() => { closes += 1; });
    signaling.connect("ws://signal.test/ws/host", hostRegister);
    const socket = lastSocket();
    socket.open();
    return { signaling, socket, messages, closes: () => closes };
  }

  describe("clients", () => {
    test("the host connects to /ws/host once and registers when the socket opens", () => {
      const signaling = new HostSignalingClient();
      signaling.connect();
      signaling.connect();
      expect(FakeWebSocket.instances.map((socket) => socket.url)).toEqual(["ws://192.168.1.20:3001/ws/host"]);
      expect(lastSocket().sent).toEqual([]);

      lastSocket().open();
      signaling.connect();
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(lastSocket().sent).toEqual([JSON.stringify(hostRegister)]);
    });

    test("a participant connects with the room id and registers with its name", () => {
      const signaling = new ParticipantSignalingClient();
      signaling.connect("Room 1", "Client 7");
      expect(lastSocket().url).toBe("ws://192.168.1.20:3001/ws/client?room=Room%201");

      lastSocket().open();
      expect(lastSocket().sent.map((data) => JSON.parse(data)))
        .toEqual([{ type: "register", role: "client", roomId: "Room 1", name: "Client 7" }]);
    });

    test("uses the configured signaling URL", () => {
      process.env.VITE_SIGNALING_BASE_URL = "wss://signal.example.com/ws/";
      new HostSignalingClient().connect();
      expect(lastSocket().url).toBe("wss://signal.example.com/ws/host");
    });

    test("a participant hears about messages and the close, and can reconnect", () => {
      const signaling = new ParticipantSignalingClient();
      const messages: SignalMessage[] = [];
      let closes = 0;
      signaling.onMessage((message) => messages.push(message));
      signaling.onClose(() => { closes += 1; });
      signaling.connect("room1", "Client 7");
      const socket = lastSocket();
      socket.open();

      socket.receive(JSON.stringify({ type: "host_available", hostPresent: true }));
      expect(messages).toEqual([{ type: "host_available", hostPresent: true }]);
      signaling.send({ type: "answer", to: "host", sdp: { type: "answer", sdp: "v=0" } });
      expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "answer", to: "host", sdp: { type: "answer", sdp: "v=0" } });

      socket.closed();
      expect(closes).toBe(1);
      signaling.send({ type: "ice", to: "host", candidate: {} });
      expect(socket.sent).toHaveLength(2);

      signaling.connect("room1", "Client 7");
      expect(FakeWebSocket.instances).toHaveLength(2);
    });
  });

  describe("messages", () => {
    test("are only sent while the socket is open", () => {
      const signaling = new SignalingSocket();
      signaling.send(hostRegister);
      signaling.connect("ws://signal.test/ws/host", hostRegister);
      signaling.send({ type: "ice", to: "client-1", candidate: {} });
      expect(lastSocket().sent).toEqual([]);
    });

    test("consume pong frames and log frames that are not JSON instead of throwing", () => {
      const { socket, messages } = openSocket();
      socket.receive("pong");
      socket.receive("{not json");
      socket.receive(JSON.stringify({ type: "client_left", clientId: "client-1" }));
      expect(messages).toEqual([{ type: "client_left", clientId: "client-1" }]);
      expect(warnings).toHaveLength(1);
    });
  });

  describe("keepalive", () => {
    test("pings every 30 s only while the socket is open", () => {
      expect(SIGNALING_PING_INTERVAL_MS).toBe(30_000);
      expect(SIGNALING_PONG_TIMEOUT_MS).toBe(10_000);

      const signaling = new SignalingSocket();
      signaling.connect("ws://signal.test/ws/host", hostRegister);
      const socket = lastSocket();
      timers.advanceTo(60_000);
      expect(timers.intervalCount).toBe(0);

      socket.open();
      for (const atMs of [89_999, 90_000, 120_000, 150_000]) {
        timers.advanceTo(atMs);
        socket.receive("pong");
      }
      expect(socket.pings).toBe(3);
      expect(socket.closeCalls).toBe(0);
    });

    test("a pong within 10 s clears the deadline", () => {
      const { socket, closes } = openSocket();
      timers.advanceTo(SIGNALING_PING_INTERVAL_MS);
      expect(socket.pings).toBe(1);
      expect(timers.timeoutCount).toBe(1);

      timers.advanceTo(SIGNALING_PING_INTERVAL_MS + SIGNALING_PONG_TIMEOUT_MS - 1);
      socket.receive("pong");
      expect(timers.timeoutCount).toBe(0);

      timers.advanceTo(2 * SIGNALING_PING_INTERVAL_MS + SIGNALING_PONG_TIMEOUT_MS - 1);
      expect(socket.pings).toBe(2);
      expect(socket.closeCalls).toBe(0);
      expect(closes()).toBe(0);
    });

    test("a missed pong closes the socket and runs the close handling once", () => {
      const { signaling, socket, messages, closes } = openSocket();
      timers.advanceTo(SIGNALING_PING_INTERVAL_MS + SIGNALING_PONG_TIMEOUT_MS - 1);
      expect(socket.closeCalls).toBe(0);

      timers.advanceTo(SIGNALING_PING_INTERVAL_MS + SIGNALING_PONG_TIMEOUT_MS);
      expect(socket.closeCalls).toBe(1);
      expect(closes()).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(timers.intervalCount).toBe(0);
      expect(timers.timeoutCount).toBe(0);

      // A dead connection may report its close much later; nothing from it is handled twice.
      socket.receive(JSON.stringify({ type: "client_left", clientId: "client-1" }));
      socket.closed();
      expect(messages).toEqual([]);
      expect(closes()).toBe(1);

      signaling.connect("ws://signal.test/ws/host", hostRegister);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    test("timers stop when the socket closes, even with a pong pending", () => {
      const { socket, closes } = openSocket();
      timers.advanceTo(SIGNALING_PING_INTERVAL_MS);
      expect(timers.timeoutCount).toBe(1);

      socket.closed();
      expect(closes()).toBe(1);
      expect(timers.intervalCount).toBe(0);
      expect(timers.timeoutCount).toBe(0);

      timers.advanceTo(5 * SIGNALING_PING_INTERVAL_MS);
      expect(socket.pings).toBe(1);
      expect(socket.closeCalls).toBe(0);
    });
  });
});
