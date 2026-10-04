import type { BeatInfo, MetronomeConfig } from "../../../shared/types.ts";
import { meterLabel } from "./labels.ts";
import type { PlaybackPhase } from "./playback.ts";

export type BeatDisplayState = {
  phase: PlaybackPhase;
  beat: BeatInfo | null;
  config: MetronomeConfig;
};

/**
 * Current-beat readout shared by the host and participant screens.
 * Callers only depend on update(), so the numeric readout can be replaced by another visual.
 */
export class BeatDisplay {
  private readonly caption = document.createElement("p");
  private readonly value = document.createElement("p");
  private readonly meta = document.createElement("p");
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private lastBeatIndex: number | null = null;

  constructor(private readonly root: HTMLElement) {
    this.caption.className = "beat-display-caption";
    this.value.className = "beat-display-value";
    this.meta.className = "beat-display-meta";
    root.classList.add("beat-display");
    root.replaceChildren(this.caption, this.value, this.meta);
  }

  update({ phase, beat, config }: BeatDisplayState): void {
    const playingBeat = phase.kind === "playing" ? beat : null;
    this.root.dataset.phase = phase.kind;
    this.root.dataset.accent = String(playingBeat !== null && playingBeat.beatInBar === 1);
    setText(this.caption, phase.kind === "countdown" ? "開始まで" : phase.kind === "playing" ? "現在の拍" : "停止中");
    setText(this.value, valueText(phase, playingBeat, config));
    setText(this.meta, meterLabel(config));

    if (playingBeat === null) {
      this.lastBeatIndex = null;
      return;
    }
    if (playingBeat.beatIndex !== this.lastBeatIndex) {
      this.lastBeatIndex = playingBeat.beatIndex;
      this.pulse(playingBeat.beatInBar === 1);
    }
  }

  private pulse(accented: boolean): void {
    if (this.reducedMotion.matches) return;
    this.value.animate(
      [{ transform: `scale(${accented ? 1.18 : 1.08})` }, { transform: "scale(1)" }],
      { duration: 180, easing: "ease-out" },
    );
  }
}

function valueText(phase: PlaybackPhase, beat: BeatInfo | null, config: MetronomeConfig): string {
  if (phase.kind === "countdown") return String(phase.seconds);
  if (beat === null) return "–";
  // Beats per bar 0 has no bar position to show, so each beat is marked with a pulsing dot.
  return config.beatsPerBar > 0 ? String(beat.beatInBar) : "●";
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
