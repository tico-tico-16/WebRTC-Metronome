import type { BeatInfo, MetronomeConfig } from "../src/types.ts";
import { nowSeconds } from "./clockSync.ts";

export function secondsPerBeat(config: MetronomeConfig): number {
  return 60 / config.bpm;
}

export function beatAtHostTime(hostTime: number, startHostTime: number | null, config: MetronomeConfig): BeatInfo {
  const beatLength = secondsPerBeat(config);
  if (startHostTime === null || hostTime < startHostTime) {
    return { beatIndex: 0, beatInBar: 1, secondsPerBeat: beatLength };
  }

  const beatIndex = Math.floor((hostTime - startHostTime) / beatLength);
  return {
    beatIndex,
    beatInBar: (beatIndex % config.beatsPerBar) + 1,
    secondsPerBeat: beatLength,
  };
}

export class MetronomeScheduler {
  private context: AudioContext | null = null;
  private timer: number | null = null;
  private nextBeatIndex = 0;
  private config: MetronomeConfig = { bpm: 120, beatsPerBar: 4, beatUnit: 4 };
  private startHostTime: number | null = null;
  private hostToLocalTime: (hostTime: number) => number = (hostTime) => hostTime;
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
    this.stopTimer();
    this.timer = window.setInterval(() => this.scheduleAhead(), 25);
    this.scheduleAhead();
  }

  setOutputOffsetMs(offsetMs: number): void {
    this.outputOffsetSeconds = offsetMs / 1000;
  }

  stop(): void {
    this.startHostTime = null;
    this.stopTimer();
  }

  private scheduleAhead(): void {
    if (!this.isAudioEnabled() || !this.context || this.startHostTime === null) return;

    const beatLength = secondsPerBeat(this.config);
    const audioNow = this.context.currentTime;
    const localNow = nowSeconds();
    const lookAhead = 0.18;

    while (true) {
      const beatHostTime = this.startHostTime + this.nextBeatIndex * beatLength;
      const beatLocalTime = this.hostToLocalTime(beatHostTime);
      const audioTime = audioNow + (beatLocalTime - localNow) + this.outputOffsetSeconds;

      if (audioTime > audioNow + lookAhead) break;
      if (audioTime >= audioNow - 0.02) {
        this.click(audioTime, this.nextBeatIndex % this.config.beatsPerBar === 0);
      }
      this.nextBeatIndex += 1;
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
