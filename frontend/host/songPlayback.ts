import type { ControlMessage, MetronomeConfig } from "../../shared/types.ts";
import { planMessage, type PlaybackPlan } from "../shared/song/plan.ts";
import type { HostPlaybackState } from "./webrtc.ts";

type StartMessage = Extract<ControlMessage, { type: "start" }>;

/** A song's start: the plan's start time and first settings, and the plan for what follows. */
export function songStartMessage(plan: PlaybackPlan, sentHostTime: number): StartMessage {
  return { type: "start", ...plan.config, startHostTime: plan.startHostTime, sentHostTime, plan: planMessage(plan) };
}

/**
 * What a participant joining now is sent. A song goes with its plan from its original start, since the
 * participant rebuilds the whole grid from it. The plain metronome sends a downbeat from which the
 * applied settings hold, after any change still pending, so one grid follows.
 */
export function hostPlaybackState(
  state: { isPlaying: boolean; appliedConfig: MetronomeConfig; startHostTime: number | null; activePlan: PlaybackPlan | null },
  scheduler: { nextStrongBeatHostTime(atHostTime: number): number | null },
  hostNow: number,
): HostPlaybackState {
  const { isPlaying, activePlan } = state;
  if (isPlaying && activePlan !== null) {
    return {
      isPlaying,
      config: activePlan.config,
      startHostTime: activePlan.startHostTime,
      sentHostTime: hostNow,
      plan: planMessage(activePlan),
    };
  }
  return {
    isPlaying,
    config: state.appliedConfig,
    startHostTime: isPlaying ? scheduler.nextStrongBeatHostTime(hostNow) ?? state.startHostTime : state.startHostTime,
    sentHostTime: hostNow,
  };
}
