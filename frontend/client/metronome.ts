import type { BeatInfo, MetronomeConfig } from "../../shared/types.ts";
import { nowSeconds } from "./clockSync.ts";
import { MetronomeEngine } from "../shared/metronome/engine.ts";
import { ClickOutput } from "../shared/metronome/clickOutput.ts";
import { VibrationOutput } from "../shared/metronome/vibrationOutput.ts";

export { beatAtHostTime, secondsPerBeat } from "../shared/metronome/beat.ts";

export class MetronomeScheduler {
  private hostToLocalTime: (hostTime: number) => number = (time) => time;
  private readonly audio = new ClickOutput();
  private readonly engine = new MetronomeEngine({
    now: nowSeconds,
    hostToLocalTime: (time) => this.hostToLocalTime(time),
    canSchedule: () => this.isAudioEnabled(),
    timers: {
      setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
      clearInterval: (timer) => window.clearInterval(timer),
    },
    audio: this.audio,
    vibration: new VibrationOutput(),
  });

  enableAudio(): Promise<void> {
    return this.audio.enable();
  }

  isAudioEnabled(): boolean {
    return this.audio.isEnabled();
  }

  start(config: MetronomeConfig, startHostTime: number, hostNow: number, hostToLocalTime: (hostTime: number) => number): void {
    this.hostToLocalTime = hostToLocalTime;
    this.engine.start(config, startHostTime, hostNow);
  }

  updateConfig(config: MetronomeConfig): void {
    this.engine.updateConfig(config);
  }

  setOutputOffsetMs(offsetMs: number): void {
    this.engine.setOutputOffsetMs(offsetMs);
  }

  setVibrationEnabled(enabled: boolean): void {
    this.engine.setVibrationEnabled(enabled);
  }

  stop(): void {
    this.engine.stop();
  }

  beatAtHostTime(hostTime: number): BeatInfo | null {
    return this.engine.beatAtHostTime(hostTime);
  }
}
