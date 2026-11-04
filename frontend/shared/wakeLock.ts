/**
 * Keeps the screen on while playing, so a phone nobody touches does not lock and stop the audio.
 * Browsers without the Screen Wake Lock API, or that refuse it, simply keep their normal timeout.
 */
export class ScreenWakeLock {
  private wanted = false;
  private sentinel: WakeLockSentinel | null = null;
  private requesting = false;

  constructor() {
    // Browsers release the lock whenever the page is hidden, so take it again on return.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.request();
    });
  }

  async acquire(): Promise<void> {
    this.wanted = true;
    await this.request();
  }

  async release(): Promise<void> {
    this.wanted = false;
    const sentinel = this.sentinel;
    this.sentinel = null;
    try {
      await sentinel?.release();
    } catch {
      // Already released by the browser.
    }
  }

  private async request(): Promise<void> {
    if (!this.wanted || this.sentinel !== null || this.requesting || !("wakeLock" in navigator)) return;
    this.requesting = true;
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      if (!this.wanted) {
        // Released while the request was pending.
        await sentinel.release();
        return;
      }
      this.sentinel = sentinel;
      sentinel.addEventListener("release", () => {
        if (this.sentinel === sentinel) this.sentinel = null;
      });
    } catch {
      // Refused, for example while the page is hidden or by a battery saver.
    } finally {
      this.requesting = false;
    }
  }
}
