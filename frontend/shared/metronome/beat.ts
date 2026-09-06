import type { BeatInfo, MetronomeConfig } from "../../../shared/types.ts";

export function secondsPerBeat(config: MetronomeConfig): number {
  return 60 / config.bpm;
}

export function beatInBarForIndex(beatIndex: number, beatsPerBar: number): number {
  return beatsPerBar > 0 ? (beatIndex % beatsPerBar) + 1 : 0;
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

export function beatAtHostTime(hostTime: number, startHostTime: number | null, config: MetronomeConfig): BeatInfo {
  const beatLength = secondsPerBeat(config);
  if (startHostTime === null || hostTime < startHostTime) {
    return { beatIndex: 0, beatInBar: 1, secondsPerBeat: beatLength };
  }

  const beatIndex = Math.floor((hostTime - startHostTime) / beatLength);
  return {
    beatIndex,
    beatInBar: config.beatsPerBar > 0 ? (beatIndex % config.beatsPerBar) + 1 : 0,
    secondsPerBeat: beatLength,
  };
}
