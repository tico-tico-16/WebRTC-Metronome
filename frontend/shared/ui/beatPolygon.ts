/** SVG-style coordinates around a (0, 0) centre; y grows downwards. */
export type Point = { x: number; y: number };
export type BeatShape = "circle" | "line" | "polygon";

/** Beats per bar 0 (no accent) and 1 have no edges to travel, so the dot goes round a circle. */
export function beatShape(beatsPerBar: number): BeatShape {
  if (beatsPerBar >= 3) return "polygon";
  return beatsPerBar === 2 ? "line" : "circle";
}

function pointOnCircle(radius: number, turns: number): Point {
  const angle = -Math.PI / 2 + turns * 2 * Math.PI;
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

/** One vertex per beat, beat 1 at the top and the rest clockwise; 2 beats give top and bottom. */
export function beatVertices(beatsPerBar: number, radius: number): Point[] {
  if (beatsPerBar <= 0) return [];
  return Array.from({ length: beatsPerBar }, (_, index) => pointOnCircle(radius, index / beatsPerBar));
}

/**
 * Where the moving dot is, `progress` (0-1) of the way through `beatInBar`.
 * On a line or polygon it travels straight, at constant speed, from this beat's vertex to the next;
 * on a circle it goes once round per beat, starting at the top.
 */
export function dotPosition(beatsPerBar: number, beatInBar: number, progress: number, radius: number): Point {
  if (beatShape(beatsPerBar) === "circle") return pointOnCircle(radius, progress);

  const vertices = beatVertices(beatsPerBar, radius);
  const from = (((beatInBar - 1) % beatsPerBar) + beatsPerBar) % beatsPerBar;
  const start = vertices[from]!;
  const end = vertices[(from + 1) % beatsPerBar]!;
  return {
    x: start.x + (end.x - start.x) * progress,
    y: start.y + (end.y - start.y) * progress,
  };
}
