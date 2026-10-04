import { describe, expect, test } from "bun:test";
import {
  MAX_BEATS_PER_BAR,
  METER_PRESETS,
  normalizeBeatsPerBar,
  normalizeBeatUnit,
  normalizeBpm,
  normalizeOutputOffsetMs,
  recordTap,
  stepBpm,
  tapTempoBpm,
} from "../shared/controlValues.ts";
import { connectedPeerCount } from "../host/status.ts";

// Inputs are normalized here and written back, so the screen shows the values actually applied.
describe("control values", () => {
  test("clamps BPM to 30-240 and falls back to 120", () => {
    expect(normalizeBpm("300")).toBe(240);
    expect(normalizeBpm("10")).toBe(30);
    expect(normalizeBpm("0")).toBe(30);
    expect(normalizeBpm("96")).toBe(96);
    expect(normalizeBpm("")).toBe(120);
    expect(normalizeBpm("abc")).toBe(120);
  });

  test("limits beats per bar to 0-16 whole beats", () => {
    expect(MAX_BEATS_PER_BAR).toBe(16);
    expect(normalizeBeatsPerBar("100")).toBe(16);
    expect(normalizeBeatsPerBar("7.8")).toBe(7);
    expect(normalizeBeatsPerBar("-3")).toBe(0);
    expect(normalizeBeatsPerBar("0")).toBe(0);
    expect(normalizeBeatsPerBar("abc")).toBe(4);
  });

  test("accepts 2, 4, 8 and 16 as the beat unit and falls back to 4", () => {
    expect(["2", "4", "8", "16"].map(normalizeBeatUnit)).toEqual([2, 4, 8, 16]);
    expect(normalizeBeatUnit("3")).toBe(4);
    expect(normalizeBeatUnit("")).toBe(4);
  });

  test("offers common meters as presets", () => {
    expect(METER_PRESETS.map(({ beatsPerBar, beatUnit }) => `${beatsPerBar}/${beatUnit}`))
      .toEqual(["2/4", "3/4", "4/4", "5/4", "6/8", "7/8"]);
  });

  test("steps BPM by whole beats within 30-240", () => {
    expect(stepBpm(120, 5)).toBe(125);
    expect(stepBpm(120, -1)).toBe(119);
    expect(stepBpm(120.4, 1)).toBe(121);
    expect(stepBpm(238, 5)).toBe(240);
    expect(stepBpm(32, -5)).toBe(30);
  });

  test("clamps output offset to +-200ms and falls back to 0", () => {
    expect(normalizeOutputOffsetMs("500")).toBe(200);
    expect(normalizeOutputOffsetMs("-500")).toBe(-200);
    expect(normalizeOutputOffsetMs("-35")).toBe(-35);
    expect(normalizeOutputOffsetMs("-")).toBe(0);
  });
});

describe("host status", () => {
  test("counts only peers whose connection is established", () => {
    const peers = ["connected", "connecting", "failed", "connected", "disconnected"].map((status) => ({ status }));
    expect(connectedPeerCount(peers)).toBe(2);
    expect(connectedPeerCount([])).toBe(0);
  });
});

describe("tap tempo", () => {
  test("needs three taps and averages the intervals", () => {
    expect(tapTempoBpm([0])).toBeNull();
    expect(tapTempoBpm([0, 500])).toBeNull();
    expect(tapTempoBpm([0, 500, 1000])).toBe(120);
    expect(tapTempoBpm([0, 480, 1000, 1520])).toBe(118);
  });

  test("keeps the last five taps and restarts after a two-second pause", () => {
    let taps: number[] = [];
    for (const time of [0, 400, 800, 1200, 1600, 2000]) taps = recordTap(taps, time);
    expect(taps).toEqual([400, 800, 1200, 1600, 2000]);
    expect(tapTempoBpm(taps)).toBe(150);
    expect(recordTap(taps, 4001)).toEqual([4001]);
    expect(recordTap(taps, 4000)).toEqual([800, 1200, 1600, 2000, 4000]);
  });

  test("caps fast taps at 240 BPM", () => {
    expect(tapTempoBpm([0, 100, 200])).toBe(240);
  });
});
