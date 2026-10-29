import type { BeatInfo, BeatPosition, MetronomeConfig } from "../../../shared/types.ts";
import { advanceBeatInBar, beatInBarForIndex, clampBeatInBar, secondsPerBeat } from "./beat.ts";

const SCHEDULE_INTERVAL_MS = 25;
const LOOK_AHEAD_SECONDS = 0.18;
const LATE_TOLERANCE_SECONDS = 0.02;
const HISTORY_LIMIT = 64;
const MAX_LATENCY_COMPENSATION_SECONDS = 0.5;

/** heardHostTime is when the click is heard: the beat's host time plus the output offset it was reserved with. */
type ScheduledBeat = BeatInfo & { hostTime: number; heardHostTime: number };

/**
 * Output latency to reserve a click ahead by. The value comes straight from the browser, so a
 * non-numeric, negative or implausibly large reading must not throw clicks far off the beat;
 * 0.5s still covers slow Bluetooth output.
 */
function compensatedLatency(reportedSeconds: number): number {
  if (!Number.isFinite(reportedSeconds)) return 0;
  return Math.min(MAX_LATENCY_COMPENSATION_SECONDS, Math.max(0, reportedSeconds));
}

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
    /** Seconds between a scheduled time and the sound leaving the speaker; clicks are reserved this much earlier. */
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

  /**
   * Position within the beat being heard at hostTime. Each beat keeps the output offset it was reserved with,
   * so changing the output offset does not shift clicks already handed to the audio output.
   * Progress runs from this click to the next one heard, so the dot reaches each vertex as its click
   * sounds even when an offset change has stretched or squeezed the gap. Past the last scheduled
   * beat it uses the beat length and stays at 1.
   */
  beatPositionHeardAt(hostTime: number): BeatPosition | null {
    // A large offset cut can make a later beat heard before an earlier reserved one,
    // so pick the most recently heard click rather than the last one in beat order.
    let current: ScheduledBeat | null = null;
    for (const beat of this.scheduledBeats) {
      if (beat.heardHostTime <= hostTime && (current === null || beat.heardHostTime >= current.heardHostTime)) {
        current = beat;
      }
    }
    if (!current) return null;
    let nextHeardHostTime: number | null = null;
    for (const beat of this.scheduledBeats) {
      if (beat.heardHostTime > current.heardHostTime && (nextHeardHostTime === null || beat.heardHostTime < nextHeardHostTime)) {
        nextHeardHostTime = beat.heardHostTime;
      }
    }
    const length = nextHeardHostTime === null ? current.secondsPerBeat : nextHeardHostTime - current.heardHostTime;
    const progress = (hostTime - current.heardHostTime) / length;
    return {
      beatIndex: current.beatIndex,
      beatInBar: current.beatInBar,
      secondsPerBeat: current.secondsPerBeat,
      progress: Math.min(1, Math.max(0, progress)),
    };
  }

  /** When the click for hostTime is heard: as reserved if it already is, otherwise with the current offset. */
  heardHostTimeFor(hostTime: number): number {
    const reserved = this.scheduledBeats.find((beat) => Math.abs(beat.hostTime - hostTime) < 1e-6);
    return reserved ? reserved.heardHostTime : hostTime + this.audibleDelaySeconds();
  }

  /**
   * How long after a beat's host time its click is heard: the manual output offset only.
   * The device output latency is not part of it because each click is reserved that much earlier.
   */
  audibleDelaySeconds(): number {
    return this.outputOffsetSeconds;
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
    const latency = compensatedLatency(this.dependencies.audio.outputLatency());

    while (true) {
      const beatHostTime = this.nextBeatHostTime;
      const beatLocalTime = this.dependencies.hostToLocalTime(beatHostTime);
      // When the click should be heard, and the earlier time it must be handed to the audio output.
      const heardAudioTime = audioNow + (beatLocalTime - localNow) + this.outputOffsetSeconds;
      const audioTime = heardAudioTime - latency;
      if (audioTime > audioNow + LOOK_AHEAD_SECONDS) break;
      if (audioTime >= audioNow - LATE_TOLERANCE_SECONDS) {
        const accented = this.nextBeatInBar === 1;
        this.dependencies.audio.click(audioTime, accented);
        // Vibration does not go through the audio output, so it fires when the click is heard.
        this.dependencies.vibration.schedule((heardAudioTime - audioNow) * 1000, accented);
        this.scheduledBeats.push({
          hostTime: beatHostTime,
          heardHostTime: beatHostTime + this.audibleDelaySeconds(),
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
