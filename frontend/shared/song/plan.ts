import type { ConfigChange, MetronomeConfig, PlanSegment, PlaybackPlanMessage } from "../../../shared/types.ts";
import { secondsPerBeat, TIME_EPSILON_SECONDS } from "../metronome/beat.ts";
import { normalizeSections, sectionConfig, sectionFirstBars, type Song } from "./model.ts";

export type { PlanSegment, PlaybackPlanMessage };

export const MAX_COUNT_IN_BARS = 2;

/** startBar is 1-based within the start section; countInBars is 0 to MAX_COUNT_IN_BARS. */
export type PlanOptions = { startSectionIndex: number; startBar: number; countInBars: number; startHostTime: number };

/**
 * A song as the engine plays it: config from startHostTime, then each change at its segment's first
 * beat, until endHostTime. totalBars is the song's bar count, whichever bar playback starts on.
 */
export type PlaybackPlan = PlaybackPlanMessage & { startHostTime: number; config: MetronomeConfig };

/** Where a moment falls in a plan. barInSong is 0 during the count-in, which is not counted. */
export type PlanPosition = {
  kind: PlanSegment["kind"];
  sectionIndex: number;
  name: string;
  barInSegment: number;
  barInSong: number;
  totalBars: number;
};

function wholeInRange(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : min;
}

/**
 * Lays the song out from startHostTime. Each segment ends at fromHostTime + beats * secondsPerBeat,
 * the time the engine computes for that beat counting from the segment's first beat, so its end and
 * the next change fall exactly on the grid every device plays, however long the segment is.
 */
export function buildPlaybackPlan(song: Song, options: PlanOptions): PlaybackPlan {
  const sections = normalizeSections(song.sections);
  const firstBars = sectionFirstBars({ ...song, sections });
  const startIndex = wholeInRange(options.startSectionIndex, 0, sections.length - 1);
  const startSection = sections[startIndex]!;
  const startBar = wholeInRange(options.startBar, 1, startSection.bars);
  const countInBars = wholeInRange(options.countInBars, 0, MAX_COUNT_IN_BARS);

  const segments: PlanSegment[] = [];
  let fromHostTime = options.startHostTime;
  const addSegment = (kind: PlanSegment["kind"], sectionIndex: number, bars: number, firstBarInSong: number): void => {
    const section = sections[sectionIndex]!;
    const config = sectionConfig(section);
    const toHostTime = fromHostTime + bars * config.beatsPerBar * secondsPerBeat(config);
    segments.push({ kind, sectionIndex, name: section.name, config, fromHostTime, toHostTime, bars, firstBarInSong });
    fromHostTime = toHostTime;
  };

  if (countInBars > 0) addSegment("countIn", startIndex, countInBars, 0);
  addSegment("section", startIndex, startSection.bars - startBar + 1, firstBars[startIndex]! + startBar - 1);
  for (let index = startIndex + 1; index < sections.length; index += 1) {
    addSegment("section", index, sections[index]!.bars, firstBars[index]!);
  }

  const changes: ConfigChange[] = segments.slice(1).map((segment) => ({
    config: segment.config,
    applyAtHostTime: segment.fromHostTime,
    beatInBarAtApply: 1,
  }));
  const lastSection = sections.length - 1;
  return {
    startHostTime: options.startHostTime,
    config: segments[0]!.config,
    changes,
    endHostTime: segments.at(-1)!.toHostTime,
    segments,
    totalBars: firstBars[lastSection]! + sections[lastSection]!.bars - 1,
  };
}

/** What start and state_snapshot carry: the start time and first settings are the message's own. */
export function planMessage(plan: PlaybackPlan): PlaybackPlanMessage {
  return { changes: plan.changes, endHostTime: plan.endHostTime, segments: plan.segments, totalBars: plan.totalBars };
}

/** The bars of count-in the plan starts with, 0 without one. Works on a received message too. */
export function planCountInBars(plan: PlaybackPlanMessage): number {
  const first = plan.segments[0];
  return first?.kind === "countIn" ? first.bars : 0;
}

/** The first bar of the song the plan plays, after any count-in: what is shown before the first beat. */
export function planStartPosition(plan: PlaybackPlanMessage): PlanPosition | null {
  const segment = plan.segments.find((candidate) => candidate.kind === "section");
  if (!segment) return null;
  return {
    kind: "section",
    sectionIndex: segment.sectionIndex,
    name: segment.name,
    barInSegment: 1,
    barInSong: segment.firstBarInSong,
    totalBars: plan.totalBars,
  };
}

/**
 * The segment and bar at hostTime, null before the first segment and from the end on. Times within
 * the epsilon of a boundary count as on it, as the engine's beats do. Works on a received message too.
 */
export function planPositionAt(plan: PlaybackPlanMessage, hostTime: number): PlanPosition | null {
  if (hostTime >= plan.endHostTime - TIME_EPSILON_SECONDS) return null;
  const segment = plan.segments.find((candidate) => hostTime < candidate.toHostTime - TIME_EPSILON_SECONDS);
  if (!segment || hostTime < segment.fromHostTime - TIME_EPSILON_SECONDS) return null;
  const barSeconds = segment.config.beatsPerBar * secondsPerBeat(segment.config);
  const elapsedBars = Math.floor((hostTime - segment.fromHostTime + TIME_EPSILON_SECONDS) / barSeconds);
  const barInSegment = Math.max(1, Math.min(segment.bars, elapsedBars + 1));
  return {
    kind: segment.kind,
    sectionIndex: segment.sectionIndex,
    name: segment.name,
    barInSegment,
    barInSong: segment.kind === "countIn" ? 0 : segment.firstBarInSong + barInSegment - 1,
    totalBars: plan.totalBars,
  };
}
