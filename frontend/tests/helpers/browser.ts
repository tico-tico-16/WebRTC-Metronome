type Timer = { callback: () => void; dueMs: number; intervalMs: number | null };

/** Advances only when requested; no real timers or wall-clock waits. */
export class ManualTimers {
  nowMs = 0;
  private nextId = 0;
  private pending = new Map<number, Timer>();
  readonly clearedIntervals: number[] = [];
  readonly clearedTimeouts: number[] = [];

  setInterval = (callback: () => void, intervalMs: number): number => {
    const id = ++this.nextId;
    this.pending.set(id, { callback, dueMs: this.nowMs + intervalMs, intervalMs });
    return id;
  };

  clearInterval = (id: number): void => {
    this.clearedIntervals.push(id);
    this.pending.delete(id);
  };

  setTimeout = (callback: () => void, delayMs: number): number => {
    const id = ++this.nextId;
    this.pending.set(id, { callback, dueMs: this.nowMs + delayMs, intervalMs: null });
    return id;
  };

  clearTimeout = (id: number): void => {
    this.clearedTimeouts.push(id);
    this.pending.delete(id);
  };

  get intervalCount(): number {
    return [...this.pending.values()].filter((timer) => timer.intervalMs !== null).length;
  }

  get timeoutCount(): number {
    return [...this.pending.values()].filter((timer) => timer.intervalMs === null).length;
  }

  advanceTo(targetMs: number): void {
    if (targetMs < this.nowMs) throw new Error("Manual clock cannot move backwards");
    let iterations = 0;
    while (true) {
      const next = [...this.pending.entries()]
        .filter(([, timer]) => timer.dueMs <= targetMs)
        .sort((a, b) => a[1].dueMs - b[1].dueMs || a[0] - b[0])[0];
      if (!next) break;
      if (++iterations > 100_000) throw new Error("Timer did not advance");
      const [id, timer] = next;
      this.nowMs = Math.max(this.nowMs, timer.dueMs);
      if (timer.intervalMs === null) this.pending.delete(id);
      else timer.dueMs = this.nowMs + timer.intervalMs;
      timer.callback();
    }
    this.nowMs = targetMs;
  }

  /** Deliver an interval callback late, like a stalled browser event loop. */
  runIntervalsAt(targetMs: number): void {
    if (targetMs < this.nowMs) throw new Error("Manual clock cannot move backwards");
    this.nowMs = targetMs;
    for (const timer of [...this.pending.values()]) {
      if (timer.intervalMs === null) continue;
      timer.dueMs = targetMs + timer.intervalMs;
      timer.callback();
    }
  }
}

export class FakeAudioParam {
  readonly events: { method: "set" | "ramp"; value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number): void {
    this.events.push({ method: "set", value, time });
  }
  exponentialRampToValueAtTime(value: number, time: number): void {
    this.events.push({ method: "ramp", value, time });
  }
}

export class FakeGain {
  readonly gain = new FakeAudioParam();
  destination: unknown;
  connect<T>(destination: T): T {
    this.destination = destination;
    return destination;
  }
}

export class FakeOscillator {
  type = "";
  readonly frequency = new FakeAudioParam();
  readonly starts: number[] = [];
  readonly stops: number[] = [];
  destination: unknown;
  connect<T>(destination: T): T {
    this.destination = destination;
    return destination;
  }
  start(time: number): void { this.starts.push(time); }
  stop(time: number): void { this.stops.push(time); }
}

export class FakeAudioContext {
  state: AudioContextState = "suspended";
  readonly destination = {};
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  outputLatency = 0;
  resumeCount = 0;

  constructor(private browser: FakeBrowser) {}

  get currentTime(): number { return 100 + this.browser.timers.nowMs / 1000; }

  async resume(): Promise<void> {
    this.resumeCount += 1;
    await this.browser.resumeAudio();
    this.state = "running";
  }

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
}

export class FakeBrowser {
  readonly timers = new ManualTimers();
  readonly contexts: FakeAudioContext[] = [];
  readonly vibrations: { durationMs: number; atMs: number }[] = [];
  resumeAudio: () => Promise<void> = () => Promise.resolve();
  private originals = new Map<string, PropertyDescriptor | undefined>();

  get clicks(): { time: number; accented: boolean }[] {
    return this.contexts.flatMap((context) => context.oscillators.flatMap((oscillator) =>
      oscillator.starts.map((time) => ({ time, accented: oscillator.frequency.events[0]?.value === 1000 })),
    ));
  }

  install(vibrationSupported = true): void {
    const browser = this;
    const globals = {
      window: this.timers,
      performance: { timeOrigin: 0, now: () => this.timers.nowMs },
      navigator: vibrationSupported ? {
        vibrate: (durationMs: number) => {
          this.vibrations.push({ durationMs, atMs: this.timers.nowMs });
          return true;
        },
      } : {},
      AudioContext: class extends FakeAudioContext {
        constructor() {
          super(browser);
          browser.contexts.push(this);
        }
      },
    };
    for (const [key, value] of Object.entries(globals)) {
      if (!this.originals.has(key)) this.originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
  }

  restore(): void {
    for (const [key, descriptor] of this.originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    this.originals.clear();
  }
}

export class FakeDataChannel {
  readyState: RTCDataChannelState = "connecting";
  constructor(readonly label: string) {}
  addEventListener(): void {}
}

type PendingDescription = { description: RTCSessionDescriptionInit; resolve: () => void; reject: (error: unknown) => void };

/** setRemoteDescription stays pending until the test settles it, so signals can arrive meanwhile. */
export class FakePeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly addedCandidates: RTCIceCandidateInit[] = [];
  /** Candidates with these `candidate` strings are rejected like malformed ones. */
  readonly invalidCandidates = new Set<string>();
  closed = false;
  private pendingRemote: PendingDescription[] = [];

  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: "offer", sdp: "offer-sdp" }; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: "answer", sdp: "answer-sdp" }; }
  async setLocalDescription(): Promise<void> {}

  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    return new Promise((resolve, reject) => this.pendingRemote.push({ description, resolve, reject }));
  }

  /** Applies the oldest pending remote description. */
  applyRemoteDescription(): void {
    const pending = this.pendingRemote.shift();
    if (!pending) throw new Error("No pending remote description");
    this.remoteDescription = pending.description;
    pending.resolve();
  }

  rejectRemoteDescription(error: unknown = new DOMException("Invalid SDP", "OperationError")): void {
    const pending = this.pendingRemote.shift();
    if (!pending) throw new Error("No pending remote description");
    pending.reject(error);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescription) throw new DOMException("The remote description was null", "InvalidStateError");
    if (this.invalidCandidates.has(candidate.candidate ?? "")) throw new DOMException("Invalid candidate", "OperationError");
    this.addedCandidates.push(candidate);
  }

  createDataChannel(label: string): FakeDataChannel { return new FakeDataChannel(label); }
  addEventListener(): void {}

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }
}

/** Installs a fake RTCPeerConnection global and records every connection created. */
export class FakeRtc {
  readonly connections: FakePeerConnection[] = [];
  private original: PropertyDescriptor | undefined;
  private installed = false;

  install(): void {
    const rtc = this;
    if (!this.installed) this.original = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
    this.installed = true;
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      configurable: true,
      writable: true,
      value: class extends FakePeerConnection {
        constructor() {
          super();
          rtc.connections.push(this);
        }
      },
    });
  }

  restore(): void {
    if (!this.installed) return;
    if (this.original) Object.defineProperty(globalThis, "RTCPeerConnection", this.original);
    else Reflect.deleteProperty(globalThis, "RTCPeerConnection");
    this.installed = false;
  }
}
