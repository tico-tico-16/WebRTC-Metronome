import { describe, expect, test } from "bun:test";
import { beatShape, beatVertices, dotPosition, type Point } from "../shared/ui/beatPolygon.ts";

function expectPoint(point: Point | undefined, x: number, y: number): void {
  expect(point).toBeDefined();
  expect(point!.x).toBeCloseTo(x, 6);
  expect(point!.y).toBeCloseTo(y, 6);
}

// Coordinates are SVG-style: the centre is (0, 0) and y grows downwards.
describe("beat polygon geometry", () => {
  test("draws a circle for 0 and 1 beats, a line for 2 and a polygon from 3", () => {
    expect([0, 1, 2, 3, 7].map(beatShape)).toEqual(["circle", "circle", "line", "polygon", "polygon"]);
  });

  test("puts beat 1 at the top and goes clockwise", () => {
    const square = beatVertices(4, 100);
    expectPoint(square[0], 0, -100);
    expectPoint(square[1], 100, 0);
    expectPoint(square[2], 0, 100);
    expectPoint(square[3], -100, 0);

    const triangle = beatVertices(3, 100);
    expectPoint(triangle[0], 0, -100);
    expect(triangle[1]!.x).toBeGreaterThan(0);
  });

  test("uses top and bottom for 2 beats, only the top for 1 beat and no vertex for 0", () => {
    const line = beatVertices(2, 100);
    expectPoint(line[0], 0, -100);
    expectPoint(line[1], 0, 100);
    expect(beatVertices(1, 100)).toHaveLength(1);
    expectPoint(beatVertices(1, 100)[0], 0, -100);
    expect(beatVertices(0, 100)).toEqual([]);
  });

  test("moves the dot at constant speed from the current beat's vertex to the next", () => {
    expectPoint(dotPosition(4, 1, 0, 100), 0, -100);
    expectPoint(dotPosition(4, 1, 0.5, 100), 50, -50);
    expectPoint(dotPosition(4, 2, 0.25, 100), 75, 25);
    expectPoint(dotPosition(4, 4, 0.5, 100), -50, -50);
    expectPoint(dotPosition(4, 4, 1, 100), 0, -100);
  });

  test("bounces between top and bottom for 2 beats", () => {
    expectPoint(dotPosition(2, 1, 0.5, 100), 0, 0);
    expectPoint(dotPosition(2, 2, 0.75, 100), 0, -50);
  });

  test("goes once around the circle per beat for 0 and 1 beats", () => {
    expectPoint(dotPosition(1, 1, 0, 100), 0, -100);
    expectPoint(dotPosition(1, 1, 0.25, 100), 100, 0);
    expectPoint(dotPosition(0, 0, 0.5, 100), 0, 100);
  });

  test("wraps a beat number beyond the shape, as right after a meter change", () => {
    expectPoint(dotPosition(3, 4, 0, 100), 0, -100);
  });
});
