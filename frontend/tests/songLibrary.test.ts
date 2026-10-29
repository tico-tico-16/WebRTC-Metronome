import { afterEach, describe, expect, test } from "bun:test";
import {
  addSection,
  autoTitle,
  currentSong,
  deleteSong,
  moveSection,
  newSong,
  removeSection,
  renameSong,
  replaceSong,
  selectSong,
  updateSection,
  type SongLibrary,
} from "../shared/song/edit.ts";
import {
  MAX_SECTION_NAME_LENGTH,
  MAX_SONG_SECTIONS,
  MAX_SONG_TITLE_LENGTH,
  type Song,
  type SongSection,
} from "../shared/song/model.ts";
import {
  browserSongStorage,
  CURRENT_SONG_STORAGE_KEY,
  loadLibrary,
  MAX_SAVED_SONGS,
  memoryStorage,
  saveLibrary,
  SONGS_STORAGE_KEY,
} from "../shared/song/storage.ts";
import { FakeStorage } from "./helpers/browser.ts";

const DEFAULT_SECTION: SongSection = { name: "", bpm: 120, beatsPerBar: 4, beatUnit: 4, bars: 8 };

function section(name: string, bpm: number, beatsPerBar: number, bars: number, beatUnit = 4): SongSection {
  return { name, bpm, beatsPerBar, beatUnit, bars };
}

const SONG: Song = {
  id: "song-1",
  title: "練習曲",
  sections: [section("イントロ", 120, 4, 8), section("Aメロ", 132, 4, 16), section("サビ", 100, 3, 8)],
};

function song(id: string, title: string): Song {
  return { id, title, sections: [{ ...DEFAULT_SECTION }] };
}

function library(titles: string[], currentIndex = 0): SongLibrary {
  const songs = titles.map((title, index) => song(`s${index}`, title));
  return { songs, currentId: songs[currentIndex]!.id };
}

describe("section editing", () => {
  test("adding a section copies the last one's tempo, meter and length, with no name", () => {
    const added = addSection(SONG);
    expect(added.sections).toEqual([...SONG.sections, section("", 100, 3, 8)]);
    expect(added.id).toBe(SONG.id);
    // The song passed in is left as it was.
    expect(SONG.sections).toHaveLength(3);
  });

  test("no section is added past the limit", () => {
    const full = { ...SONG, sections: Array.from({ length: MAX_SONG_SECTIONS }, () => ({ ...DEFAULT_SECTION })) };
    expect(addSection(full)).toBe(full);
  });

  test("removing a section keeps the others in order and never the last one", () => {
    expect(removeSection(SONG, 1).sections).toEqual([SONG.sections[0]!, SONG.sections[2]!]);
    const single = { ...SONG, sections: [SONG.sections[0]!] };
    expect(removeSection(single, 0)).toBe(single);
    expect(removeSection(SONG, 3)).toBe(SONG);
    expect(removeSection(SONG, -1)).toBe(SONG);
  });

  test("moving a section swaps it with its neighbour, and does nothing at either end", () => {
    const [intro, verse, chorus] = SONG.sections as [SongSection, SongSection, SongSection];
    expect(moveSection(SONG, 1, -1).sections).toEqual([verse, intro, chorus]);
    expect(moveSection(SONG, 1, 1).sections).toEqual([intro, chorus, verse]);
    expect(moveSection(SONG, 0, -1)).toBe(SONG);
    expect(moveSection(SONG, 2, 1)).toBe(SONG);
    expect(moveSection(SONG, 5, -1)).toBe(SONG);
  });

  test("updating a section normalizes the values, as read from the form", () => {
    expect(updateSection(SONG, 1, { bpm: "300", beatsPerBar: "6.5", beatUnit: "8", bars: "0" }).sections[1])
      .toEqual(section("Aメロ", 240, 6, 1, 8));
    expect(updateSection(SONG, 0, { name: `  ${"あ".repeat(MAX_SECTION_NAME_LENGTH + 3)} ` }).sections[0]!.name)
      .toBe("あ".repeat(MAX_SECTION_NAME_LENGTH));
    expect(updateSection(SONG, 2, { bpm: 92.5 }).sections[2]).toEqual(section("サビ", 92.5, 3, 8));
    // The other sections and the song passed in are unchanged.
    const updated = updateSection(SONG, 1, { bars: 4 });
    expect(updated.sections[0]).toEqual(SONG.sections[0]);
    expect(SONG.sections[1]!.bars).toBe(16);
  });

  test("an emptied or non-numeric field keeps the value it had", () => {
    expect(updateSection(SONG, 1, { bpm: "", beatsPerBar: " ", bars: "abc" }).sections[1]).toEqual(SONG.sections[1]);
    expect(updateSection(SONG, 1, { bpm: Number.NaN, bars: null }).sections[1]).toEqual(SONG.sections[1]);
    expect(updateSection(SONG, 1, { name: "" }).sections[1]!.name).toBe("");
    expect(updateSection(SONG, 7, { bpm: 90 })).toBe(SONG);
  });

  test("renaming trims the title and cuts it to the limit", () => {
    expect(renameSong(SONG, "  発表会の曲 ")).toEqual({ ...SONG, title: "発表会の曲" });
    expect(renameSong(SONG, "あ".repeat(MAX_SONG_TITLE_LENGTH + 1)).title).toBe("あ".repeat(MAX_SONG_TITLE_LENGTH));
    expect(renameSong(SONG, "   ").title).toBe("");
  });
});

describe("song library editing", () => {
  test("the auto title is 「曲 N」 with the first number no other song uses", () => {
    expect(autoTitle({ songs: [] })).toBe("曲 1");
    expect(autoTitle(library(["曲 1", "曲 3", "練習"]))).toBe("曲 2");
    expect(autoTitle(library(["曲 2", "曲 1"]))).toBe("曲 3");
    // A song's own title does not count when it is the one being named.
    expect(autoTitle(library(["曲 1", "曲 2"]), "s0")).toBe("曲 1");
  });

  test("a new song is the default song with an auto title, added last and opened", () => {
    const before = library(["曲 1", "曲 3"]);
    const after = newSong(before);
    expect(after.songs).toHaveLength(3);
    const created = after.songs[2]!;
    expect(created.title).toBe("曲 2");
    expect(created.sections).toEqual([DEFAULT_SECTION]);
    expect(after.currentId).toBe(created.id);
    expect(before.songs.map((saved) => saved.id)).not.toContain(created.id);
    expect(before.songs).toHaveLength(2);
  });

  test("no song is created past the saved song limit", () => {
    const full = library(Array.from({ length: MAX_SAVED_SONGS }, (_, index) => `曲 ${index + 1}`));
    expect(newSong(full)).toBe(full);
  });

  test("deleting the open song opens the next one, or the one before it when it was last", () => {
    expect(deleteSong(library(["A", "B", "C"], 1), "s1")).toEqual({ songs: [song("s0", "A"), song("s2", "C")], currentId: "s2" });
    expect(deleteSong(library(["A", "B", "C"], 2), "s2")).toEqual({ songs: [song("s0", "A"), song("s1", "B")], currentId: "s1" });
    // Deleting another song keeps the open one.
    expect(deleteSong(library(["A", "B", "C"], 2), "s0").currentId).toBe("s2");
    const unchanged = library(["A"]);
    expect(deleteSong(unchanged, "missing")).toBe(unchanged);
  });

  test("deleting the only song leaves a new default song", () => {
    const after = deleteSong(library(["発表会の曲"]), "s0");
    expect(after.songs).toHaveLength(1);
    expect(after.songs[0]).toMatchObject({ title: "曲 1", sections: [DEFAULT_SECTION] });
    expect(after.songs[0]!.id).not.toBe("s0");
    expect(after.currentId).toBe(after.songs[0]!.id);
  });

  test("selecting and replacing songs by id", () => {
    const before = library(["A", "B"]);
    expect(selectSong(before, "s1").currentId).toBe("s1");
    expect(selectSong(before, "missing")).toBe(before);
    expect(currentSong(before)).toBe(before.songs[0]!);
    const renamed = replaceSong(before, { ...before.songs[1]!, title: "B2" });
    expect(renamed.songs.map((saved) => saved.title)).toEqual(["A", "B2"]);
    expect(renamed.currentId).toBe("s0");
    expect(before.songs[1]!.title).toBe("B");
  });
});

describe("song storage", () => {
  function stored(storage: FakeStorage, songs: unknown, currentId?: string): FakeStorage {
    storage.items.set(SONGS_STORAGE_KEY, typeof songs === "string" ? songs : JSON.stringify(songs));
    if (currentId !== undefined) storage.items.set(CURRENT_SONG_STORAGE_KEY, currentId);
    return storage;
  }

  test("an empty storage opens one default song named 「曲 1」", () => {
    const loaded = loadLibrary(new FakeStorage());
    expect(loaded.songs).toHaveLength(1);
    expect(loaded.songs[0]).toMatchObject({ title: "曲 1", sections: [DEFAULT_SECTION] });
    expect(loaded.currentId).toBe(loaded.songs[0]!.id);
  });

  test("saved songs and the open one load back as saved", () => {
    const storage = new FakeStorage();
    const saved: SongLibrary = { songs: [SONG, song("s2", "基礎練習")], currentId: "s2" };
    expect(saveLibrary(storage, saved)).toBe(true);
    expect(JSON.parse(storage.items.get(SONGS_STORAGE_KEY)!)).toEqual(saved.songs);
    expect(storage.items.get(CURRENT_SONG_STORAGE_KEY)).toBe("s2");
    expect(loadLibrary(storage)).toEqual(saved);
  });

  test("stored songs are normalized, and entries that are not songs are dropped", () => {
    const storage = stored(new FakeStorage(), [
      { id: "a", title: "  A ", sections: [{ name: "x", bpm: 999, beatsPerBar: 0, beatUnit: 5, bars: 0 }] },
      null,
      42,
      "song",
      ["not", "a", "song"],
      { id: "b", title: "B", sections: [] },
    ], "b");
    expect(loadLibrary(storage)).toEqual({
      songs: [
        { id: "a", title: "A", sections: [section("x", 240, 1, 1)] },
        { id: "b", title: "B", sections: [DEFAULT_SECTION] },
      ],
      currentId: "b",
    });
  });

  test("songs without a title get auto titles, and repeated ids new ones", () => {
    const loaded = loadLibrary(stored(new FakeStorage(), [
      { id: "a", title: "", sections: [] },
      { id: "a", title: "曲 1", sections: [] },
      { title: "", sections: [] },
    ]));
    expect(loaded.songs.map((saved) => saved.title)).toEqual(["曲 2", "曲 1", "曲 3"]);
    const ids = loaded.songs.map((saved) => saved.id);
    expect(ids[0]).toBe("a");
    expect(new Set(ids).size).toBe(3);
  });

  test("the open song falls back to the first when the stored id is missing or unknown", () => {
    const songs = [song("a", "A"), song("b", "B")];
    expect(loadLibrary(stored(new FakeStorage(), songs)).currentId).toBe("a");
    expect(loadLibrary(stored(new FakeStorage(), songs, "gone")).currentId).toBe("a");
  });

  test("unreadable data opens the default song", () => {
    for (const data of ["{not json", JSON.stringify({ songs: [] }), "null", JSON.stringify([null, 1])]) {
      const loaded = loadLibrary(stored(new FakeStorage(), data));
      expect(loaded.songs).toHaveLength(1);
      expect(loaded.songs[0]).toMatchObject({ title: "曲 1", sections: [DEFAULT_SECTION] });
    }
  });

  test("at most the saved song limit is loaded and saved", () => {
    const many = Array.from({ length: MAX_SAVED_SONGS + 10 }, (_, index) => song(`s${index}`, `曲 ${index + 1}`));
    const loaded = loadLibrary(stored(new FakeStorage(), many, `s${MAX_SAVED_SONGS + 5}`));
    expect(loaded.songs).toHaveLength(MAX_SAVED_SONGS);
    expect(loaded.songs.at(-1)!.id).toBe(`s${MAX_SAVED_SONGS - 1}`);
    expect(loaded.currentId).toBe("s0");

    const storage = new FakeStorage();
    saveLibrary(storage, { songs: many, currentId: "s0" });
    expect(JSON.parse(storage.items.get(SONGS_STORAGE_KEY)!)).toHaveLength(MAX_SAVED_SONGS);
  });

  test("storage that refuses access gives the default song, and saving reports failure without throwing", () => {
    const blocked = stored(new FakeStorage(), [SONG], SONG.id);
    blocked.failGet = true;
    expect(loadLibrary(blocked).songs[0]).toMatchObject({ title: "曲 1", sections: [DEFAULT_SECTION] });

    const full = new FakeStorage();
    full.failSet = true;
    expect(saveLibrary(full, { songs: [SONG], currentId: SONG.id })).toBe(false);
    expect(full.items.size).toBe(0);
  });

  test("the in-memory storage keeps the library for the page's lifetime", () => {
    const storage = memoryStorage();
    expect(loadLibrary(storage).songs[0]!.title).toBe("曲 1");
    const saved: SongLibrary = { songs: [SONG], currentId: SONG.id };
    expect(saveLibrary(storage, saved)).toBe(true);
    expect(loadLibrary(storage)).toEqual(saved);
  });
});

describe.serial("browser song storage", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });

  function installWindow(window: object): void {
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: window });
  }

  test("uses localStorage when the browser allows it", () => {
    const localStorage = new FakeStorage();
    installWindow({ localStorage });
    expect(browserSongStorage()).toBe(localStorage);
  });

  test("keeps songs in memory when localStorage cannot be opened", () => {
    installWindow({
      get localStorage(): Storage {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    const storage = browserSongStorage();
    const saved: SongLibrary = { songs: [SONG], currentId: SONG.id };
    expect(saveLibrary(storage, saved)).toBe(true);
    expect(loadLibrary(storage)).toEqual(saved);
  });
});
