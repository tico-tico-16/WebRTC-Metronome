import type { BeatInfo, BeatPosition, ConfigChangeAnchor, MetronomeConfig } from "../../shared/types.ts";
import { nowSeconds } from "./clockSync.ts";
import { MetronomeEngine, type StartOptions } from "../shared/metronome/engine.ts";
import { ClickOutput } from "../shared/metronome/clickOutput.ts";
import { VibrationOutput } from "../shared/metronome/vibrationOutput.ts";

export { beatAtHostTime, beatPositionAt, secondsPerBeat } from "../shared/metronome/beat.ts";

export class HostMetronomeScheduler {
  private readonly audio = new ClickOutput();
  private readonly engine = new MetronomeEngine({
    now: nowSeconds,
    hostToLocalTime: (time) => time,
    canSchedule: () => this.audio.hasContext(),
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

  /** Resumes audio the browser stopped after it was enabled; mobile browsers usually need a user gesture. */
  resumeAudio(): Promise<void> {
    return this.audio.resume();
  }

  onAudioStateChange(listener: (state: AudioContextState) => void): void {
    this.audio.onStateChange(listener);
  }

  async start(config: MetronomeConfig, startHostTime: number, hostNow: number, options: StartOptions = {}): Promise<void> {
    await this.enableAudio();
    this.engine.start(config, startHostTime, hostNow, options);
  }

  endHostTime(): number | null {
    return this.engine.endHostTime();
  }

  nextStrongBeatHostTime(atHostTime: number): number | null {
    return this.engine.nextStrongBeatHostTime(atHostTime);
  }

  anchorForConfigChange(config: MetronomeConfig, notBeforeHostTime: number): ConfigChangeAnchor | null {
    return this.engine.anchorForConfigChange(config, notBeforeHostTime);
  }

  updateConfig(config: MetronomeConfig, anchor?: ConfigChangeAnchor): void {
    this.engine.updateConfig(config, anchor);
  }

  configHeardAt(hostTime: number): MetronomeConfig | null {
    return this.engine.configHeardAt(hostTime);
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

  beatPositionHeardAt(hostTime: number): BeatPosition | null {
    return this.engine.beatPositionHeardAt(hostTime);
  }

  audibleDelaySeconds(): number {
    return this.engine.audibleDelaySeconds();
  }

  heardHostTimeFor(hostTime: number): number {
    return this.engine.heardHostTimeFor(hostTime);
  }
}
