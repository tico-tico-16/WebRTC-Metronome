export const MIN_BPM = 30;
export const MAX_BPM = 240;
export const MAX_BEATS_PER_BAR = 16;
export const MAX_OUTPUT_OFFSET_MS = 200;

const DEFAULT_BPM = 120;
const DEFAULT_BEATS_PER_BAR = 4;

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

export function normalizeOutputOffsetMs(value: string): number {
  return clamp(Number(value) || 0, -MAX_OUTPUT_OFFSET_MS, MAX_OUTPUT_OFFSET_MS);
}
