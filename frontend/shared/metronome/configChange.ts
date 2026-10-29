import type { ConfigChange, ConfigChangeAnchor, MetronomeConfig } from "../../../shared/types.ts";
import { TIME_EPSILON_SECONDS } from "./beat.ts";

export type { ConfigChange };

/** Sent in a config message when the host is not playing: there is no beat to switch on. */
export const NO_ANCHOR: ConfigChangeAnchor = { applyAtHostTime: 0, beatInBarAtApply: 0 };

/** The anchor a config message carries, or null when it was sent without one (host not playing). */
export function messageAnchor(message: ConfigChangeAnchor): ConfigChangeAnchor | null {
  const { applyAtHostTime, beatInBarAtApply } = message;
  if (!Number.isFinite(applyAtHostTime) || applyAtHostTime <= 0) return null;
  return { applyAtHostTime, beatInBarAtApply };
}

/** Adds a change to those announced before it. It sets the settings from its beat on, so it replaces any change from that beat or later. */
export function queueConfigChange(changes: readonly ConfigChange[], change: ConfigChange): ConfigChange[] {
  return [...changes.filter((queued) => queued.applyAtHostTime < change.applyAtHostTime - TIME_EPSILON_SECONDS), change];
}

/**
 * Playback a participant has been told about but not started yet (audio off or clock not stable):
 * the grid starts at startHostTime on beat startBeatInBar with config, then follows the changes in order.
 */
export type PendingPlayback = {
  config: MetronomeConfig;
  startHostTime: number;
  startBeatInBar: number;
  changes: ConfigChange[];
};

/** From a start or state_snapshot message, whose start time is a downbeat. */
export function pendingFromStart(config: MetronomeConfig, startHostTime: number): PendingPlayback {
  return { config, startHostTime, startBeatInBar: 1, changes: [] };
}

/**
 * Adds a config message received before playback started. A change anchored at or before the start
 * replaces the start, so playback begins on its grid. Without an anchor the settings apply from the
 * start, as they did before changes were anchored.
 */
export function withConfigChange(
  pending: PendingPlayback,
  config: MetronomeConfig,
  anchor: ConfigChangeAnchor | null,
): PendingPlayback {
  if (anchor === null) return { ...pending, config, changes: [] };
  if (anchor.applyAtHostTime <= pending.startHostTime + TIME_EPSILON_SECONDS) {
    return { config, startHostTime: anchor.applyAtHostTime, startBeatInBar: anchor.beatInBarAtApply, changes: [] };
  }
  return { ...pending, changes: queueConfigChange(pending.changes, { config, ...anchor }) };
}

/**
 * The same playback as seen at hostTime: the last change whose beat has come becomes the start, and
 * only later changes remain. Starting the engine from this at hostTime lands on the announced grid
 * however long ago a change took effect, without replaying the beats in between.
 */
export function pendingPlaybackAt(pending: PendingPlayback, hostTime: number): PendingPlayback {
  let current: PendingPlayback = { ...pending, changes: [] };
  for (const change of pending.changes) {
    if (change.applyAtHostTime <= hostTime) {
      current = { config: change.config, startHostTime: change.applyAtHostTime, startBeatInBar: change.beatInBarAtApply, changes: [] };
    } else {
      current.changes.push(change);
    }
  }
  return current;
}
