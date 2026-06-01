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

export class MetronomeScheduler {
  private context: AudioContext | null = null;
  private timer: number | null = null;
  private nextBeatIndex = 0;
  private nextBeatInBar = 1;
  private nextBeatHostTime: number | null = null;
  private config: MetronomeConfig = { bpm: 120, beatsPerBar: 4, beatUnit: 4 };
  private startHostTime: number | null = null;
  private hostToLocalTime: (hostTime: number) => number = (hostTime) => hostTime;
  private scheduledBeats: ScheduledBeat[] = [];
  private audioEnabled = false;
  private outputOffsetSeconds = 0;

  async enableAudio(): Promise<void> {
    this.context ??= new AudioContext();
    await this.context.resume();
    this.audioEnabled = true;
  }

  isAudioEnabled(): boolean {
    return this.audioEnabled && this.context?.state === "running";
  }

  start(config: MetronomeConfig, startHostTime: number, hostNow: number, hostToLocalTime: (hostTime: number) => number): void {
    this.config = config;
    this.startHostTime = startHostTime;
    this.hostToLocalTime = hostToLocalTime;

    const beatLength = secondsPerBeat(config);
    this.nextBeatIndex = Math.max(0, Math.ceil((hostNow - startHostTime) / beatLength));
    this.nextBeatInBar = beatInBarForIndex(this.nextBeatIndex, config.beatsPerBar);
    this.nextBeatHostTime = startHostTime + this.nextBeatIndex * beatLength;
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

  stop(): void {
    this.startHostTime = null;
    this.nextBeatInBar = 1;
    this.nextBeatHostTime = null;
    this.scheduledBeats = [];
    this.stopTimer();
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

  private scheduleAhead(): void {
    if (!this.isAudioEnabled() || !this.context || this.startHostTime === null || this.nextBeatHostTime === null) return;

    const audioNow = this.context.currentTime;
    const localNow = nowSeconds();
    const lookAhead = 0.18;

    while (true) {
      const beatHostTime = this.nextBeatHostTime;
      const beatLocalTime = this.hostToLocalTime(beatHostTime);
      const audioTime = audioNow + (beatLocalTime - localNow) + this.outputOffsetSeconds;

      if (audioTime > audioNow + lookAhead) break;
      if (audioTime >= audioNow - 0.02) {
        this.click(audioTime, this.nextBeatInBar === 1);
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

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
