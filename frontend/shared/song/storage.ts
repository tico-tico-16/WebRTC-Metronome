import { MAX_SAVED_SONGS, normalizeLibrary, type SongLibrary } from "./edit.ts";

export { MAX_SAVED_SONGS, type SongLibrary };

export const SONGS_STORAGE_KEY = "p2p-metronome:songs";
export const CURRENT_SONG_STORAGE_KEY = "p2p-metronome:current-song";

/** The part of the Web Storage API the library uses, so a test can pass a fake. */
export type SongStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Keeps items for as long as the page is open. */
export function memoryStorage(): SongStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, String(value));
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

/**
 * localStorage, or storage in memory when the browser will not open it (blocked site data, some
 * private modes): editing still works and lasts until the page is closed.
 */
export function browserSongStorage(): SongStorage {
  try {
    const storage = window.localStorage;
    if (storage) return storage;
  } catch {
    // Reading the property throws where site data is blocked.
  }
  return memoryStorage();
}

/** The saved songs and the open one, normalized; storage that cannot be read gives the default song. */
export function loadLibrary(storage: SongStorage): SongLibrary {
  let songs: unknown = [];
  let currentId: unknown = "";
  try {
    songs = JSON.parse(storage.getItem(SONGS_STORAGE_KEY) ?? "[]");
    currentId = storage.getItem(CURRENT_SONG_STORAGE_KEY) ?? "";
  } catch {
    // Unreadable or blocked storage: start from the default song.
  }
  return normalizeLibrary(songs, currentId);
}

/**
 * Saves up to MAX_SAVED_SONGS songs and the open one. Returns false when the storage refuses (full,
 * or a private mode that allows no writes); the caller keeps its library in memory either way.
 */
export function saveLibrary(storage: SongStorage, library: SongLibrary): boolean {
  try {
    storage.setItem(SONGS_STORAGE_KEY, JSON.stringify(library.songs.slice(0, MAX_SAVED_SONGS)));
    storage.setItem(CURRENT_SONG_STORAGE_KEY, library.currentId);
    return true;
  } catch {
    return false;
  }
}
