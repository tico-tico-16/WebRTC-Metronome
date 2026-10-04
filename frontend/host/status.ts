import { isClockStable } from "../shared/clockStability.ts";
import { isConnectionLost, type StatusLabel } from "../shared/ui/labels.ts";

export function connectedPeerCount(peers: Iterable<{ status: string }>): number {
  let count = 0;
  for (const peer of peers) {
    if (peer.status === "connected") count += 1;
  }
  return count;
}

export function peerStatusLabel(peer: { status: string; sampleCount: number; jitter: number | null }): StatusLabel {
  if (isConnectionLost(peer.status)) return { text: "切断", tone: "error" };
  if (peer.status !== "connected") return { text: "接続中", tone: "neutral" };
  return isClockStable(peer.sampleCount, peer.jitter) ? { text: "同期済み", tone: "ok" } : { text: "同期中", tone: "neutral" };
}
