import {
  createSongId,
  defaultSong,
  MAX_SONG_SECTIONS,
  normalizeSection,
  normalizeSong,
  type Song,
  type SongSection,
} from "./model.ts";

/** The songs saved on this device and the one open in the editor. */
export type SongLibrary = { songs: Song[]; currentId: string };

/** Form values for a section; numbers may come as the strings an input holds. */
export type SectionPatch = Partial<Record<keyof SongSection, unknown>>;

export const MAX_SAVED_SONGS = 50;

const NUMERIC_FIELDS = ["bpm", "beatsPerBar", "beatUnit", "bars"] as const;

/** A number, or a string holding one; an emptied field or text is not a value. */
function hasNumber(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

/** A copy of the last section's tempo, meter and length, so a song often goes on as it was. */
export function addSection(song: Song): Song {
  if (song.sections.length >= MAX_SONG_SECTIONS) return song;
  const last = song.sections.at(-1) ?? normalizeSection({});
  return { ...song, sections: [...song.sections, { ...last, name: "" }] };
}

/** A song always keeps one section. */
export function removeSection(song: Song, index: number): Song {
  if (song.sections.length <= 1 || index < 0 || index >= song.sections.length) return song;
  return { ...song, sections: song.sections.filter((_, candidate) => candidate !== index) };
}

/** Swaps the section with the one before (-1) or after (1) it; nothing happens at either end. */
export function moveSection(song: Song, index: number, direction: -1 | 1): Song {
  const target = index + direction;
  if (index < 0 || index >= song.sections.length || target < 0 || target >= song.sections.length) return song;
  const sections = [...song.sections];
  [sections[index], sections[target]] = [sections[target]!, sections[index]!];
  return { ...song, sections };
}

/**
 * Applies form values to a section and normalizes it. A numeric field that was emptied or holds text
 * keeps its value, so clearing a field by mistake loses nothing.
 */
export function updateSection(song: Song, index: number, patch: SectionPatch): Song {
  const section = song.sections[index];
  if (!section) return song;
  const accepted: SectionPatch = { ...patch };
  for (const key of NUMERIC_FIELDS) {
    if (key in accepted && !hasNumber(accepted[key])) delete accepted[key];
  }
  const sections = [...song.sections];
  sections[index] = normalizeSection({ ...section, ...accepted });
  return { ...song, sections };
}

/** Trimmed and cut to the title limit. An empty title is given an auto title by the caller. */
export function renameSong(song: Song, title: string): Song {
  return normalizeSong({ ...song, title });
}

/** 「曲 N」 with the first N no other song uses as its title; exceptId leaves that song out. */
export function autoTitle(library: Pick<SongLibrary, "songs">, exceptId?: string): string {
  const taken = new Set(library.songs.filter((song) => song.id !== exceptId).map((song) => song.title));
  for (let number = 1; ; number += 1) {
    const title = `曲 ${number}`;
    if (!taken.has(title)) return title;
  }
}

/** The open song. A library from loadLibrary or these helpers always has it. */
export function currentSong(library: SongLibrary): Song {
  return library.songs.find((song) => song.id === library.currentId) ?? library.songs[0] ?? defaultSong();
}

export function selectSong(library: SongLibrary, id: string): SongLibrary {
  return library.songs.some((song) => song.id === id) ? { ...library, currentId: id } : library;
}

/** Puts an edited song in place of the saved song with its id. */
export function replaceSong(library: SongLibrary, song: Song): SongLibrary {
  return { ...library, songs: library.songs.map((saved) => (saved.id === song.id ? song : saved)) };
}

/** Adds the default song with an auto title and opens it, unless the library is full. */
export function newSong(library: SongLibrary): SongLibrary {
  if (library.songs.length >= MAX_SAVED_SONGS) return library;
  const song: Song = { ...defaultSong(), title: autoTitle(library) };
  return { songs: [...library.songs, song], currentId: song.id };
}

/**
 * Removes a song. Deleting the open one opens the song after it, or the one before when it was the
 * last; deleting the only song leaves a new default song, as there is always one to edit.
 */
export function deleteSong(library: SongLibrary, id: string): SongLibrary {
  const index = library.songs.findIndex((song) => song.id === id);
  if (index === -1) return library;
  const songs = library.songs.filter((song) => song.id !== id);
  if (songs.length === 0) return newSong({ songs: [], currentId: "" });
  const currentId = id === library.currentId ? songs[Math.min(index, songs.length - 1)]!.id : library.currentId;
  return { songs, currentId };
}

function isRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Stored data as a library: entries that are not objects are dropped, the rest normalized, up to
 * MAX_SAVED_SONGS. A repeated id gets a new one (ids pick songs), a song without a title an auto
 * title, an empty list the default song, and an unknown open id the first song.
 */
export function normalizeLibrary(songs: unknown, currentId: unknown): SongLibrary {
  const normalized: Song[] = [];
  const ids = new Set<string>();
  for (const entry of Array.isArray(songs) ? songs : []) {
    if (normalized.length >= MAX_SAVED_SONGS) break;
    if (!isRecord(entry)) continue;
    const song = normalizeSong(entry);
    const unique = ids.has(song.id) ? { ...song, id: createSongId() } : song;
    ids.add(unique.id);
    normalized.push(unique);
  }
  normalized.forEach((song, index) => {
    if (song.title === "") normalized[index] = { ...song, title: autoTitle({ songs: normalized }) };
  });
  if (normalized.length === 0) return newSong({ songs: [], currentId: "" });
  const current = normalized.find((song) => song.id === currentId) ?? normalized[0]!;
  return { songs: normalized, currentId: current.id };
}
