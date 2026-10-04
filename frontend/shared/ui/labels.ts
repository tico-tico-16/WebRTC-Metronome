import type { MetronomeConfig } from "../../../shared/types.ts";

export type StatusTone = "neutral" | "ok" | "warn" | "error";
export type StatusLabel = { text: string; tone: StatusTone };

const LOST_STATES = new Set(["disconnected", "closed", "failed"]);

/** `state` is an RTCPeerConnection state, or "sync open" once the sync channel opens. */
export function connectionLabel(state: string): StatusLabel {
  if (state === "connected" || state === "sync open") return { text: "接続済み", tone: "ok" };
  if (state === "failed") return { text: "接続できませんでした", tone: "error" };
  if (LOST_STATES.has(state)) return { text: "切断されました", tone: "error" };
  return { text: "接続中…", tone: "neutral" };
}

export function isConnectionLost(state: string): boolean {
  return LOST_STATES.has(state);
}

const SIGNALING_ERRORS: Record<string, string> = {
  "Room not found or already closed.": "部屋が見つからないか、すでに閉じられています",
  "Room is closed.": "部屋は閉じられています",
  "Room already has a host.": "この部屋にはすでにホストがいます",
  "Open the participant URL shared by the host.": "ホストが共有した参加者URLから開いてください",
};

/** The signaling server reports errors in English; known ones are shown in Japanese. */
export function signalingErrorLabel(message: string): string {
  const known = SIGNALING_ERRORS[message];
  if (known) return known;
  if (message.startsWith("Target ") && message.endsWith(" is not connected.")) return "相手との接続が切れています";
  return `接続エラー: ${message}`;
}

export function participantSyncLabel(state: {
  joined: boolean;
  connectionLost: boolean;
  stable: boolean;
  isPlaying: boolean;
  audioEnabled: boolean;
}): StatusLabel {
  if (!state.joined || state.connectionLost) return { text: "待機中", tone: "neutral" };
  if (!state.stable) return { text: "同期中…", tone: "neutral" };
  if (state.isPlaying && !state.audioEnabled) return { text: "音を有効にしてください", tone: "warn" };
  return { text: state.isPlaying ? "再生中" : "同期済み", tone: "ok" };
}

/** Beats per bar 0 means no accented downbeat. */
export function meterLabel(config: MetronomeConfig): string {
  const meter = config.beatsPerBar > 0 ? `${config.beatsPerBar}/${config.beatUnit}` : "強拍なし";
  return `${meter} · BPM ${Math.round(config.bpm * 10) / 10}`;
}
