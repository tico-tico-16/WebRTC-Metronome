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
