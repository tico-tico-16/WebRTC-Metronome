import type { BeatPosition, MetronomeConfig, PlaybackPlanMessage } from "../../../shared/types.ts";
import { sectionFirstBars, type Song, type SongSection } from "../song/model.ts";
import { planCountInBars, planPositionAt, planStartPosition, type PlanPosition } from "../song/plan.ts";
import type { PlaybackPhase } from "./playback.ts";

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
  "Room is full.": "部屋が満員です",
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
  /** Audio is enabled and running now. */
  audioEnabled: boolean;
  /** The participant has enabled audio before, so audio that is not running was stopped by the browser. */
  audioWasEnabled: boolean;
}): StatusLabel {
  if (!state.joined || state.connectionLost) return { text: "待機中", tone: "neutral" };
  if (!state.stable) return { text: "同期中…", tone: "neutral" };
  if (state.isPlaying && !state.audioEnabled) {
    return state.audioWasEnabled ? { text: "音声が中断されました", tone: "warn" } : { text: "音を有効にしてください", tone: "warn" };
  }
  return { text: state.isPlaying ? "再生中" : "同期済み", tone: "ok" };
}

/** Beats per bar 0 means no accented downbeat. */
export function meterText(config: MetronomeConfig): string {
  return config.beatsPerBar > 0 ? `${config.beatsPerBar}/${config.beatUnit}` : "強拍なし";
}

export function formatBpm(bpm: number): string {
  return String(Math.round(bpm * 10) / 10);
}

/** Text alternative for the beat display, which is otherwise only shapes and SVG text. */
export function beatDisplayLabel(phase: PlaybackPhase, beat: BeatPosition | null, config: MetronomeConfig): string {
  const state = phase.kind === "countdown"
    ? `開始まで${phase.seconds}秒`
    : phase.kind === "stopped"
      ? "停止中"
      : beat !== null && config.beatsPerBar > 0 ? `${beat.beatInBar}拍目` : "再生中";
  return `${state}、${meterText(config)}、BPM ${formatBpm(config.bpm)}`;
}

/** The song line under the beat display; caption, when given, replaces 「再生中」 above it. */
export type SongLine = { caption?: string; position: string };

/** A section's name, or its number (from 1) when it has none. */
export function sectionLabel(name: string, sectionIndex: number): string {
  return name !== "" ? name : `セクション ${sectionIndex + 1}`;
}

/** The section and the song's bar where playback starts, shown before the first beat. */
export function songStartLabel(position: Pick<PlanPosition, "name" | "sectionIndex" | "barInSong" | "totalBars">): string {
  return `${sectionLabel(position.name, position.sectionIndex)}　小節 ${position.barInSong} / ${position.totalBars}`;
}

/**
 * What is heard of a song: the count-in bar of countInBars (a position does not carry the count-in's
 * length), or the section and the song's bar, which the count-in does not count.
 */
export function songPositionLabel(position: PlanPosition, countInBars: number): Required<SongLine> {
  if (position.kind === "countIn") {
    return { caption: "カウントイン", position: `カウントイン　${position.barInSegment} / ${countInBars} 小節` };
  }
  return { caption: "再生中", position: songStartLabel(position) };
}

/**
 * The line for a playing plan: where it starts during the countdown (or the instant before the first
 * beat is heard), then the position heard. None once the display shows the song stopped.
 */
export function planSongLine(plan: PlaybackPlanMessage, phase: PlaybackPhase, heardHostTime: number): SongLine | null {
  if (phase.kind === "stopped") return null;
  const position = phase.kind === "playing" ? planPositionAt(plan, heardHostTime) : null;
  if (position) return songPositionLabel(position, planCountInBars(plan));
  const start = planStartPosition(plan);
  return start && { position: songStartLabel(start) };
}

/** The progress line on the section card being heard: bars of that section, or of the count-in. */
export function sectionProgressLabel(position: PlanPosition, song: Song, countInBars: number): string {
  if (position.kind === "countIn") return `カウントイン　${position.barInSegment} / ${countInBars} 小節`;
  const firstBar = sectionFirstBars(song)[position.sectionIndex] ?? 1;
  const bars = song.sections[position.sectionIndex]?.bars ?? position.barInSegment;
  return `再生中　${position.barInSong - firstBar + 1} / ${bars} 小節`;
}

/** The song's bar count and its length, rounded to the second. */
export function songTotalsLabel(totals: { bars: number; seconds: number }): { bars: string; length: string } {
  const seconds = Math.round(totals.seconds);
  const minutes = Math.floor(seconds / 60);
  return {
    bars: `全${totals.bars}小節`,
    length: minutes > 0 ? `約${minutes}分${seconds % 60}秒` : `約${seconds}秒`,
  };
}

/** A start position option: the section's number and name, and its bars in the song. */
export function sectionOptionLabel(section: SongSection, sectionIndex: number, firstBar: number): string {
  const lastBar = firstBar + section.bars - 1;
  const bars = lastBar > firstBar ? `${firstBar}〜${lastBar}小節` : `${firstBar}小節`;
  return `${sectionIndex + 1}. ${sectionLabel(section.name, sectionIndex)}（${bars}）`;
}
