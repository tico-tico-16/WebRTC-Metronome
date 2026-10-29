import type { BeatInfo, BeatPosition, ConfigChangeAnchor, MetronomeConfig } from "../../../shared/types.ts";
import { advanceBeatInBar, beatInBarAfter, clampBeatInBar, secondsPerBeat, TIME_EPSILON_SECONDS } from "./beat.ts";
import { queueConfigChange, type ConfigChange } from "./configChange.ts";

const SCHEDULE_INTERVAL_MS = 25;
const LOOK_AHEAD_SECONDS = 0.18;
const LATE_TOLERANCE_SECONDS = 0.02;
const HISTORY_LIMIT = 64;
const MAX_LATENCY_COMPENSATION_SECONDS = 0.5;

/**
 * heardHostTime is when the click is heard: the beat's host time plus the output offset it was reserved with.
 * config is the settings the beat was played with.
 */
type ScheduledBeat = BeatInfo & { hostTime: number; heardHostTime: number; config: MetronomeConfig };

/** A beat not reserved yet, with the settings it will be played with. */
type UpcomingBeat = { hostTime: number; beatInBar: number; config: MetronomeConfig };

/** Where playback starts when that is not a downbeat, and changes already announced for later beats. */
export type StartOptions = { startBeatInBar?: number; changes?: readonly ConfigChange[] };

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
  // Announced changes whose beat has not been reached yet, in beat order.
  private pendingChanges: ConfigChange[] = [];
  // Beats before this host time are done: reserved, skipped as late, or before the start.
  private handledUntilHostTime = 0;
  // From this host time on, the latest settings apply.
  private latestSettingsHostTime = 0;

  constructor(private readonly dependencies: MetronomeDependencies) {}

  start(config: MetronomeConfig, startHostTime: number, hostNow: number, options: StartOptions = {}): void {
    this.config = config;
    this.startHostTime = startHostTime;
    const beatLength = secondsPerBeat(config);
    this.nextBeatIndex = Math.max(0, Math.ceil((hostNow - startHostTime) / beatLength));
    const startBeatInBar = clampBeatInBar(options.startBeatInBar ?? 1, config.beatsPerBar);
    this.nextBeatInBar = beatInBarAfter(startBeatInBar, this.nextBeatIndex, config.beatsPerBar);
    this.nextBeatHostTime = startHostTime + this.nextBeatIndex * beatLength;
    this.handledUntilHostTime = hostNow;
    this.latestSettingsHostTime = startHostTime;
    this.pendingChanges = [];
    this.scheduledBeats = [];
    // Queued before the first reservation, so no beat past a change is reserved with the old settings.
    for (const change of options.changes ?? []) this.updateConfig(change.config, change);
    this.stopTimer();
    this.timer = this.dependencies.timers.setInterval(() => this.scheduleAhead(), SCHEDULE_INTERVAL_MS);
    this.scheduleAhead();
  }

  /**
   * With an anchor, the settings take effect on the beat at anchor.applyAtHostTime, so every device
   * switches on the same beat whatever it has already reserved. Without one, or while stopped, they
   * apply from the next unreserved beat and keep its place in the bar.
   */
  updateConfig(config: MetronomeConfig, anchor?: ConfigChangeAnchor): void {
    if (anchor === undefined || this.nextBeatHostTime === null) {
      this.pendingChanges = [];
      this.config = config;
      this.nextBeatInBar = clampBeatInBar(this.nextBeatInBar, config.beatsPerBar);
      if (this.nextBeatHostTime !== null) this.latestSettingsHostTime = this.nextBeatHostTime;
      return;
    }

    const change: ConfigChange = {
      config,
      applyAtHostTime: anchor.applyAtHostTime,
      beatInBarAtApply: clampBeatInBar(anchor.beatInBarAtApply, config.beatsPerBar),
    };
    this.latestSettingsHostTime = change.applyAtHostTime;
    if (change.applyAtHostTime >= this.nextBeatHostTime - TIME_EPSILON_SECONDS) {
      this.pendingChanges = queueConfigChange(this.pendingChanges, change);
      return;
    }

    // The anchor beat is behind the reservations: the message came late. Clicks already handed to the
    // audio output cannot be recalled, so no further beat of the old grid is reserved and the new grid
    // continues from its first beat not handled yet. Beats already too late are skipped as usual.
    this.pendingChanges = [];
    const beatLength = secondsPerBeat(config);
    const beats = Math.max(0, Math.ceil((this.handledUntilHostTime - change.applyAtHostTime) / beatLength));
    this.config = config;
    this.nextBeatHostTime = change.applyAtHostTime + beats * beatLength;
    this.nextBeatInBar = beatInBarAfter(change.beatInBarAtApply, beats, config.beatsPerBar);
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
    this.pendingChanges = [];
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
    const current = this.beatHeardAt(hostTime);
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

  /**
   * The settings of the click being heard at hostTime, null before the first one. A change shows once
   * it is heard, so the display does not draw the old bar's last beats on the new meter.
   */
  configHeardAt(hostTime: number): MetronomeConfig | null {
    return this.beatHeardAt(hostTime)?.config ?? null;
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

  /**
   * Where a late joiner starts: the first downbeat at or after atHostTime (without accents, the first
   * beat not reserved yet) that is also at or after the latest settings' anchor. Given the latest
   * settings and this time, the joiner plays the same grid, even while a change is still pending.
   */
  nextStrongBeatHostTime(atHostTime: number): number | null {
    if (this.startHostTime === null) return null;
    const fromHostTime = Math.max(atHostTime, this.latestSettingsHostTime - TIME_EPSILON_SECONDS);
    for (const beat of this.scheduledBeats) {
      if (beat.hostTime >= fromHostTime && beat.beatInBar === 1) return beat.hostTime;
    }
    for (const beat of this.upcomingBeats()) {
      if (beat.hostTime >= fromHostTime && (beat.config.beatsPerBar <= 0 || beat.beatInBar === 1)) return beat.hostTime;
    }
    return null;
  }

  /**
   * The beat a change to config should take effect on: the first beat not reserved yet at or after
   * notBeforeHostTime, keeping its place in the bar; for a meter change, the first such downbeat, so
   * the bar in progress ends whole. Null while stopped, as there is no beat to switch on.
   */
  anchorForConfigChange(config: MetronomeConfig, notBeforeHostTime: number): ConfigChangeAnchor | null {
    for (const beat of this.upcomingBeats()) {
      if (beat.hostTime < notBeforeHostTime - TIME_EPSILON_SECONDS) continue;
      const meterChanged = config.beatsPerBar !== beat.config.beatsPerBar || config.beatUnit !== beat.config.beatUnit;
      if (!meterChanged) return { applyAtHostTime: beat.hostTime, beatInBarAtApply: beat.beatInBar };
      if (beat.config.beatsPerBar <= 0 || beat.beatInBar === 1) {
        return { applyAtHostTime: beat.hostTime, beatInBarAtApply: config.beatsPerBar > 0 ? 1 : 0 };
      }
    }
    return null;
  }

  /** The most recently heard click at hostTime; after a large offset cut that need not be the last in beat order. */
  private beatHeardAt(hostTime: number): ScheduledBeat | null {
    let current: ScheduledBeat | null = null;
    for (const beat of this.scheduledBeats) {
      if (beat.heardHostTime <= hostTime && (current === null || beat.heardHostTime >= current.heardHostTime)) {
        current = beat;
      }
    }
    return current;
  }

  /** Beats from the next unreserved one on, switching at each announced change as reserving will. */
  private *upcomingBeats(): Generator<UpcomingBeat, void, undefined> {
    if (this.nextBeatHostTime === null) return;
    let beat: UpcomingBeat = { hostTime: this.nextBeatHostTime, beatInBar: this.nextBeatInBar, config: this.config };
    let changeIndex = 0;
    while (true) {
      const change = this.pendingChanges[changeIndex];
      if (change && beat.hostTime >= change.applyAtHostTime - TIME_EPSILON_SECONDS) {
        beat = { hostTime: change.applyAtHostTime, beatInBar: change.beatInBarAtApply, config: change.config };
        changeIndex += 1;
        continue;
      }
      yield beat;
      beat = {
        hostTime: beat.hostTime + secondsPerBeat(beat.config),
        beatInBar: advanceBeatInBar(beat.beatInBar, beat.config.beatsPerBar),
        config: beat.config,
      };
    }
  }

  /** Switches to each announced change once the next unreserved beat has reached its beat. */
  private applyDueChanges(): void {
    let change = this.pendingChanges[0];
    while (change && this.nextBeatHostTime !== null && this.nextBeatHostTime >= change.applyAtHostTime - TIME_EPSILON_SECONDS) {
      this.config = change.config;
      this.nextBeatHostTime = change.applyAtHostTime;
      this.nextBeatInBar = change.beatInBarAtApply;
      this.pendingChanges.shift();
      change = this.pendingChanges[0];
    }
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
      this.applyDueChanges();
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
          config: this.config,
        });
        if (this.scheduledBeats.length > HISTORY_LIMIT) this.scheduledBeats.shift();
      }
      this.handledUntilHostTime = beatHostTime + TIME_EPSILON_SECONDS;
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
