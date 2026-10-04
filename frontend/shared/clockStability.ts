const MIN_STABLE_SAMPLES = 5;
const MAX_STABLE_JITTER_SECONDS = 0.025;

/** Shared by the participant (to start playback) and the host (to label participants). */
export function isClockStable(sampleCount: number, jitter: number | null): boolean {
  return jitter !== null && sampleCount >= MIN_STABLE_SAMPLES && jitter < MAX_STABLE_JITTER_SECONDS;
}
