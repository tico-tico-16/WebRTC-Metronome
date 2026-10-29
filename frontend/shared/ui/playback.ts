export type PlaybackPhase =
  | { kind: "stopped" }
  | { kind: "countdown"; seconds: number }
  | { kind: "playing" };

/** A song plan's end time stops it; without one playback goes on until stopped. */
export function playbackPhase(hostNow: number, startHostTime: number | null, endHostTime: number | null = null): PlaybackPhase {
  if (startHostTime === null) return { kind: "stopped" };
  if (endHostTime !== null && hostNow >= endHostTime) return { kind: "stopped" };
  if (hostNow < startHostTime) return { kind: "countdown", seconds: Math.ceil(startHostTime - hostNow) };
  return { kind: "playing" };
}
