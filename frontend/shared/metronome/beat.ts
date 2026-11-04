import type { BeatInfo, BeatPosition, MetronomeConfig } from "../../../shared/types.ts";

export function secondsPerBeat(config: MetronomeConfig): number {
  return 60 / config.bpm;
}

/** Seconds within which two host times count as the same beat, against floating-point drift. */
export const TIME_EPSILON_SECONDS = 1e-6;

/** The beat number `beats` beats after beat `beatInBar` (1-based; 0 without accents). */
export function beatInBarAfter(beatInBar: number, beats: number, beatsPerBar: number): number {
  return beatsPerBar > 0 ? (((beatInBar - 1 + beats) % beatsPerBar) + beatsPerBar) % beatsPerBar + 1 : 0;
}

export function advanceBeatInBar(beatInBar: number, beatsPerBar: number): number {
  if (beatsPerBar <= 0) return 0;
  const nextBeat = beatInBar + 1;
  return nextBeat > beatsPerBar ? 1 : nextBeat;
}

export function clampBeatInBar(beatInBar: number, beatsPerBar: number): number {
  if (beatsPerBar <= 0) return 0;
  return beatInBar > 0 && beatInBar <= beatsPerBar ? beatInBar : 1;
}

/** The beat at hostTime on a grid that starts at startHostTime on beat startBeatInBar of its bar. */
export function beatAtHostTime(
  hostTime: number,
  startHostTime: number | null,
  config: MetronomeConfig,
  startBeatInBar = 1,
): BeatInfo {
  const beatLength = secondsPerBeat(config);
  if (startHostTime === null || hostTime < startHostTime) {
    return { beatIndex: 0, beatInBar: 1, secondsPerBeat: beatLength };
  }

  const beatIndex = Math.floor((hostTime - startHostTime) / beatLength);
  return {
    beatIndex,
    beatInBar: beatInBarAfter(startBeatInBar, beatIndex, config.beatsPerBar),
    secondsPerBeat: beatLength,
  };
}

/** Position derived from the start time alone, for when no beat has been scheduled yet. */
export function beatPositionAt(
  hostTime: number,
  startHostTime: number | null,
  config: MetronomeConfig,
  startBeatInBar = 1,
): BeatPosition {
  const beat = beatAtHostTime(hostTime, startHostTime, config, startBeatInBar);
  if (startHostTime === null || hostTime < startHostTime) return { ...beat, progress: 0 };
  const elapsedBeats = (hostTime - startHostTime) / beat.secondsPerBeat;
  return { ...beat, progress: elapsedBeats - beat.beatIndex };
}
