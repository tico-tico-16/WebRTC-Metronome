import type { BeatInfo, BeatPosition, MetronomeConfig } from "../../../shared/types.ts";
import { advanceBeatInBar, beatInBarForIndex, clampBeatInBar, secondsPerBeat } from "./beat.ts";

const SCHEDULE_INTERVAL_MS = 25;
const LOOK_AHEAD_SECONDS = 0.18;
const LATE_TOLERANCE_SECONDS = 0.02;
const HISTORY_LIMIT = 64;

type ScheduledBeat = BeatInfo & { hostTime: number };

export type MetronomeDependencies = {
  now: () => number;
  hostToLocalTime: (hostTime: number) => number;
  canSchedule: () => boolean;
  timers: {
    setInterval: (callback: () => void, intervalMs: number) => number;
    clearInterval: (timer: number) => void;
  };
  audio: {
    currentTime: () => number | null;
    click: (time: number, accented: boolean) => void;
    /** Seconds between a scheduled time and the sound leaving the speaker. */
    outputLatency: () => number;
  };
  vibration: {
    setEnabled: (enabled: boolean) => void;
    schedule: (delayMs: number, accented: boolean) => void;
    cancel: () => void;
  };
};

/** Musical state and lookahead scheduling; all clocks and outputs are supplied by the caller. */
export class MetronomeEngine {
  private timer: number | null = null;
  private nextBeatIndex = 0;
  private nextBeatInBar = 1;
  private nextBeatHostTime: number | null = null;
  private config: MetronomeConfig = { bpm: 120, beatsPerBar: 4, beatUnit: 4 };
  private startHostTime: number | null = null;
  private scheduledBeats: ScheduledBeat[] = [];
  private outputOffsetSeconds = 0;

  constructor(private readonly dependencies: MetronomeDependencies) {}

  start(config: MetronomeConfig, startHostTime: number, hostNow: number): void {
    this.config = config;
    this.startHostTime = startHostTime;
    const beatLength = secondsPerBeat(config);
    this.nextBeatIndex = Math.max(0, Math.ceil((hostNow - startHostTime) / beatLength));
    this.nextBeatInBar = beatInBarForIndex(this.nextBeatIndex, config.beatsPerBar);
    this.nextBeatHostTime = startHostTime + this.nextBeatIndex * beatLength;
    this.scheduledBeats = [];
    this.stopTimer();
    this.timer = this.dependencies.timers.setInterval(() => this.scheduleAhead(), SCHEDULE_INTERVAL_MS);
    this.scheduleAhead();
  }

  updateConfig(config: MetronomeConfig): void {
    this.config = config;
    this.nextBeatInBar = clampBeatInBar(this.nextBeatInBar, config.beatsPerBar);
  }

  setOutputOffsetMs(offsetMs: number): void {
    this.outputOffsetSeconds = offsetMs / 1000;
  }

  setVibrationEnabled(enabled: boolean): void {
    this.dependencies.vibration.setEnabled(enabled);
  }

  stop(): void {
    this.startHostTime = null;
    this.nextBeatInBar = 1;
    this.nextBeatHostTime = null;
    this.scheduledBeats = [];
    this.stopTimer();
    this.dependencies.vibration.cancel();
  }

  beatAtHostTime(hostTime: number): BeatInfo | null {
    const current = this.scheduledBeatAt(hostTime);
    if (!current) return null;
    return { beatIndex: current.beatIndex, beatInBar: current.beatInBar, secondsPerBeat: current.secondsPerBeat };
  }

  /** Position within the scheduled beat at hostTime; it stays at 1 past the last scheduled beat. */
  beatPositionAtHostTime(hostTime: number): BeatPosition | null {
    const current = this.scheduledBeatAt(hostTime);
    if (!current) return null;
    const progress = (hostTime - current.hostTime) / current.secondsPerBeat;
    return {
      beatIndex: current.beatIndex,
      beatInBar: current.beatInBar,
      secondsPerBeat: current.secondsPerBeat,
      progress: Math.min(1, Math.max(0, progress)),
    };
  }

  /** How long after a beat's host time its click is heard: output offset plus device output latency. */
  audibleDelaySeconds(): number {
    return this.outputOffsetSeconds + this.dependencies.audio.outputLatency();
  }

  nextStrongBeatHostTime(atHostTime: number): number | null {
    if (this.startHostTime === null) return null;
    if (this.config.beatsPerBar <= 0) return this.nextBeatHostTime;
    for (const beat of this.scheduledBeats) {
      if (beat.hostTime >= atHostTime && beat.beatInBar === 1) return beat.hostTime;
    }
    if (this.nextBeatHostTime === null) return null;
    let beatHostTime = this.nextBeatHostTime;
    let beatInBar = this.nextBeatInBar;
    const beatLength = secondsPerBeat(this.config);
    while (beatHostTime < atHostTime || beatInBar !== 1) {
      beatHostTime += beatLength;
      beatInBar = advanceBeatInBar(beatInBar, this.config.beatsPerBar);
    }
    return beatHostTime;
  }

  private scheduledBeatAt(hostTime: number): ScheduledBeat | null {
    let current: ScheduledBeat | null = null;
    for (const beat of this.scheduledBeats) {
      if (beat.hostTime <= hostTime) current = beat;
    }
    return current;
  }

  private scheduleAhead(): void {
    if (!this.dependencies.canSchedule() || this.startHostTime === null || this.nextBeatHostTime === null) return;
    const audioNow = this.dependencies.audio.currentTime();
    if (audioNow === null) return;
    const localNow = this.dependencies.now();

    while (true) {
      const beatHostTime = this.nextBeatHostTime;
      const beatLocalTime = this.dependencies.hostToLocalTime(beatHostTime);
      const audioTime = audioNow + (beatLocalTime - localNow) + this.outputOffsetSeconds;
      if (audioTime > audioNow + LOOK_AHEAD_SECONDS) break;
      if (audioTime >= audioNow - LATE_TOLERANCE_SECONDS) {
        const accented = this.nextBeatInBar === 1;
        this.dependencies.audio.click(audioTime, accented);
        this.dependencies.vibration.schedule((audioTime - audioNow) * 1000, accented);
        this.scheduledBeats.push({
          hostTime: beatHostTime,
          beatIndex: this.nextBeatIndex,
          beatInBar: this.nextBeatInBar,
          secondsPerBeat: secondsPerBeat(this.config),
        });
        if (this.scheduledBeats.length > HISTORY_LIMIT) this.scheduledBeats.shift();
      }
      this.nextBeatIndex += 1;
      this.nextBeatInBar = advanceBeatInBar(this.nextBeatInBar, this.config.beatsPerBar);
      this.nextBeatHostTime += secondsPerBeat(this.config);
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.dependencies.timers.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
