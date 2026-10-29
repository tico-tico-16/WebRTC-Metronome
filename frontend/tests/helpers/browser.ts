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

/**
 * Setting `state` fires "statechange" (listeners and onstatechange), as the browser does when it
 * suspends or interrupts a context. Like a real context, the audio clock stands still while a
 * context that has run is not running; before it first runs it follows the manual clock.
 */
export class FakeAudioContext extends EventTarget {
  readonly destination = {};
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  outputLatency = 0;
  resumeCount = 0;
  onstatechange: ((event: Event) => void) | null = null;
  private currentState: AudioContextState = "suspended";
  private stoppedAtMs: number | null = null;
  private stoppedSeconds = 0;

  constructor(private browser: FakeBrowser) {
    super();
  }

  get state(): AudioContextState { return this.currentState; }

  set state(next: AudioContextState) {
    if (next === this.currentState) return;
    const nowMs = this.browser.timers.nowMs;
    if (this.currentState === "running") {
      this.stoppedAtMs = nowMs;
    } else if (next === "running" && this.stoppedAtMs !== null) {
      this.stoppedSeconds += (nowMs - this.stoppedAtMs) / 1000;
      this.stoppedAtMs = null;
    }
    this.currentState = next;
    const event = new Event("statechange");
    this.dispatchEvent(event);
    this.onstatechange?.(event);
  }

  get currentTime(): number {
    return 100 + (this.stoppedAtMs ?? this.browser.timers.nowMs) / 1000 - this.stoppedSeconds;
  }

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

export class FakeWakeLockSentinel extends EventTarget {
  released = false;
  readonly type = "screen";

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  }
}

export class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

export class FakeBrowser {
  readonly timers = new ManualTimers();
  readonly contexts: FakeAudioContext[] = [];
  readonly vibrations: { durationMs: number; atMs: number }[] = [];
  readonly document = new FakeDocument();
  readonly wakeLocks: FakeWakeLockSentinel[] = [];
  wakeLockRequests = 0;
  resumeAudio: () => Promise<void> = () => Promise.resolve();
  /** Runs before each wake lock is granted; reject to deny it. */
  grantWakeLock: () => Promise<void> = () => Promise.resolve();
  private originals = new Map<string, PropertyDescriptor | undefined>();

  get clicks(): { time: number; accented: boolean }[] {
    return this.contexts.flatMap((context) => context.oscillators.flatMap((oscillator) =>
      oscillator.starts.map((time) => ({ time, accented: oscillator.frequency.events[0]?.value === 1000 })),
    ));
  }

  get activeWakeLocks(): FakeWakeLockSentinel[] {
    return this.wakeLocks.filter((sentinel) => !sentinel.released);
  }

  /** Browsers release screen wake locks when the page is hidden, then report the change. */
  setVisibility(state: DocumentVisibilityState): void {
    this.document.visibilityState = state;
    if (state === "hidden") for (const sentinel of this.wakeLocks) void sentinel.release();
    this.document.dispatchEvent(new Event("visibilitychange"));
  }

  install(vibrationSupported = true, wakeLockSupported = true): void {
    const browser = this;
    const navigator: Record<string, unknown> = {};
    if (vibrationSupported) {
      navigator.vibrate = (durationMs: number) => {
        this.vibrations.push({ durationMs, atMs: this.timers.nowMs });
        return true;
      };
    }
    if (wakeLockSupported) {
      navigator.wakeLock = {
        request: async (type: WakeLockType) => {
          this.wakeLockRequests += 1;
          if (type !== "screen" || this.document.visibilityState !== "visible") throw new Error("NotAllowedError");
          await this.grantWakeLock();
          const sentinel = new FakeWakeLockSentinel();
          this.wakeLocks.push(sentinel);
          return sentinel;
        },
      };
    }
    const globals = {
      window: this.timers,
      performance: { timeOrigin: 0, now: () => this.timers.nowMs },
      document: this.document,
      navigator,
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
