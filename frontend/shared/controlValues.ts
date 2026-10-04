export const MIN_BPM = 30;
export const MAX_BPM = 240;
export const MAX_BEATS_PER_BAR = 16;
export const MAX_OUTPUT_OFFSET_MS = 200;

export const BEAT_UNITS = [2, 4, 8, 16] as const;
/** Common meters offered as one-tap presets; BPM counts the beat unit (the denominator). */
export const METER_PRESETS = [
  { beatsPerBar: 2, beatUnit: 4 },
  { beatsPerBar: 3, beatUnit: 4 },
  { beatsPerBar: 4, beatUnit: 4 },
  { beatsPerBar: 5, beatUnit: 4 },
  { beatsPerBar: 6, beatUnit: 8 },
  { beatsPerBar: 7, beatUnit: 8 },
] as const;

const DEFAULT_BPM = 120;
const DEFAULT_BEATS_PER_BAR = 4;
const DEFAULT_BEAT_UNIT = 4;
const TAP_RESET_MS = 2000;
const TAP_HISTORY = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Empty or non-numeric input yields null; numeric zero is kept so it can be clamped. */
function parseNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeBpm(value: string): number {
  const bpm = parseNumber(value);
  return bpm === null ? DEFAULT_BPM : clamp(bpm, MIN_BPM, MAX_BPM);
}

/** 0 means no accented downbeat. */
export function normalizeBeatsPerBar(value: string): number {
  const beats = Number(value);
  return Number.isFinite(beats) ? clamp(Math.floor(beats), 0, MAX_BEATS_PER_BAR) : DEFAULT_BEATS_PER_BAR;
}

export function normalizeBeatUnit(value: string): number {
  const unit = Number(value);
  return BEAT_UNITS.some((candidate) => candidate === unit) ? unit : DEFAULT_BEAT_UNIT;
}

/** Steps from the nearest whole BPM so the +/- buttons always land on integers. */
export function stepBpm(bpm: number, delta: number): number {
  return clamp(Math.round(bpm) + delta, MIN_BPM, MAX_BPM);
}

/** Adds a tap, starting over after a pause and keeping only the most recent taps. */
export function recordTap(taps: readonly number[], nowMs: number): number[] {
  const last = taps.at(-1);
  const kept = last !== undefined && nowMs - last <= TAP_RESET_MS ? taps : [];
  return [...kept, nowMs].slice(-TAP_HISTORY);
}

/** Average tempo of the recorded taps, or null until there are three. */
export function tapTempoBpm(taps: readonly number[]): number | null {
  if (taps.length < 3) return null;
  const averageIntervalMs = (taps.at(-1)! - taps[0]!) / (taps.length - 1);
  return clamp(Math.round(60000 / averageIntervalMs), MIN_BPM, MAX_BPM);
}

export function normalizeOutputOffsetMs(value: string): number {
  return clamp(Number(value) || 0, -MAX_OUTPUT_OFFSET_MS, MAX_OUTPUT_OFFSET_MS);
}
