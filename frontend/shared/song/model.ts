import type { MetronomeConfig } from "../../../shared/types.ts";
import { MAX_BEATS_PER_BAR, normalizeBeatUnit, normalizeBpm } from "../controlValues.ts";

/** A stretch of a song at one tempo and meter. BPM counts the beat unit, as everywhere in this app. */
export type SongSection = { name: string; bpm: number; beatsPerBar: number; beatUnit: number; bars: number };

export type Song = { id: string; title: string; sections: SongSection[] };

export const MAX_SONG_SECTIONS = 64;
export const MIN_SECTION_BARS = 1;
export const MAX_SECTION_BARS = 999;
/** A song needs whole bars, so its meters always have beats (no "0, no accent"). */
export const MIN_SECTION_BEATS_PER_BAR = 1;
/** Names travel to every participant in the playback plan, so they are kept short. */
export const MAX_SECTION_NAME_LENGTH = 40;
export const MAX_SONG_TITLE_LENGTH = 80;

const DEFAULT_SECTION: SongSection = { name: "", bpm: 120, beatsPerBar: 4, beatUnit: 4, bars: 8 };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** A finite number, or a string holding one; anything else (empty, NaN, objects) is missing. */
function numericField(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Trimmed, and cut by characters rather than UTF-16 units so a name never ends in half a character. */
function textField(value: unknown, maxLength: number): string {
  return typeof value === "string" ? [...value.trim()].slice(0, maxLength).join("") : "";
}

function wholeField(value: unknown, min: number, max: number, fallback: number): number {
  const number = numericField(value);
  return number === null ? fallback : clamp(Math.floor(number), min, max);
}

function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;
}

/** Not cryptographically random: crypto.randomUUID needs a secure context, and LAN hosts use plain HTTP. */
export function createSongId(): string {
  return `song-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Any input (a form, stored JSON) as a section the metronome can play, with defaults for what is missing. */
export function normalizeSection(input: unknown): SongSection {
  const bpm = numericField(field(input, "bpm"));
  const beatUnit = numericField(field(input, "beatUnit"));
  return {
    name: textField(field(input, "name"), MAX_SECTION_NAME_LENGTH),
    bpm: normalizeBpm(bpm === null ? "" : String(bpm)),
    beatsPerBar: wholeField(field(input, "beatsPerBar"), MIN_SECTION_BEATS_PER_BAR, MAX_BEATS_PER_BAR, DEFAULT_SECTION.beatsPerBar),
    beatUnit: normalizeBeatUnit(beatUnit === null ? "" : String(beatUnit)),
    bars: wholeField(field(input, "bars"), MIN_SECTION_BARS, MAX_SECTION_BARS, DEFAULT_SECTION.bars),
  };
}

/** Up to MAX_SONG_SECTIONS sections, and never none: an empty list becomes one default section. */
export function normalizeSections(input: unknown): SongSection[] {
  const sections = Array.isArray(input) ? input.slice(0, MAX_SONG_SECTIONS).map(normalizeSection) : [];
  return sections.length > 0 ? sections : [{ ...DEFAULT_SECTION }];
}

/** Any input as a playable song; a song without an id gets a new one. */
export function normalizeSong(input: unknown): Song {
  const id = textField(field(input, "id"), Number.POSITIVE_INFINITY);
  return {
    id: id === "" ? createSongId() : id,
    title: textField(field(input, "title"), MAX_SONG_TITLE_LENGTH),
    sections: normalizeSections(field(input, "sections")),
  };
}

export function defaultSong(id = createSongId()): Song {
  return { id, title: "", sections: [{ ...DEFAULT_SECTION }] };
}

export function sectionConfig(section: SongSection): MetronomeConfig {
  return { bpm: section.bpm, beatsPerBar: section.beatsPerBar, beatUnit: section.beatUnit };
}

export function sectionSeconds(section: SongSection): number {
  return (section.bars * section.beatsPerBar * 60) / section.bpm;
}

export function songTotals(song: Song): { bars: number; seconds: number } {
  let bars = 0;
  let seconds = 0;
  for (const section of song.sections) {
    bars += section.bars;
    seconds += sectionSeconds(section);
  }
  return { bars, seconds };
}

/** The song's bar number (1-based) of each section's first bar. */
export function sectionFirstBars(song: Song): number[] {
  let next = 1;
  return song.sections.map((section) => {
    const first = next;
    next += section.bars;
    return first;
  });
}
