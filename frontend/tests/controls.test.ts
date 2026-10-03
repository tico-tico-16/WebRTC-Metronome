import { describe, expect, test } from "bun:test";
import {
  MAX_BEATS_PER_BAR,
  normalizeBeatsPerBar,
  normalizeBpm,
  normalizeOutputOffsetMs,
} from "../shared/controlValues.ts";
import { connectedPeerCount, playbackStatusText } from "../host/status.ts";

// Inputs are normalized here and written back, so the screen shows the values actually applied.
describe("control values", () => {
  test("clamps BPM to 30-240 and falls back to 120", () => {
    expect(normalizeBpm("300")).toBe(240);
    expect(normalizeBpm("10")).toBe(30);
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

  test("clamps output offset to +-200ms and falls back to 0", () => {
    expect(normalizeOutputOffsetMs("500")).toBe(200);
    expect(normalizeOutputOffsetMs("-500")).toBe(-200);
    expect(normalizeOutputOffsetMs("-35")).toBe(-35);
    expect(normalizeOutputOffsetMs("-")).toBe(0);
  });
});

describe("host status", () => {
  test("counts down before the start time instead of reporting a beat", () => {
    expect(playbackStatusText(10, 12, null)).toBe("Starting in 2 seconds");
    expect(playbackStatusText(10.5, 12, null)).toBe("Starting in 2 seconds");
    expect(playbackStatusText(11.2, 12, null)).toBe("Starting in 1 second");
  });

  test("reports the current beat once playback has started", () => {
    expect(playbackStatusText(12, 12, 1)).toBe("Playing beat 1");
    expect(playbackStatusText(13.6, 12, 4)).toBe("Playing beat 4");
    expect(playbackStatusText(12, 12, null)).toBe("Playing");
    expect(playbackStatusText(12, 12, 0)).toBe("Playing");
  });

  test("reports stopped without a start time", () => {
    expect(playbackStatusText(10, null, null)).toBe("Stopped");
  });

  test("counts only peers whose connection is established", () => {
    const peers = ["connected", "connecting", "failed", "connected", "disconnected"].map((status) => ({ status }));
    expect(connectedPeerCount(peers)).toBe(2);
    expect(connectedPeerCount([])).toBe(0);
  });
});
