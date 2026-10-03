/** Playback line shown separately from the room/connection status. */
export function playbackStatusText(hostNow: number, startHostTime: number | null, beatInBar: number | null): string {
  if (startHostTime === null) return "Stopped";

  if (hostNow < startHostTime) {
    const seconds = Math.ceil(startHostTime - hostNow);
    return `Starting in ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }

  return beatInBar ? `Playing beat ${beatInBar}` : "Playing";
}

export function connectedPeerCount(peers: Iterable<{ status: string }>): number {
  let count = 0;
  for (const peer of peers) {
    if (peer.status === "connected") count += 1;
  }
  return count;
}
