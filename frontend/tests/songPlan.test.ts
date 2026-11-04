import { describe, expect, test } from "bun:test";
import type { MetronomeConfig } from "../../shared/types.ts";
import {
  defaultSong,
  MAX_SECTION_BARS,
  MAX_SECTION_NAME_LENGTH,
  MAX_SONG_SECTIONS,
  normalizeSection,
  normalizeSong,
  sectionConfig,
  sectionFirstBars,
  sectionSeconds,
  songTotals,
  type Song,
  type SongSection,
} from "../shared/song/model.ts";
import { buildPlaybackPlan, planCountInBars, planMessage, planPositionAt, planStartPosition } from "../shared/song/plan.ts";

const DEFAULT_SECTION: SongSection = { name: "", bpm: 120, beatsPerBar: 4, beatUnit: 4, bars: 8 };

function section(name: string, bpm: number, beatsPerBar: number, bars: number, beatUnit = 4): SongSection {
  return { name, bpm, beatsPerBar, beatUnit, bars };
}

/** 120 4/4 x8, 132 4/4 x8, 100 3/4 x8. */
const SONG: Song = {
  id: "song-1",
  title: "練習曲",
  sections: [section("イントロ", 120, 4, 8), section("Aメロ", 132, 4, 8), section("サビ", 100, 3, 8)],
};
const [INTRO, VERSE, CHORUS] = SONG.sections.map(sectionConfig) as [MetronomeConfig, MetronomeConfig, MetronomeConfig];

// Section lengths in seconds: 32 beats of 0.5s, 32 of 60/132s, 24 of 0.6s.
const VERSE_START = 10 + 16;
const CHORUS_START = VERSE_START + 32 * (60 / 132);
const SONG_END = CHORUS_START + 24 * 0.6;

describe("song model", () => {
  test("the default song is one 120 BPM 4/4 section of 8 bars", () => {
    const song = defaultSong();
    expect(song.id).not.toBe("");
    expect(song.title).toBe("");
    expect(song.sections).toEqual([DEFAULT_SECTION]);
    expect(defaultSong().id).not.toBe(song.id);
    expect(defaultSong("fixed").id).toBe("fixed");
  });

  test("a section is clamped to the ranges the metronome plays", () => {
    expect(normalizeSection({ name: "  Aメロ ", bpm: 10, beatsPerBar: 0, beatUnit: 3, bars: 0 }))
      .toEqual({ name: "Aメロ", bpm: 30, beatsPerBar: 1, beatUnit: 4, bars: 1 });
    expect(normalizeSection({ name: "B", bpm: 500, beatsPerBar: 17, beatUnit: 8, bars: 1000 }))
      .toEqual({ name: "B", bpm: 240, beatsPerBar: 16, beatUnit: 8, bars: MAX_SECTION_BARS });
    // Fractions: BPM may have decimals as in the BPM field; beats and bars are whole.
    expect(normalizeSection({ name: "", bpm: 92.5, beatsPerBar: 3.7, beatUnit: 16, bars: 2.9 }))
      .toEqual({ name: "", bpm: 92.5, beatsPerBar: 3, beatUnit: 16, bars: 2 });
    // Numeric strings, as read from a form, are accepted.
    expect(normalizeSection({ bpm: "132", beatsPerBar: "6", beatUnit: "8", bars: "12" }))
      .toEqual({ name: "", bpm: 132, beatsPerBar: 6, beatUnit: 8, bars: 12 });
  });

  test("a section falls back to the defaults for missing or non-numeric values", () => {
    expect(normalizeSection({})).toEqual(DEFAULT_SECTION);
    expect(normalizeSection(null)).toEqual(DEFAULT_SECTION);
    expect(normalizeSection("4/4")).toEqual(DEFAULT_SECTION);
    expect(normalizeSection({ name: 3, bpm: "fast", beatsPerBar: null, beatUnit: "x", bars: Number.NaN }))
      .toEqual(DEFAULT_SECTION);
    expect(normalizeSection({ bpm: Number.POSITIVE_INFINITY, beatsPerBar: "", bars: [] })).toEqual(DEFAULT_SECTION);
  });

  test("a section name is cut to the length limit", () => {
    const name = normalizeSection({ name: "あ".repeat(MAX_SECTION_NAME_LENGTH + 5) }).name;
    expect(name).toBe("あ".repeat(MAX_SECTION_NAME_LENGTH));
  });

  test("a song keeps at most the section limit and at least one section", () => {
    const many = { id: "x", title: "t", sections: Array.from({ length: MAX_SONG_SECTIONS + 1 }, (_, index) => ({ bars: index + 1 })) };
    const kept = normalizeSong(many).sections;
    expect(kept).toHaveLength(MAX_SONG_SECTIONS);
    expect(kept.at(-1)!.bars).toBe(MAX_SONG_SECTIONS);
    expect(normalizeSong({ id: "x", title: "t", sections: [] }).sections).toEqual([DEFAULT_SECTION]);
    expect(normalizeSong({ id: "x", title: "t", sections: "none" }).sections).toEqual([DEFAULT_SECTION]);
  });

  test("a song keeps its id and trimmed title, and gets a new id when it has none", () => {
    expect(normalizeSong({ id: "song-1", title: "  練習曲 ", sections: [{ bpm: 90 }] }))
      .toEqual({ id: "song-1", title: "練習曲", sections: [{ ...DEFAULT_SECTION, bpm: 90 }] });
    for (const input of [null, 42, "song", {}, { id: "", title: 5 }]) {
      const song = normalizeSong(input);
      expect(song.id).not.toBe("");
      expect(song.title).toBe("");
      expect(song.sections).toEqual([DEFAULT_SECTION]);
    }
    expect(normalizeSong(SONG)).toEqual(SONG);
  });

  test("section and song lengths count the beat unit at the BPM", () => {
    expect(sectionSeconds(SONG.sections[0]!)).toBe(16);
    expect(sectionSeconds(SONG.sections[1]!)).toBeCloseTo(32 * 60 / 132, 9);
    expect(sectionSeconds(SONG.sections[2]!)).toBeCloseTo(14.4, 9);
    // 6/8 at 120: six eighth notes of 0.5s per bar.
    expect(sectionSeconds(section("", 120, 6, 4, 8))).toBe(12);
    const totals = songTotals(SONG);
    expect(totals.bars).toBe(24);
    expect(totals.seconds).toBeCloseTo(SONG_END - 10, 9);
  });

  test("each section's first bar is numbered through the song", () => {
    expect(sectionFirstBars(SONG)).toEqual([1, 9, 17]);
    expect(sectionFirstBars({ ...SONG, sections: [section("", 120, 4, 1)] })).toEqual([1]);
  });
});

describe("playback plan", () => {
  test("a whole song switches settings on each section's first beat and ends after the last bar", () => {
    const plan = buildPlaybackPlan(SONG, { startSectionIndex: 0, startBar: 1, countInBars: 0, startHostTime: 10 });
    expect(plan.startHostTime).toBe(10);
    expect(plan.config).toEqual(INTRO);
    expect(plan.totalBars).toBe(24);
    expect(plan.segments.map(({ kind, sectionIndex, name, bars, firstBarInSong }) => [kind, sectionIndex, name, bars, firstBarInSong]))
      .toEqual([["section", 0, "イントロ", 8, 1], ["section", 1, "Aメロ", 8, 9], ["section", 2, "サビ", 8, 17]]);
    expect(plan.segments.map((segment) => segment.config)).toEqual([INTRO, VERSE, CHORUS]);
    const bounds = plan.segments.map((segment) => [segment.fromHostTime, segment.toHostTime]);
    expect(bounds[0]).toEqual([10, VERSE_START]);
    expect(bounds[1]![0]).toBe(VERSE_START);
    expect(bounds[1]![1]).toBeCloseTo(CHORUS_START, 9);
    // Each segment starts exactly where the one before it ends.
    expect(bounds[2]![0]).toBe(bounds[1]![1]);
    expect(bounds[2]![1]).toBeCloseTo(SONG_END, 9);
    expect(plan.endHostTime).toBe(plan.segments.at(-1)!.toHostTime);
    expect(plan.changes).toEqual([
      { config: VERSE, applyAtHostTime: VERSE_START, beatInBarAtApply: 1 },
      { config: CHORUS, applyAtHostTime: plan.segments[2]!.fromHostTime, beatInBarAtApply: 1 },
    ]);
  });

  test("a segment ends on its last beat's grid, as the engine counts beats from the segment start", () => {
    const startHostTime = 1_793_000_000.25;
    const plan = buildPlaybackPlan(SONG, { startSectionIndex: 0, startBar: 1, countInBars: 0, startHostTime });
    for (const segment of plan.segments) {
      const beats = segment.bars * segment.config.beatsPerBar;
      expect(segment.toHostTime).toBe(segment.fromHostTime + beats * (60 / segment.config.bpm));
    }
  });

  test("starting mid-section plays the rest of that section, numbered as in the song", () => {
    const plan = buildPlaybackPlan(SONG, { startSectionIndex: 1, startBar: 3, countInBars: 0, startHostTime: 100 });
    expect(plan.config).toEqual(VERSE);
    expect(plan.segments.map(({ kind, sectionIndex, bars, firstBarInSong }) => [kind, sectionIndex, bars, firstBarInSong]))
      .toEqual([["section", 1, 6, 11], ["section", 2, 8, 17]]);
    expect(plan.segments[0]!.toHostTime).toBeCloseTo(100 + 24 * (60 / 132), 9);
    expect(plan.changes).toEqual([{ config: CHORUS, applyAtHostTime: plan.segments[0]!.toHostTime, beatInBarAtApply: 1 }]);
    expect(plan.endHostTime).toBeCloseTo(100 + 24 * (60 / 132) + 14.4, 9);
    expect(plan.totalBars).toBe(24);

    // Starting on the last bar of the last section plays that bar only.
    const last = buildPlaybackPlan(SONG, { startSectionIndex: 2, startBar: 8, countInBars: 0, startHostTime: 100 });
    expect(last.segments.map(({ bars, firstBarInSong }) => [bars, firstBarInSong])).toEqual([[1, 24]]);
    expect(last.changes).toEqual([]);
    expect(last.endHostTime).toBeCloseTo(101.8, 9);
  });

  test("a count-in plays bars of the start section's settings before it, outside the bar count", () => {
    for (const countInBars of [1, 2]) {
      const plan = buildPlaybackPlan(SONG, { startSectionIndex: 1, startBar: 1, countInBars, startHostTime: 100 });
      const countInEnd = 100 + countInBars * 4 * (60 / 132);
      expect(plan.startHostTime).toBe(100);
      expect(plan.config).toEqual(VERSE);
      expect(plan.segments[0]).toEqual({
        kind: "countIn", sectionIndex: 1, name: "Aメロ", config: VERSE,
        fromHostTime: 100, toHostTime: plan.segments[0]!.toHostTime, bars: countInBars, firstBarInSong: 0,
      });
      expect(plan.segments[0]!.toHostTime).toBeCloseTo(countInEnd, 9);
      expect(plan.segments.slice(1).map(({ kind, sectionIndex, bars, firstBarInSong }) => [kind, sectionIndex, bars, firstBarInSong]))
        .toEqual([["section", 1, 8, 9], ["section", 2, 8, 17]]);
      expect(plan.segments[1]!.fromHostTime).toBe(plan.segments[0]!.toHostTime);
      // The section after the count-in starts with a change, even with the same settings.
      expect(plan.changes.map((change) => [change.config, change.applyAtHostTime, change.beatInBarAtApply])).toEqual([
        [VERSE, plan.segments[1]!.fromHostTime, 1],
        [CHORUS, plan.segments[2]!.fromHostTime, 1],
      ]);
      expect(plan.totalBars).toBe(24);
      expect(plan.endHostTime).toBeCloseTo(countInEnd + 32 * (60 / 132) + 14.4, 9);
    }
    const none = buildPlaybackPlan(SONG, { startSectionIndex: 1, startBar: 1, countInBars: 0, startHostTime: 100 });
    expect(none.segments.map((segment) => segment.kind)).toEqual(["section", "section"]);
  });

  test("out-of-range start options are clamped to the song", () => {
    const options = { startHostTime: 100 };
    const late = buildPlaybackPlan(SONG, { ...options, startSectionIndex: 9, startBar: 99, countInBars: 5 });
    expect(late.segments.map(({ kind, sectionIndex, bars, firstBarInSong }) => [kind, sectionIndex, bars, firstBarInSong]))
      .toEqual([["countIn", 2, 2, 0], ["section", 2, 1, 24]]);
    const early = buildPlaybackPlan(SONG, { ...options, startSectionIndex: -1, startBar: 0, countInBars: -1 });
    expect(early.segments.map(({ kind, sectionIndex, firstBarInSong }) => [kind, sectionIndex, firstBarInSong]))
      .toEqual([["section", 0, 1], ["section", 1, 9], ["section", 2, 17]]);
    const garbage = buildPlaybackPlan(SONG, { ...options, startSectionIndex: Number.NaN, startBar: Number.NaN, countInBars: Number.NaN });
    expect(garbage.segments.map(({ kind, sectionIndex, firstBarInSong }) => [kind, sectionIndex, firstBarInSong]))
      .toEqual([["section", 0, 1], ["section", 1, 9], ["section", 2, 17]]);
  });

  test("a song that is not normalized is played as normalizeSong would leave it", () => {
    const plan = buildPlaybackPlan({ id: "x", title: "", sections: [] }, { startSectionIndex: 0, startBar: 1, countInBars: 0, startHostTime: 0 });
    expect(plan.segments).toHaveLength(1);
    expect(plan.config).toEqual(sectionConfig(DEFAULT_SECTION));
    expect(plan.endHostTime).toBe(16);
    expect(plan.totalBars).toBe(8);
  });

  test("the position names the segment and bar being played, numbered through the song", () => {
    const plan = buildPlaybackPlan(SONG, { startSectionIndex: 0, startBar: 7, countInBars: 1, startHostTime: 10 });
    // Count-in 10..12, intro bars 7-8 12..16, verse 16..CHORUS, chorus to the end.
    const verseStart = 16;
    const chorusStart = plan.segments[3]!.fromHostTime;
    const position = (hostTime: number) => planPositionAt(plan, hostTime);
    expect(position(9.999)).toBeNull();
    expect(position(10)).toEqual({ kind: "countIn", sectionIndex: 0, name: "イントロ", barInSegment: 1, barInSong: 0, totalBars: 24 });
    expect(position(11.999)).toMatchObject({ kind: "countIn", barInSegment: 1, barInSong: 0 });
    // Within the time epsilon of a boundary is on it, as for the engine's beats.
    expect(position(12 - 1e-7)).toMatchObject({ kind: "section", barInSegment: 1, barInSong: 7 });
    expect(position(12)).toEqual({ kind: "section", sectionIndex: 0, name: "イントロ", barInSegment: 1, barInSong: 7, totalBars: 24 });
    expect(position(14)).toMatchObject({ sectionIndex: 0, barInSegment: 2, barInSong: 8 });
    expect(position(verseStart - 0.001)).toMatchObject({ sectionIndex: 0, barInSegment: 2, barInSong: 8 });
    expect(position(verseStart)).toEqual({ kind: "section", sectionIndex: 1, name: "Aメロ", barInSegment: 1, barInSong: 9, totalBars: 24 });
    // The verse's bars are 4 * 60/132 s long; its third bar starts at verseStart + 2 bars.
    const verseBar = 4 * (60 / 132);
    expect(position(verseStart + 2 * verseBar)).toMatchObject({ sectionIndex: 1, barInSegment: 3, barInSong: 11 });
    expect(position(verseStart + 2 * verseBar - 0.001)).toMatchObject({ barInSegment: 2, barInSong: 10 });
    expect(position(chorusStart - 0.001)).toMatchObject({ sectionIndex: 1, barInSegment: 8, barInSong: 16 });
    expect(position(chorusStart)).toMatchObject({ kind: "section", sectionIndex: 2, name: "サビ", barInSegment: 1, barInSong: 17 });
    expect(position(plan.endHostTime - 0.001)).toMatchObject({ sectionIndex: 2, barInSegment: 8, barInSong: 24 });
    expect(position(plan.endHostTime)).toBeNull();
    expect(position(plan.endHostTime + 5)).toBeNull();
  });

  test("the message carries the plan without the start, which the start message already has", () => {
    const plan = buildPlaybackPlan(SONG, { startSectionIndex: 1, startBar: 2, countInBars: 2, startHostTime: 1_793_000_000.25 });
    const message = planMessage(plan);
    expect(Object.keys(message).sort()).toEqual(["changes", "endHostTime", "segments", "totalBars"]);
    expect(message).toEqual({ changes: plan.changes, endHostTime: plan.endHostTime, segments: plan.segments, totalBars: plan.totalBars });
    // Plain JSON: it survives the data channel unchanged, and the position works on it as on the plan.
    const received = JSON.parse(JSON.stringify(message));
    expect(received).toEqual(message);
    const hostTime = plan.segments[2]!.fromHostTime + 1;
    expect(planPositionAt(received, hostTime)).toEqual(planPositionAt(plan, hostTime));
  });

  test("the start position is the first bar played after the count-in", () => {
    const plan = buildPlaybackPlan(SONG, { startSectionIndex: 1, startBar: 3, countInBars: 2, startHostTime: 100 });
    expect(planStartPosition(plan)).toEqual({ kind: "section", sectionIndex: 1, name: "Aメロ", barInSegment: 1, barInSong: 11, totalBars: 24 });
    expect(planStartPosition(plan)).toEqual(planPositionAt(plan, plan.segments[1]!.fromHostTime));
    const whole = buildPlaybackPlan(SONG, { startSectionIndex: 0, startBar: 1, countInBars: 0, startHostTime: 100 });
    expect(planStartPosition(whole)).toEqual(planPositionAt(whole, 100));
  });

  test("the count-in length is read from the plan", () => {
    for (const countInBars of [0, 1, 2]) {
      const plan = buildPlaybackPlan(SONG, { startSectionIndex: 2, startBar: 1, countInBars, startHostTime: 0 });
      expect(planCountInBars(plan)).toBe(countInBars);
      expect(planCountInBars(JSON.parse(JSON.stringify(planMessage(plan))))).toBe(countInBars);
    }
  });
});
