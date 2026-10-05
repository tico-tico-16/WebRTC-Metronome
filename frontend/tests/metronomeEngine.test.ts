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
  // Beat 1.0 is heard 50ms later, at 1.05.
  expect(engine.beatPositionHeardAt(1.04)).toBeNull();
  expect(engine.beatPositionHeardAt(1.3)!.progress).toBeCloseTo(0.5, 8);

  // Beat 1.5 is already reserved with the old offset when the offset changes.
  timers.advanceTo(1400);
  engine.setOutputOffsetMs(140);
  expect(engine.audibleDelaySeconds()).toBeCloseTo(0.15, 8);
  const reserved = engine.beatPositionHeardAt(1.6)!;
  expect([reserved.beatIndex, reserved.beatInBar]).toEqual([1, 2]);
  expect(reserved.progress).toBeCloseTo(0.1, 8);

  // Beat 2.0 is reserved after the change, so it is heard at 2.15.
  timers.advanceTo(2000);
  expect(engine.beatPositionHeardAt(2.1)).toMatchObject({ beatIndex: 1, progress: 1 });
  const next = engine.beatPositionHeardAt(2.2)!;
  expect([next.beatIndex, next.beatInBar]).toEqual([2, 3]);
  expect(next.progress).toBeCloseTo(0.1, 8);
  engine.stop();
});

test("engine reports the delay until a click is heard as offset plus output latency", () => {
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
  expect(engine.audibleDelaySeconds()).toBeCloseTo(0.03, 8);
  engine.setOutputOffsetMs(20);
  latency = 0.01;
  expect(engine.audibleDelaySeconds()).toBeCloseTo(0.03, 8);
  engine.setOutputOffsetMs(-50);
  expect(engine.audibleDelaySeconds()).toBeCloseTo(-0.04, 8);
});

test("beatPositionAt derives the position from the start time when nothing is scheduled", () => {
  const config = { bpm: 120, beatsPerBar: 3, beatUnit: 4 };
  expect(beatPositionAt(0.5, 1, config)).toEqual({ beatIndex: 0, beatInBar: 1, secondsPerBeat: 0.5, progress: 0 });
  expect(beatPositionAt(2.25, 1, config)).toEqual({ beatIndex: 2, beatInBar: 3, secondsPerBeat: 0.5, progress: 0.5 });
  expect(beatPositionAt(2.5, 1, { ...config, beatsPerBar: 0 })).toEqual({ beatIndex: 3, beatInBar: 0, secondsPerBeat: 0.5, progress: 0 });
});
