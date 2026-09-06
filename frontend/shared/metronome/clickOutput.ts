const QUIET_GAIN = 0.0001;
const ATTACK_SECONDS = 0.004;
const DECAY_SECONDS = 0.07;
const DURATION_SECONDS = 0.08;

export class ClickOutput {
  private context: AudioContext | null = null;
  private audioEnabled = false;

  async enable(): Promise<void> {
    this.context ??= new AudioContext();
    await this.context.resume();
    this.audioEnabled = true;
  }

  hasContext(): boolean {
    return this.context !== null;
  }

  isEnabled(): boolean {
    return this.audioEnabled && this.context?.state === "running";
  }

  currentTime(): number | null {
    return this.context?.currentTime ?? null;
  }

  click(time: number, accented: boolean): void {
    if (!this.context) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(accented ? 1000 : 700, time);
    gain.gain.setValueAtTime(QUIET_GAIN, time);
    gain.gain.exponentialRampToValueAtTime(accented ? 0.42 : 0.28, time + ATTACK_SECONDS);
    gain.gain.exponentialRampToValueAtTime(QUIET_GAIN, time + DECAY_SECONDS);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start(time);
    oscillator.stop(time + DURATION_SECONDS);
  }
}
