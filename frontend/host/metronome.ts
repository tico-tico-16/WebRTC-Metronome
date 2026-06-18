import type { BeatInfo, MetronomeConfig } from "../../shared/types.ts";
import { nowSeconds } from "./clockSync.ts";

type ScheduledBeat = {
  hostTime: number;
  beatIndex: number;
  beatInBar: number;
  secondsPerBeat: number;
};

export function secondsPerBeat(config: MetronomeConfig): number {
  return 60 / config.bpm;
}

function beatInBarForIndex(beatIndex: number, beatsPerBar: number): number {
  return beatsPerBar > 0 ? (beatIndex % beatsPerBar) + 1 : 0;
}

function advanceBeatInBar(beatInBar: number, beatsPerBar: number): number {
  if (beatsPerBar <= 0) return 0;
  const nextBeat = beatInBar + 1;
  return nextBeat > beatsPerBar ? 1 : nextBeat;
}

function clampBeatInBar(beatInBar: number, beatsPerBar: number): number {
  if (beatsPerBar <= 0) return 0;
  return beatInBar > 0 && beatInBar <= beatsPerBar ? beatInBar : 1;
}

export function beatAtHostTime(hostTime: number, startHostTime: number | null, config: MetronomeConfig): BeatInfo {
  const beatLength = secondsPerBeat(config);
  if (startHostTime === null || hostTime < startHostTime) {
    return { beatIndex: 0, beatInBar: 1, secondsPerBeat: beatLength };
  }

  const beatIndex = Math.floor((hostTime - startHostTime) / beatLength);
  return {
    beatIndex,
    beatInBar: config.beatsPerBar > 0 ? (beatIndex % config.beatsPerBar) + 1 : 0,
    secondsPerBeat: beatLength,
  };
}

export class HostMetronomeScheduler {
  private context: AudioContext | null = null;
  private timer: number | null = null;
  private nextBeatIndex = 0;
  private nextBeatInBar = 1;
  private nextBeatHostTime: number | null = null;
  private config: MetronomeConfig = { bpm: 120, beatsPerBar: 4, beatUnit: 4 };
  private startHostTime: number | null = null;
  private scheduledBeats: ScheduledBeat[] = [];
  private outputOffsetSeconds = 0;
  private vibrationEnabled = false;
  private vibrationTimers: number[] = [];

  async enableAudio(): Promise<void> {
    this.context ??= new AudioContext();
    await this.context.resume();
  }

  async start(config: MetronomeConfig, startHostTime: number, hostNow: number): Promise<void> {
    await this.enableAudio();
    this.config = config;
    this.startHostTime = startHostTime;
    this.nextBeatIndex = Math.max(0, Math.ceil((hostNow - startHostTime) / secondsPerBeat(config)));
    this.nextBeatInBar = beatInBarForIndex(this.nextBeatIndex, config.beatsPerBar);
    this.nextBeatHostTime = startHostTime + this.nextBeatIndex * secondsPerBeat(config);
    this.scheduledBeats = [];
    this.stopTimer();
    this.timer = window.setInterval(() => this.scheduleAhead(), 25);
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
    this.vibrationEnabled = enabled && "vibrate" in navigator;
    if (!this.vibrationEnabled) this.cancelVibrations();
  }

  stop(): void {
    this.startHostTime = null;
    this.nextBeatInBar = 1;
    this.nextBeatHostTime = null;
    this.scheduledBeats = [];
    this.stopTimer();
    this.cancelVibrations();
  }

  beatAtHostTime(hostTime: number): BeatInfo | null {
    let current: ScheduledBeat | null = null;
    for (const beat of this.scheduledBeats) {
      if (beat.hostTime <= hostTime) current = beat;
    }

    if (!current) return null;

    return {
      beatIndex: current.beatIndex,
      beatInBar: current.beatInBar,
      secondsPerBeat: current.secondsPerBeat,
    };
  }

  nextStrongBeatHostTime(atHostTime: number): number | null {
    if (this.startHostTime === null) return null;

    if (this.config.beatsPerBar <= 0) {
      return this.nextBeatHostTime;
    }

    for (const beat of this.scheduledBeats) {
      if (beat.hostTime >= atHostTime && beat.beatInBar === 1) {
        return beat.hostTime;
      }
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

  private scheduleAhead(): void {
    if (!this.context || this.startHostTime === null || this.nextBeatHostTime === null) return;

    const audioNow = this.context.currentTime;
    const hostNow = nowSeconds();

    while (true) {
      const beatHostTime = this.nextBeatHostTime;
      const audioTime = audioNow + (beatHostTime - hostNow) + this.outputOffsetSeconds;
      if (audioTime > audioNow + 0.18) break;
      if (audioTime >= audioNow - 0.02) {
        const accented = this.nextBeatInBar === 1;
        this.click(audioTime, accented);
        this.scheduleVibration((audioTime - audioNow) * 1000, accented);
        this.scheduledBeats.push({
          hostTime: beatHostTime,
          beatIndex: this.nextBeatIndex,
          beatInBar: this.nextBeatInBar,
          secondsPerBeat: secondsPerBeat(this.config),
        });
        if (this.scheduledBeats.length > 64) this.scheduledBeats.shift();
      }
      this.nextBeatIndex += 1;
      this.nextBeatInBar = advanceBeatInBar(this.nextBeatInBar, this.config.beatsPerBar);
      this.nextBeatHostTime += secondsPerBeat(this.config);
    }
  }

  private click(time: number, accented: boolean): void {
    if (!this.context) return;

    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(accented ? 1000 : 700, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(accented ? 0.42 : 0.28, time + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.07);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start(time);
    oscillator.stop(time + 0.08);
  }

  private scheduleVibration(delayMs: number, accented: boolean): void {
    if (!this.vibrationEnabled || !("vibrate" in navigator)) return;

    const durationMs = accented ? 60 : 25;
    const timer = window.setTimeout(() => {
      const index = this.vibrationTimers.indexOf(timer);
      if (index >= 0) this.vibrationTimers.splice(index, 1);
      if (this.vibrationEnabled) navigator.vibrate(durationMs);
    }, Math.max(0, delayMs));
    this.vibrationTimers.push(timer);
  }

  private cancelVibrations(): void {
    for (const timer of this.vibrationTimers) {
      window.clearTimeout(timer);
    }
    this.vibrationTimers = [];
    if ("vibrate" in navigator) navigator.vibrate(0);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
