import type { BeatPosition, MetronomeConfig } from "../../../shared/types.ts";
import { beatShape, beatVertices, dotPosition } from "./beatPolygon.ts";
import { formatBpm, meterText } from "./labels.ts";
import type { PlaybackPhase } from "./playback.ts";

export type BeatDisplayState = {
  phase: PlaybackPhase;
  beat: BeatPosition | null;
  config: MetronomeConfig;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const RADIUS = 100;
// A vertex stays highlighted for this part of its beat.
const HIT_PROGRESS = 0.2;

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, className: string): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  element.setAttribute("class", className);
  return element;
}

/**
 * Beat display shared by the host and participant screens: an n-sided shape for an n-beat bar,
 * with a dot that travels from one beat's vertex to the next and reaches it on the beat.
 */
export class BeatDisplay {
  private readonly caption = document.createElement("p");
  private readonly svg = svgElement("svg", "beat-polygon");
  private readonly shapeLayer = svgElement("g", "beat-shape-layer");
  private readonly vertexLayer = svgElement("g", "beat-vertex-layer");
  private readonly centerValue = svgElement("text", "beat-center-value");
  private readonly centerUnit = svgElement("text", "beat-center-unit");
  private readonly dot = svgElement("circle", "beat-dot");
  private readonly meta = document.createElement("p");
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private shape: SVGElement | null = null;
  private vertices: SVGCircleElement[] = [];
  private drawnBeatsPerBar: number | null = null;
  private lastBeatIndex: number | null = null;

  constructor(private readonly root: HTMLElement) {
    this.caption.className = "beat-display-caption";
    this.meta.className = "beat-display-meta";
    this.svg.setAttribute("viewBox", "-124 -124 248 248");
    this.svg.setAttribute("role", "img");
    this.centerValue.setAttribute("y", "6");
    this.centerUnit.setAttribute("y", "40");
    this.dot.setAttribute("r", "11");
    this.svg.append(this.shapeLayer, this.vertexLayer, this.centerValue, this.centerUnit, this.dot);
    root.classList.add("beat-display");
    root.replaceChildren(this.caption, this.svg, this.meta);
  }

  update({ phase, beat, config }: BeatDisplayState): void {
    const beatsPerBar = config.beatsPerBar;
    if (beatsPerBar !== this.drawnBeatsPerBar) this.drawShape(beatsPerBar);

    this.root.dataset.phase = phase.kind;
    setText(this.caption, phase.kind === "countdown" ? "開始まで" : phase.kind === "playing" ? "再生中" : "停止中");
    setText(this.centerValue, phase.kind === "countdown" ? String(phase.seconds) : formatBpm(config.bpm));
    setText(this.centerUnit, phase.kind === "countdown" ? "" : "BPM");
    setText(this.meta, meterText(config));
    const label = `${meterText(config)}、BPM ${formatBpm(config.bpm)}`;
    if (this.svg.getAttribute("aria-label") !== label) this.svg.setAttribute("aria-label", label);

    const playingBeat = phase.kind === "playing" ? beat : null;
    this.placeDot(phase, playingBeat, beatsPerBar);
    this.highlight(playingBeat, beatsPerBar);
  }

  private drawShape(beatsPerBar: number): void {
    this.drawnBeatsPerBar = beatsPerBar;
    const vertices = beatVertices(beatsPerBar, RADIUS);
    const kind = beatShape(beatsPerBar);

    if (kind === "circle") {
      this.shape = svgElement("circle", "beat-shape");
      this.shape.setAttribute("r", String(RADIUS));
    } else if (kind === "line") {
      this.shape = svgElement("line", "beat-shape");
      this.shape.setAttribute("x1", String(vertices[0]!.x));
      this.shape.setAttribute("y1", String(vertices[0]!.y));
      this.shape.setAttribute("x2", String(vertices[1]!.x));
      this.shape.setAttribute("y2", String(vertices[1]!.y));
    } else {
      this.shape = svgElement("polygon", "beat-shape");
      this.shape.setAttribute("points", vertices.map(({ x, y }) => `${x},${y}`).join(" "));
    }
    this.shapeLayer.replaceChildren(this.shape);

    // A triangle is narrow inside, so its numbers are smaller and sit lower, where it is wider.
    const triangle = beatsPerBar === 3;
    this.centerValue.setAttribute("y", triangle ? "16" : "6");
    this.centerValue.style.fontSize = triangle ? "40px" : "";
    this.centerUnit.setAttribute("y", triangle ? "42" : "40");

    this.vertices = vertices.map(({ x, y }, index) => {
      const vertex = svgElement("circle", index === 0 ? "beat-vertex is-downbeat" : "beat-vertex");
      vertex.setAttribute("cx", String(x));
      vertex.setAttribute("cy", String(y));
      vertex.setAttribute("r", index === 0 ? "9" : "6");
      return vertex;
    });
    this.vertexLayer.replaceChildren(...this.vertices);
    this.lastBeatIndex = null;
  }

  private placeDot(phase: PlaybackPhase, beat: BeatPosition | null, beatsPerBar: number): void {
    // Without motion, the highlighted vertex alone shows the beat.
    const hidden = phase.kind === "stopped" || (phase.kind === "playing" && this.reducedMotion.matches);
    this.dot.style.display = hidden ? "none" : "";
    if (hidden) return;

    // During the countdown the dot waits on beat 1.
    const position = beat === null
      ? dotPosition(beatsPerBar, 1, 0, RADIUS)
      : dotPosition(beatsPerBar, beat.beatInBar, beat.progress, RADIUS);
    this.dot.setAttribute("cx", position.x.toFixed(2));
    this.dot.setAttribute("cy", position.y.toFixed(2));
  }

  private highlight(beat: BeatPosition | null, beatsPerBar: number): void {
    // 0 beats per bar has no vertices, so the circle itself marks each beat.
    const target = beat === null
      ? null
      : beatsPerBar > 0
        ? this.vertices[(beat.beatInBar - 1 + beatsPerBar) % beatsPerBar] ?? null
        : this.shape;
    const active = target !== null && beat !== null && (beat.progress < HIT_PROGRESS || this.reducedMotion.matches);

    for (const vertex of this.vertices) vertex.classList.toggle("is-active", active && vertex === target);
    this.shape?.classList.toggle("is-active", active && this.shape === target);

    if (beat === null) {
      this.lastBeatIndex = null;
      return;
    }
    if (beat.beatIndex !== this.lastBeatIndex) {
      this.lastBeatIndex = beat.beatIndex;
      if (target && !this.reducedMotion.matches) pulse(target, target === this.shape ? 1.04 : beat.beatInBar === 1 ? 1.8 : 1.5);
    }
  }
}

function pulse(element: SVGElement, scale: number): void {
  element.animate([{ transform: `scale(${scale})` }, { transform: "scale(1)" }], { duration: 180, easing: "ease-out" });
}

function setText(element: Element, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
