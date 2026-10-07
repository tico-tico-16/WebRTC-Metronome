import { isClockStable } from "../shared/clockStability.ts";
import { isConnectionLost, type StatusLabel, type StatusTone } from "../shared/ui/labels.ts";

type PeerState = { status: string; sampleCount: number; jitter: number | null };

export function connectedPeerCount(peers: Iterable<{ status: string }>): number {
  let count = 0;
  for (const peer of peers) {
    if (peer.status === "connected") count += 1;
  }
  return count;
}

export function peerStatusLabel(peer: PeerState): StatusLabel {
  if (isConnectionLost(peer.status)) return { text: "切断", tone: "error" };
  if (peer.status !== "connected") return { text: "接続中", tone: "neutral" };
  return isClockStable(peer.sampleCount, peer.jitter) ? { text: "同期済み", tone: "ok" } : { text: "同期中", tone: "neutral" };
}

/** For the header button: connected participants and the most urgent state among all of them. */
export function participantSummary(peers: Iterable<PeerState>): { count: number; tone: StatusTone } {
  const list = [...peers];
  const tones = list.map((peer) => peerStatusLabel(peer).tone);
  const tone: StatusTone = list.length === 0
    ? "neutral"
    : tones.includes("error")
      ? "error"
      : tones.includes("neutral") ? "warn" : "ok";
  return { count: connectedPeerCount(list), tone };
}
