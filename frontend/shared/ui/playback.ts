export type PlaybackPhase =
  | { kind: "stopped" }
  | { kind: "countdown"; seconds: number }
  | { kind: "playing" };

export function playbackPhase(hostNow: number, startHostTime: number | null): PlaybackPhase {
  if (startHostTime === null) return { kind: "stopped" };
  if (hostNow < startHostTime) return { kind: "countdown", seconds: Math.ceil(startHostTime - hostNow) };
  return { kind: "playing" };
}
