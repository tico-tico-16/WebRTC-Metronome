import { describe, expect, test } from "bun:test";
import { isClockStable } from "../shared/clockStability.ts";
import { playbackPhase } from "../shared/ui/playback.ts";
import {
  connectionLabel,
  isConnectionLost,
  meterLabel,
  participantSyncLabel,
  signalingErrorLabel,
} from "../shared/ui/labels.ts";
import { peerStatusLabel } from "../host/status.ts";

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

  test("shows the meter and tempo, with beat 0 meaning no accent", () => {
    expect(meterLabel({ bpm: 120, beatsPerBar: 4, beatUnit: 4 })).toBe("4/4 · BPM 120");
    expect(meterLabel({ bpm: 120.5, beatsPerBar: 6, beatUnit: 8 })).toBe("6/8 · BPM 120.5");
    expect(meterLabel({ bpm: 96, beatsPerBar: 0, beatUnit: 4 })).toBe("強拍なし · BPM 96");
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
});
