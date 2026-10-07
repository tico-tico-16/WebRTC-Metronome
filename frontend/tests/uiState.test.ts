import { describe, expect, test } from "bun:test";
import { isClockStable } from "../shared/clockStability.ts";
import { playbackPhase } from "../shared/ui/playback.ts";
import {
  connectionLabel,
  isConnectionLost,
  beatDisplayLabel,
  formatBpm,
  meterText,
  participantSyncLabel,
  signalingErrorLabel,
} from "../shared/ui/labels.ts";
import { participantSummary, peerStatusLabel } from "../host/status.ts";

describe("playback phase", () => {
  test("is stopped without a start time", () => {
    expect(playbackPhase(10, null)).toEqual({ kind: "stopped" });
  });

  test("counts down whole seconds before the start time", () => {
    expect(playbackPhase(10, 12)).toEqual({ kind: "countdown", seconds: 2 });
    expect(playbackPhase(10.5, 12)).toEqual({ kind: "countdown", seconds: 2 });
    expect(playbackPhase(11.2, 12)).toEqual({ kind: "countdown", seconds: 1 });
  });

  test("is playing from the start time on", () => {
    expect(playbackPhase(12, 12)).toEqual({ kind: "playing" });
    expect(playbackPhase(30, 12)).toEqual({ kind: "playing" });
  });
});

describe("clock stability", () => {
  test("needs five samples and jitter below 25ms", () => {
    expect(isClockStable(4, 0.001)).toBe(false);
    expect(isClockStable(5, 0.024)).toBe(true);
    expect(isClockStable(5, 0.025)).toBe(false);
    expect(isClockStable(12, null)).toBe(false);
  });
});

describe("labels", () => {
  test("maps WebRTC states to Japanese labels and tones", () => {
    expect(connectionLabel("new")).toEqual({ text: "接続中…", tone: "neutral" });
    expect(connectionLabel("connecting")).toEqual({ text: "接続中…", tone: "neutral" });
    expect(connectionLabel("connected")).toEqual({ text: "接続済み", tone: "ok" });
    expect(connectionLabel("sync open")).toEqual({ text: "接続済み", tone: "ok" });
    expect(connectionLabel("disconnected")).toEqual({ text: "切断されました", tone: "error" });
    expect(connectionLabel("closed")).toEqual({ text: "切断されました", tone: "error" });
    expect(connectionLabel("failed")).toEqual({ text: "接続できませんでした", tone: "error" });
  });

  test("treats disconnected, closed and failed as lost connections", () => {
    expect(["new", "connecting", "connected", "sync open", "disconnected", "closed", "failed"].filter(isConnectionLost))
      .toEqual(["disconnected", "closed", "failed"]);
  });

  test("translates known signaling errors and keeps unknown ones visible", () => {
    expect(signalingErrorLabel("Room not found or already closed.")).toBe("部屋が見つからないか、すでに閉じられています");
    expect(signalingErrorLabel("Room is closed.")).toBe("部屋は閉じられています");
    expect(signalingErrorLabel("Room already has a host.")).toBe("この部屋にはすでにホストがいます");
    expect(signalingErrorLabel("Open the participant URL shared by the host.")).toBe("ホストが共有した参加者URLから開いてください");
    expect(signalingErrorLabel("Target client-1234 is not connected.")).toBe("相手との接続が切れています");
    expect(signalingErrorLabel("Something else")).toBe("接続エラー: Something else");
  });

  test("describes the participant sync state", () => {
    const base = { joined: true, connectionLost: false, stable: true, isPlaying: false, audioEnabled: true };
    expect(participantSyncLabel({ ...base, joined: false })).toEqual({ text: "待機中", tone: "neutral" });
    expect(participantSyncLabel({ ...base, connectionLost: true })).toEqual({ text: "待機中", tone: "neutral" });
    expect(participantSyncLabel({ ...base, stable: false })).toEqual({ text: "同期中…", tone: "neutral" });
    expect(participantSyncLabel({ ...base, isPlaying: true, audioEnabled: false }))
      .toEqual({ text: "音を有効にしてください", tone: "warn" });
    expect(participantSyncLabel(base)).toEqual({ text: "同期済み", tone: "ok" });
    expect(participantSyncLabel({ ...base, isPlaying: true })).toEqual({ text: "再生中", tone: "ok" });
  });

  test("shows the meter, with beat 0 meaning no accent", () => {
    expect(meterText({ bpm: 120, beatsPerBar: 4, beatUnit: 4 })).toBe("4/4");
    expect(meterText({ bpm: 120, beatsPerBar: 6, beatUnit: 8 })).toBe("6/8");
    expect(meterText({ bpm: 96, beatsPerBar: 0, beatUnit: 4 })).toBe("強拍なし");
  });

  test("describes the beat display for screen readers, including countdown and current beat", () => {
    const config = { bpm: 120, beatsPerBar: 4, beatUnit: 4 };
    const beat = (beatInBar: number) => ({ beatIndex: 5, beatInBar, secondsPerBeat: 0.5, progress: 0.3 });
    expect(beatDisplayLabel({ kind: "stopped" }, null, config)).toBe("停止中、4/4、BPM 120");
    expect(beatDisplayLabel({ kind: "countdown", seconds: 2 }, null, config)).toBe("開始まで2秒、4/4、BPM 120");
    expect(beatDisplayLabel({ kind: "playing" }, beat(3), config)).toBe("3拍目、4/4、BPM 120");
    expect(beatDisplayLabel({ kind: "playing" }, null, config)).toBe("再生中、4/4、BPM 120");
    expect(beatDisplayLabel({ kind: "playing" }, beat(0), { ...config, beatsPerBar: 0 })).toBe("再生中、強拍なし、BPM 120");
  });

  test("formats BPM with at most one decimal place", () => {
    expect(formatBpm(120)).toBe("120");
    expect(formatBpm(120.5)).toBe("120.5");
    expect(formatBpm(120.04)).toBe("120");
  });
});

describe("host participant status", () => {
  test("labels each peer by connection and clock sync", () => {
    const peer = (status: string, sampleCount = 0, jitter: number | null = null) => ({ status, sampleCount, jitter });
    expect(peerStatusLabel(peer("connecting"))).toEqual({ text: "接続中", tone: "neutral" });
    expect(peerStatusLabel(peer("connected", 3, 0.001))).toEqual({ text: "同期中", tone: "neutral" });
    expect(peerStatusLabel(peer("connected", 8, 0.002))).toEqual({ text: "同期済み", tone: "ok" });
    expect(peerStatusLabel(peer("failed", 8, 0.002))).toEqual({ text: "切断", tone: "error" });
    expect(peerStatusLabel(peer("disconnected"))).toEqual({ text: "切断", tone: "error" });
  });

  test("summarizes participants for the header button: connected count and the worst state", () => {
    const peer = (status: string, sampleCount = 8, jitter: number | null = 0.002) => ({ status, sampleCount, jitter });
    expect(participantSummary([])).toEqual({ count: 0, tone: "neutral" });
    expect(participantSummary([peer("connected"), peer("connected")])).toEqual({ count: 2, tone: "ok" });
    expect(participantSummary([peer("connected"), peer("connected", 2)])).toEqual({ count: 2, tone: "warn" });
    expect(participantSummary([peer("connecting")])).toEqual({ count: 0, tone: "warn" });
    expect(participantSummary([peer("connected"), peer("failed")])).toEqual({ count: 1, tone: "error" });
    expect(participantSummary([peer("connected", 2), peer("disconnected")])).toEqual({ count: 1, tone: "error" });
  });
});
