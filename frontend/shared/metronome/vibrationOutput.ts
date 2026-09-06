const STRONG_DURATION_MS = 60;
const WEAK_DURATION_MS = 25;

export class VibrationOutput {
  private enabled = false;
  private timers: number[] = [];

  setEnabled(enabled: boolean): void {
    this.enabled = enabled && "vibrate" in navigator;
    if (!this.enabled) this.cancel();
  }

  schedule(delayMs: number, accented: boolean): void {
    if (!this.enabled || !("vibrate" in navigator)) return;
    const durationMs = accented ? STRONG_DURATION_MS : WEAK_DURATION_MS;
    const timer = window.setTimeout(() => {
      const index = this.timers.indexOf(timer);
      if (index >= 0) this.timers.splice(index, 1);
      if (this.enabled) navigator.vibrate(durationMs);
    }, Math.max(0, delayMs));
    this.timers.push(timer);
  }

  cancel(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers = [];
    if ("vibrate" in navigator) navigator.vibrate(0);
  }
}
