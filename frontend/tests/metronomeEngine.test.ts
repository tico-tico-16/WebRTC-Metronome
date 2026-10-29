import { expect, test } from "bun:test";
import { beatPositionAt } from "../shared/metronome/beat.ts";
import { MetronomeEngine } from "../shared/metronome/engine.ts";
import { ManualTimers } from "./helpers/browser.ts";

// No browser globals are installed: the engine runs entirely on supplied dependencies.
test("engine schedules host-time beats through injected clocks and outputs", () => {
  const timers = new ManualTimers();
  const clicks: { time: number; accented: boolean }[] = [];
  const vibrations: { time: number; accented: boolean }[] = [];
  let vibrationEnabled = false;
  let cancellations = 0;
  const engine = new MetronomeEngine({
    now: () => timers.nowMs / 1000,
    hostToLocalTime: (time) => time - 1000,
    canSchedule: () => true,
    timers,
    audio: {
      currentTime: () => 10 + timers.nowMs / 1000,
      click: (time, accented) => clicks.push({ time, accented }),
      outputLatency: () => 0,
    },
    vibration: {
      setEnabled: (enabled) => { vibrationEnabled = enabled; },
      schedule: (delayMs, accented) => {
        if (vibrationEnabled) vibrations.push({ time: (timers.nowMs + delayMs) / 1000, accented });
      },
      cancel: () => { cancellations += 1; },
    },
  });

  engine.setOutputOffsetMs(100);
  engine.setVibrationEnabled(true);
  engine.start({ bpm: 120, beatsPerBar: 4, beatUnit: 4 }, 1001, 1000);
  timers.advanceTo(3000);
  expect(clicks).toHaveLength(5);
  expect(vibrations).toHaveLength(5);
  [11.1, 11.6, 12.1, 12.6, 13.1].forEach((time, index) => {
    expect(clicks[index]!.time).toBeCloseTo(time, 8);
    expect(vibrations[index]!.time).toBeCloseTo(time - 10, 8);
  });
  expect(clicks.map((click) => click.accented)).toEqual([true, false, false, false, true]);
  expect(vibrations.map((event) => event.accented)).toEqual([true, false, false, false, true]);
  expect(engine.beatAtHostTime(1002)).toEqual({ beatIndex: 2, beatInBar: 3, secondsPerBeat: 0.5 });
  expect(engine.nextStrongBeatHostTime(1002)).toBe(1003);

  engine.stop();
  timers.advanceTo(6000);
  expect(clicks).toHaveLength(5);
  expect(timers.intervalCount).toBe(0);
  expect(cancellations).toBe(1);
  expect(engine.beatAtHostTime(1002)).toBeNull();
});

test("engine waits for the supplied scheduling gate and audio clock", () => {
  const timers = new ManualTimers();
  const clicks: number[] = [];
  let canSchedule = false;
  let audioAvailable = false;
  const engine = new MetronomeEngine({
    now: () => timers.nowMs / 1000,
    hostToLocalTime: (time) => time,
    canSchedule: () => canSchedule,
    timers,
    audio: {
      currentTime: () => audioAvailable ? 10 + timers.nowMs / 1000 : null,
      click: (time) => clicks.push(time),
      outputLatency: () => 0,
    },
    vibration: { setEnabled() {}, schedule() {}, cancel() {} },
  });
  engine.start({ bpm: 120, beatsPerBar: 4, beatUnit: 4 }, 1, 0);
  timers.advanceTo(825);
  expect(clicks).toEqual([]);
  canSchedule = true;
  timers.advanceTo(900);
  expect(clicks).toEqual([]);
  audioAvailable = true;
  timers.advanceTo(925);
  expect(clicks).toEqual([11]);
  engine.stop();
});

test("engine reports how far through the heard beat a moment is", () => {
  const timers = new ManualTimers();
  const engine = new MetronomeEngine({
    now: () => timers.nowMs / 1000,
    hostToLocalTime: (time) => time,
    canSchedule: () => true,
    timers,
    audio: { currentTime: () => timers.nowMs / 1000, click() {}, outputLatency: () => 0 },
    vibration: { setEnabled() {}, schedule() {}, cancel() {} },
  });
  engine.start({ bpm: 120, beatsPerBar: 4, beatUnit: 4 }, 1, 0);
  timers.advanceTo(1100);
  expect(engine.beatPositionHeardAt(0.9)).toBeNull();
  expect(engine.beatPositionHeardAt(1)).toEqual({ beatIndex: 0, beatInBar: 1, secondsPerBeat: 0.5, progress: 0 });
  expect(engine.beatPositionHeardAt(1.25)).toEqual({ beatIndex: 0, beatInBar: 1, secondsPerBeat: 0.5, progress: 0.5 });

  // The next beat (1.5) is scheduled after the tempo change, so it carries the new length.
  engine.updateConfig({ bpm: 60, beatsPerBar: 4, beatUnit: 4 });
  timers.advanceTo(2400);
  expect(engine.beatPositionHeardAt(1.75)).toEqual({ beatIndex: 1, beatInBar: 2, secondsPerBeat: 1, progress: 0.25 });
  expect(engine.beatPositionHeardAt(3)).toEqual({ beatIndex: 2, beatInBar: 3, secondsPerBeat: 1, progress: 0.5 });
  // Past the end of the last scheduled beat the position stays at its end.
  expect(engine.beatPositionHeardAt(4)!.progress).toBe(1);
  engine.stop();
});

test("engine keeps the delay each click was scheduled with when the offset changes mid-play", () => {
  const timers = new ManualTimers();
  const engine = new MetronomeEngine({
    now: () => timers.nowMs / 1000,
    hostToLocalTime: (time) => time,
    canSchedule: () => true,
    timers,
    audio: { currentTime: () => timers.nowMs / 1000, click() {}, outputLatency: () => 0.01 },
    vibration: { setEnabled() {}, schedule() {}, cancel() {} },
  });
  engine.setOutputOffsetMs(40);
  engine.start({ bpm: 120, beatsPerBar: 4, beatUnit: 4 }, 1, 0);
  timers.advanceTo(1100);
  // Beat 1.0 is heard 40ms later, at 1.04: the output latency is taken out when reserving.
  expect(engine.beatPositionHeardAt(1.03)).toBeNull();
  expect(engine.beatPositionHeardAt(1.29)!.progress).toBeCloseTo(0.5, 8);

  // Beat 1.5 is already reserved with the old offset when the offset changes.
  timers.advanceTo(1400);
  engine.setOutputOffsetMs(140);
  expect(engine.audibleDelaySeconds()).toBeCloseTo(0.14, 8);
  const reserved = engine.beatPositionHeardAt(1.59)!;
  expect([reserved.beatIndex, reserved.beatInBar]).toEqual([1, 2]);
  expect(reserved.progress).toBeCloseTo(0.1, 8);

  // Beat 2.0 is reserved after the change, so it is heard at 2.14.
  timers.advanceTo(2000);
  const approaching = engine.beatPositionHeardAt(2.09)!;
  expect(approaching.beatIndex).toBe(1);
  expect(approaching.progress).toBeCloseTo(0.55 / 0.6, 8);
  const next = engine.beatPositionHeardAt(2.19)!;
  expect([next.beatIndex, next.beatInBar]).toEqual([2, 3]);
  expect(next.progress).toBeCloseTo(0.1, 8);
  engine.stop();
});

test("engine follows the most recently heard click when a large offset cut reorders them", () => {
  const timers = new ManualTimers();
  const engine = new MetronomeEngine({
    now: () => timers.nowMs / 1000,
    hostToLocalTime: (time) => time,
    canSchedule: () => true,
    timers,
    audio: { currentTime: () => timers.nowMs / 1000, click() {}, outputLatency: () => 0 },
    vibration: { setEnabled() {}, schedule() {}, cancel() {} },
  });
  engine.setOutputOffsetMs(200);
  engine.start({ bpm: 240, beatsPerBar: 4, beatUnit: 4 }, 1, 0);
  // Beat 1.5 is reserved with +200ms, so it is heard at 1.70.
  timers.advanceTo(1525);
  engine.setOutputOffsetMs(-200);
  // Beat 1.75 is reserved with -200ms, so it is heard earlier, at 1.55.
  timers.advanceTo(1700);
  expect(engine.beatPositionHeardAt(1.6)!.beatIndex).toBe(3);
  const latest = engine.beatPositionHeardAt(1.72)!;
  expect(latest.beatIndex).toBe(2);
  // The next click heard after 1.70 is beat 2.0, at 1.80.
  timers.advanceTo(1750);
  expect(engine.beatPositionHeardAt(1.72)!.progress).toBeCloseTo(0.2, 8);
  engine.stop();
});

test("engine paces the dot by the gap between clicks actually heard after an offset change", () => {
  const timers = new ManualTimers();
  const engine = new MetronomeEngine({
    now: () => timers.nowMs / 1000,
    hostToLocalTime: (time) => time,
    canSchedule: () => true,
    timers,
    audio: { currentTime: () => timers.nowMs / 1000, click() {}, outputLatency: () => 0 },
    vibration: { setEnabled() {}, schedule() {}, cancel() {} },
  });
  engine.start({ bpm: 120, beatsPerBar: 4, beatUnit: 4 }, 1, 0);
  // Beat 1.5 is reserved with no offset (heard at 1.5); beat 2.0 with +100ms (heard at 2.1).
  timers.advanceTo(1400);
  engine.setOutputOffsetMs(100);
  timers.advanceTo(1950);
  const beforeNext = engine.beatPositionHeardAt(2)!;
  expect(beforeNext.beatIndex).toBe(1);
  expect(beforeNext.progress).toBeCloseTo(0.5 / 0.6, 8);
  expect(engine.beatPositionHeardAt(2.1)).toMatchObject({ beatIndex: 2, progress: 0 });
  engine.stop();
});

test("engine tells when the click for a host time is heard, keeping a reserved click's delay", () => {
  const timers = new ManualTimers();
  const engine = new MetronomeEngine({
    now: () => timers.nowMs / 1000,
    hostToLocalTime: (time) => time,
    canSchedule: () => true,
    timers,
    audio: { currentTime: () => timers.nowMs / 1000, click() {}, outputLatency: () => 0.01 },
    vibration: { setEnabled() {}, schedule() {}, cancel() {} },
  });
  engine.setOutputOffsetMs(10);
  engine.start({ bpm: 120, beatsPerBar: 4, beatUnit: 4 }, 1, 0);
  // Not reserved yet: the current offset applies.
  expect(engine.heardHostTimeFor(1)).toBeCloseTo(1.01, 8);
  // The first click is reserved, then the offset is raised before it sounds.
  timers.advanceTo(900);
  engine.setOutputOffsetMs(200);
  expect(engine.heardHostTimeFor(1)).toBeCloseTo(1.01, 8);
  expect(engine.heardHostTimeFor(1.5)).toBeCloseTo(1.7, 8);
  engine.stop();
});

test("engine reports the delay until a click is heard as the output offset alone", () => {
  const timers = new ManualTimers();
  let latency = 0.03;
  const engine = new MetronomeEngine({
    now: () => timers.nowMs / 1000,
    hostToLocalTime: (time) => time,
    canSchedule: () => true,
    timers,
    audio: { currentTime: () => 0, click() {}, outputLatency: () => latency },
    vibration: { setEnabled() {}, schedule() {}, cancel() {} },
  });
  // Clicks are reserved earlier by the output latency, so it never delays what is heard.
  expect(engine.audibleDelaySeconds()).toBeCloseTo(0, 8);
  engine.setOutputOffsetMs(20);
  latency = 0.01;
  expect(engine.audibleDelaySeconds()).toBeCloseTo(0.02, 8);
  engine.setOutputOffsetMs(-50);
  expect(engine.audibleDelaySeconds()).toBeCloseTo(-0.05, 8);
});

/** Audio clock runs 10s ahead of the local clock, which equals host time. */
function latencyEngine(outputLatency: () => number, offsetMs = 0) {
  const timers = new ManualTimers();
  const clicks: number[] = [];
  const vibrations: number[] = [];
  const engine = new MetronomeEngine({
    now: () => timers.nowMs / 1000,
    hostToLocalTime: (time) => time,
    canSchedule: () => true,
    timers,
    audio: { currentTime: () => 10 + timers.nowMs / 1000, click: (time) => clicks.push(time), outputLatency },
    vibration: {
      setEnabled() {},
      schedule: (delayMs) => vibrations.push((timers.nowMs + delayMs) / 1000),
      cancel() {},
    },
  });
  engine.setOutputOffsetMs(offsetMs);
  return { timers, clicks, vibrations, engine };
}

test("engine reserves each click earlier by the output latency so it is heard on the beat", () => {
  let latency = 0.08;
  const { timers, clicks, vibrations, engine } = latencyEngine(() => latency, 30);
  engine.start({ bpm: 120, beatsPerBar: 4, beatUnit: 4 }, 1, 0);
  timers.advanceTo(2000);
  // Handed to the audio output 80ms before the beat plus offset, so the sound leaves the speaker on it.
  [10.95, 11.45, 11.95].forEach((time, index) => expect(clicks[index]).toBeCloseTo(time, 8));
  expect(clicks).toHaveLength(3);
  // Vibration has no audio output path, so it fires when the click is heard.
  [1.03, 1.53, 2.03].forEach((time, index) => expect(vibrations[index]).toBeCloseTo(time, 8));
  expect(engine.heardHostTimeFor(1)).toBeCloseTo(1.03, 8);
  expect(engine.beatPositionHeardAt(1.02)).toBeNull();
  expect(engine.beatPositionHeardAt(1.03)!.progress).toBeCloseTo(0, 8);
  expect(engine.beatPositionHeardAt(1.28)!.progress).toBeCloseTo(0.5, 8);

  // The latency is read when each click is reserved; earlier clicks keep theirs.
  latency = 0.02;
  timers.advanceTo(2400);
  expect(clicks).toHaveLength(4);
  expect(clicks[3]).toBeCloseTo(12.51, 8);
  expect(engine.heardHostTimeFor(2)).toBeCloseTo(2.03, 8);
  expect(engine.heardHostTimeFor(2.5)).toBeCloseTo(2.53, 8);
  engine.stop();
});

test("engine applies the lookahead and late tolerance to the latency-compensated time", () => {
  const ahead = latencyEngine(() => 0.08);
  ahead.engine.start({ bpm: 120, beatsPerBar: 4, beatUnit: 4 }, 1, 0);
  // The click for beat 1.0 is due at audio 10.92, so it enters the 180ms lookahead at 0.74.
  ahead.timers.advanceTo(725);
  expect(ahead.clicks).toEqual([]);
  ahead.timers.advanceTo(750);
  expect(ahead.clicks).toHaveLength(1);
  expect(ahead.clicks[0]).toBeCloseTo(10.92, 8);
  ahead.engine.stop();

  // A stalled timer at 0.95 is 30ms past that click time, beyond the 20ms tolerance.
  const late = latencyEngine(() => 0.08);
  late.engine.start({ bpm: 120, beatsPerBar: 4, beatUnit: 4 }, 1, 0);
  late.timers.runIntervalsAt(950);
  expect(late.clicks).toEqual([]);
  late.engine.stop();

  const onTime = latencyEngine(() => 0.08);
  onTime.engine.start({ bpm: 120, beatsPerBar: 4, beatUnit: 4 }, 1, 0);
  onTime.timers.runIntervalsAt(930);
  expect(onTime.clicks).toHaveLength(1);
  expect(onTime.clicks[0]).toBeCloseTo(10.92, 8);
  onTime.engine.stop();
});

test("engine clamps an implausible output latency before compensating", () => {
  for (const [reported, compensated] of [[Number.NaN, 0], [Number.POSITIVE_INFINITY, 0], [-0.1, 0], [2, 0.5]] as const) {
    const { timers, clicks, engine } = latencyEngine(() => reported);
    engine.start({ bpm: 120, beatsPerBar: 4, beatUnit: 4 }, 1, 0);
    timers.advanceTo(900);
    expect(clicks[0]).toBeCloseTo(11 - compensated, 8);
    expect(engine.heardHostTimeFor(1)).toBeCloseTo(1, 8);
    engine.stop();
  }
});

test("beatPositionAt derives the position from the start time when nothing is scheduled", () => {
  const config = { bpm: 120, beatsPerBar: 3, beatUnit: 4 };
  expect(beatPositionAt(0.5, 1, config)).toEqual({ beatIndex: 0, beatInBar: 1, secondsPerBeat: 0.5, progress: 0 });
  expect(beatPositionAt(2.25, 1, config)).toEqual({ beatIndex: 2, beatInBar: 3, secondsPerBeat: 0.5, progress: 0.5 });
  expect(beatPositionAt(2.5, 1, { ...config, beatsPerBar: 0 })).toEqual({ beatIndex: 3, beatInBar: 0, secondsPerBeat: 0.5, progress: 0 });
});
