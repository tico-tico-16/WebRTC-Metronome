import { expect, test } from "bun:test";
import type { MetronomeConfig } from "../../shared/types.ts";
import { beatPositionAt } from "../shared/metronome/beat.ts";
import {
  messageAnchor,
  NO_ANCHOR,
  pendingFromStart,
  pendingPlaybackAt,
  queueConfigChange,
  withConfigChange,
} from "../shared/metronome/configChange.ts";
import { MetronomeEngine } from "../shared/metronome/engine.ts";
import type { Song } from "../shared/song/model.ts";
import { buildPlaybackPlan, type PlaybackPlan } from "../shared/song/plan.ts";
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

type Click = { hostTime: number; accented: boolean };
const AUDIO_BASE = 50;
const FOUR_FOUR: MetronomeConfig = { bpm: 120, beatsPerBar: 4, beatUnit: 4 };

/**
 * A device on a shared clock: timers.nowMs is host time in ms. Its local clock can be offset from
 * host time and its timer can tick at its own phase, so it reserves beats at other moments than the
 * host. Clicks are recorded as the host time they are heard, with their accent.
 */
function device({ localOffset = 0, timerPhaseMs = 0, outputLatency = 0 } = {}) {
  const timers = new ManualTimers();
  timers.nowMs = timerPhaseMs;
  const clicks: Click[] = [];
  const engine = new MetronomeEngine({
    now: () => timers.nowMs / 1000 + localOffset,
    hostToLocalTime: (hostTime) => hostTime + localOffset,
    canSchedule: () => true,
    timers,
    audio: {
      currentTime: () => AUDIO_BASE + timers.nowMs / 1000,
      click: (time, accented) => clicks.push({ hostTime: time + outputLatency - AUDIO_BASE, accented }),
      outputLatency: () => outputLatency,
    },
    vibration: { setEnabled() {}, schedule() {}, cancel() {} },
  });
  return { timers, clicks, engine, hostNow: () => timers.nowMs / 1000 };
}

/** Clicks as [heard host time to 1µs, accented], comparable between devices. */
function heard(clicks: Click[]): [number, boolean][] {
  return clicks.map(({ hostTime, accented }) => [Math.round(hostTime * 1e6) / 1e6, accented]);
}

/** A participant whose clock is 1000s off and whose timer ticks 7ms after the host's. */
function participantDevice(options: { outputLatency?: number } = {}) {
  return device({ localOffset: -1000, timerPhaseMs: 7, ...options });
}

// R02: each device used to apply a change at its own next unreserved beat, which depends on its
// timer phase and on when the message arrives, so tempo and accents could drift apart for good.
test("host and participant switch tempo on the anchored beat whichever beats they have reserved", () => {
  const cases: {
    from: number;
    to: number;
    changeAtMs: number;
    anchor: { applyAtHostTime: number; beatInBarAtApply: number };
    expected: [number, boolean][];
  }[] = [
    {
      // The host has not reserved 2.5 yet at 2.31s; the participant has by the time it hears of the change.
      from: 120, to: 60, changeAtMs: 2310, anchor: { applyAtHostTime: 3, beatInBarAtApply: 1 },
      expected: [[1, true], [1.5, false], [2, false], [2.5, false], [3, true], [4, false], [5, false], [6, false], [7, true]],
    },
    {
      // The host has not reserved 3 yet at 2.79s; the participant has at 2.85s.
      from: 60, to: 120, changeAtMs: 2790, anchor: { applyAtHostTime: 4, beatInBarAtApply: 4 },
      expected: [[1, true], [2, false], [3, false], [4, false], [4.5, true], [5, false], [5.5, false], [6, false], [6.5, true], [7, false]],
    },
  ];
  for (const { from, to, changeAtMs, anchor, expected } of cases) {
    const host = device();
    const participant = participantDevice();
    host.engine.start({ ...FOUR_FOUR, bpm: from }, 1, host.hostNow());
    participant.engine.start({ ...FOUR_FOUR, bpm: from }, 1, participant.hostNow());
    host.timers.advanceTo(changeAtMs);
    host.engine.updateConfig({ ...FOUR_FOUR, bpm: to }, anchor);
    participant.timers.advanceTo(changeAtMs + 60);
    participant.engine.updateConfig({ ...FOUR_FOUR, bpm: to }, anchor);
    host.timers.advanceTo(7100);
    participant.timers.advanceTo(7100);
    expect(heard(host.clicks)).toEqual(expected);
    expect(heard(participant.clicks)).toEqual(expected);
    expect(participant.engine.nextStrongBeatHostTime(7.1)).toBe(host.engine.nextStrongBeatHostTime(7.1)!);
  }
});

test("host and participant change meter on the anchored downbeat", () => {
  const host = device();
  const participant = participantDevice();
  host.engine.start(FOUR_FOUR, 1, host.hostNow());
  participant.engine.start(FOUR_FOUR, 1, participant.hostNow());
  const threeFour = { ...FOUR_FOUR, beatsPerBar: 3 };
  const anchor = { applyAtHostTime: 3, beatInBarAtApply: 1 };
  host.timers.advanceTo(2310);
  host.engine.updateConfig(threeFour, anchor);
  participant.timers.advanceTo(2370);
  participant.engine.updateConfig(threeFour, anchor);
  host.timers.advanceTo(7100);
  participant.timers.advanceTo(7100);
  // The 4/4 bar ends on 2.5, then 3/4 bars start on 3, 4.5 and 6.
  const expected: [number, boolean][] = [
    [1, true], [1.5, false], [2, false], [2.5, false],
    [3, true], [3.5, false], [4, false], [4.5, true], [5, false], [5.5, false], [6, true], [6.5, false], [7, false],
  ];
  expect(heard(host.clicks)).toEqual(expected);
  expect(heard(participant.clicks)).toEqual(expected);
  expect(participant.engine.nextStrongBeatHostTime(7.1)).toBe(7.5);
  expect(host.engine.nextStrongBeatHostTime(7.1)).toBe(7.5);
});

test("a participant that hears of a change after reserving past its beat continues on the new grid", () => {
  const sixty = { ...FOUR_FOUR, bpm: 60 };
  const anchor = { applyAtHostTime: 3, beatInBarAtApply: 1 };
  const cases: { receiveAtMs: number; lastReserved: [number, boolean] }[] = [
    // One old-grid beat (3.5) is already handed to the audio output.
    { receiveAtMs: 3400, lastReserved: [3.5, false] },
    // Several beats late: everything up to 5 is reserved on the old grid.
    { receiveAtMs: 5200, lastReserved: [5, true] },
  ];
  for (const { receiveAtMs, lastReserved } of cases) {
    const host = device();
    const participant = participantDevice();
    host.engine.start(FOUR_FOUR, 1, host.hostNow());
    participant.engine.start(FOUR_FOUR, 1, participant.hostNow());
    host.timers.advanceTo(2310);
    host.engine.updateConfig(sixty, anchor);
    host.timers.advanceTo(9100);

    participant.timers.advanceTo(receiveAtMs);
    const before = heard(participant.clicks);
    expect(before.at(-1)).toEqual(lastReserved);
    participant.engine.updateConfig(sixty, anchor);
    participant.timers.advanceTo(9100);
    // Reserved clicks cannot be recalled, but no further old-grid beat follows them:
    // from the next beat on, the participant plays exactly what the host plays.
    const after = heard(participant.clicks).slice(before.length);
    expect(after.length).toBeGreaterThan(0);
    expect(after).toEqual(heard(host.clicks).filter(([time]) => time > lastReserved[0]));
    expect(participant.engine.nextStrongBeatHostTime(9.1)).toBe(host.engine.nextStrongBeatHostTime(9.1)!);
  }
});

test("a late joiner given the host's next strong beat during a pending change lands on the new grid", () => {
  const host = device();
  host.engine.start(FOUR_FOUR, 1, host.hostNow());
  host.timers.advanceTo(2810);
  // A tempo change mid-bar: from beat 2 of the bar at 3.5, at 60 BPM.
  const sixty = { ...FOUR_FOUR, bpm: 60 };
  host.engine.updateConfig(sixty, { applyAtHostTime: 3.5, beatInBarAtApply: 2 });
  // The snapshot carries the latest settings, so its start must be a downbeat of the new grid.
  const joinHostTime = host.engine.nextStrongBeatHostTime(host.hostNow());
  expect(joinHostTime).toBe(6.5);

  const joiner = participantDevice();
  joiner.timers.advanceTo(2850);
  joiner.engine.start(sixty, joinHostTime!, joiner.hostNow());
  host.timers.advanceTo(9100);
  joiner.timers.advanceTo(9100);
  expect(heard(joiner.clicks)).toEqual(heard(host.clicks).filter(([time]) => time >= 6.5));
  expect(heard(host.clicks).filter(([time]) => time >= 3)).toEqual([
    [3, true], [3.5, false], [4.5, false], [5.5, false], [6.5, true], [7.5, false], [8.5, false],
  ]);
});

test("engine anchors a tempo change on the next unreserved beat and a meter change on the next downbeat", () => {
  const host = device();
  const sixty = { ...FOUR_FOUR, bpm: 60 };
  expect(host.engine.anchorForConfigChange(sixty, 0)).toBeNull();
  host.engine.start(FOUR_FOUR, 1, host.hostNow());
  host.timers.advanceTo(2810);
  // Reserved up to 2.5; 3 is the next beat (a downbeat), 3.5 is beat 2.
  expect(host.engine.anchorForConfigChange(sixty, 3.21)).toEqual({ applyAtHostTime: 3.5, beatInBarAtApply: 2 });
  // Never a beat already reserved, however early the caller allows.
  expect(host.engine.anchorForConfigChange(sixty, 0)).toEqual({ applyAtHostTime: 3, beatInBarAtApply: 1 });
  // A meter change lets the bar in progress end: 3 is too early, so the next downbeat is 5.
  expect(host.engine.anchorForConfigChange({ ...FOUR_FOUR, beatsPerBar: 3 }, 3.21)).toEqual({ applyAtHostTime: 5, beatInBarAtApply: 1 });
  expect(host.engine.anchorForConfigChange({ ...FOUR_FOUR, beatUnit: 8 }, 3.21)).toEqual({ applyAtHostTime: 5, beatInBarAtApply: 1 });
  expect(host.engine.anchorForConfigChange({ ...FOUR_FOUR, beatsPerBar: 0 }, 3.21)).toEqual({ applyAtHostTime: 5, beatInBarAtApply: 0 });

  // A change announced but not reached yet is part of the grid the next anchor is found on.
  host.engine.updateConfig(sixty, { applyAtHostTime: 3.5, beatInBarAtApply: 2 });
  const sixtyThreeFour = { ...sixty, beatsPerBar: 3 };
  const anchor = host.engine.anchorForConfigChange(sixtyThreeFour, 3.21)!;
  expect(anchor).toEqual({ applyAtHostTime: 6.5, beatInBarAtApply: 1 });
  host.engine.updateConfig(sixtyThreeFour, anchor);
  host.timers.advanceTo(10100);
  expect(heard(host.clicks).filter(([time]) => time >= 3)).toEqual([
    [3, true], [3.5, false], [4.5, false], [5.5, false], [6.5, true], [7.5, false], [8.5, false], [9.5, true],
  ]);
  host.engine.stop();
  expect(host.engine.anchorForConfigChange(sixty, 0)).toBeNull();

  // Without accents there is no downbeat to wait for: the next beat starts the first bar.
  const unaccented = device();
  unaccented.engine.start({ ...FOUR_FOUR, beatsPerBar: 0 }, 1, unaccented.hostNow());
  unaccented.timers.advanceTo(2810);
  expect(unaccented.engine.anchorForConfigChange({ ...FOUR_FOUR, beatsPerBar: 3 }, 3.21))
    .toEqual({ applyAtHostTime: 3.5, beatInBarAtApply: 1 });
});

test("a participant that starts after hearing of a change lands on the host's grid", () => {
  const sixty = { ...FOUR_FOUR, bpm: 60 };
  const anchor = { applyAtHostTime: 3, beatInBarAtApply: 1 };
  const host = device();
  host.engine.start(FOUR_FOUR, 1, host.hostNow());
  host.timers.advanceTo(2310);
  host.engine.updateConfig(sixty, anchor);
  host.timers.advanceTo(9100);

  // The participant got the start message, then the change, while its audio was still off.
  const pending = withConfigChange(pendingFromStart(FOUR_FOUR, 1), sixty, anchor);
  // Before the anchor, at it, and several beats after it.
  for (const startAtMs of [2600, 3600, 6020]) {
    const participant = participantDevice();
    participant.timers.advanceTo(startAtMs);
    const hostNow = participant.hostNow();
    const playback = pendingPlaybackAt(pending, hostNow);
    participant.engine.start(playback.config, playback.startHostTime, hostNow, {
      startBeatInBar: playback.startBeatInBar,
      changes: playback.changes,
    });
    participant.timers.advanceTo(9100);
    expect(heard(participant.clicks)).toEqual(heard(host.clicks).filter(([time]) => time >= hostNow));
    expect(participant.engine.nextStrongBeatHostTime(hostNow)).toBe(host.engine.nextStrongBeatHostTime(hostNow)!);
  }
});

test("a participant starting just before a change reserves nothing of the old tempo after it", () => {
  // At 240 BPM with 100ms of output latency compensation, the first pass reaches beats up to
  // 2.98 + 0.18 + 0.1 = 3.26s, so 3.25 would be reserved if the change were applied after starting.
  const fast = { ...FOUR_FOUR, bpm: 240 };
  const sixty = { ...FOUR_FOUR, bpm: 60 };
  const pending = withConfigChange(pendingFromStart(fast, 1), sixty, { applyAtHostTime: 3, beatInBarAtApply: 1 });
  const participant = participantDevice({ outputLatency: 0.1 });
  participant.timers.advanceTo(2980);
  const hostNow = participant.hostNow();
  const playback = pendingPlaybackAt(pending, hostNow);
  participant.engine.start(playback.config, playback.startHostTime, hostNow, {
    startBeatInBar: playback.startBeatInBar,
    changes: playback.changes,
  });
  // Beat 3 had to be handed over at 2.9s with this latency, so it is skipped as late.
  expect(heard(participant.clicks)).toEqual([]);
  participant.timers.advanceTo(5100);
  expect(heard(participant.clicks)).toEqual([[4, false], [5, false]]);
});

test("engine reports the settings of the click being heard, so a change shows once it sounds", () => {
  const host = device();
  host.engine.setOutputOffsetMs(40);
  expect(host.engine.configHeardAt(5)).toBeNull();
  host.engine.start(FOUR_FOUR, 1, host.hostNow());
  host.timers.advanceTo(2310);
  const threeFour = { ...FOUR_FOUR, beatsPerBar: 3 };
  host.engine.updateConfig(threeFour, { applyAtHostTime: 3, beatInBarAtApply: 1 });
  host.timers.advanceTo(3500);
  // The last 4/4 beat (2.5) is heard until 3.04, when the first 3/4 beat is.
  expect(host.engine.configHeardAt(3.03)).toEqual(FOUR_FOUR);
  expect(host.engine.configHeardAt(3.04)).toEqual(threeFour);
  host.engine.stop();
  expect(host.engine.configHeardAt(3.04)).toBeNull();
});

test("config messages sent while stopped carry no anchor", () => {
  expect(messageAnchor(NO_ANCHOR)).toBeNull();
  expect(messageAnchor({ applyAtHostTime: Number.NaN, beatInBarAtApply: 1 })).toBeNull();
  expect(messageAnchor({ applyAtHostTime: 3, beatInBarAtApply: 2 })).toEqual({ applyAtHostTime: 3, beatInBarAtApply: 2 });
});

test("a change replaces the changes announced for its beat or later", () => {
  const change = (applyAtHostTime: number, bpm: number) => ({ config: { ...FOUR_FOUR, bpm }, applyAtHostTime, beatInBarAtApply: 1 });
  const queued = queueConfigChange(queueConfigChange([], change(3, 60)), change(5, 90));
  expect(queueConfigChange(queued, change(7, 100)).map((queuedChange) => queuedChange.config.bpm)).toEqual([60, 90, 100]);
  expect(queueConfigChange(queued, change(5, 100)).map((queuedChange) => queuedChange.config.bpm)).toEqual([60, 100]);
  expect(queueConfigChange(queued, change(4, 100)).map((queuedChange) => queuedChange.config.bpm)).toEqual([60, 100]);
  expect(queueConfigChange(queued, change(2, 100)).map((queuedChange) => queuedChange.config.bpm)).toEqual([100]);
});

test("pending playback follows the changes announced before it starts", () => {
  const sixty = { ...FOUR_FOUR, bpm: 60 };
  const start = pendingFromStart(FOUR_FOUR, 1);
  expect(start).toEqual({ config: FOUR_FOUR, startHostTime: 1, startBeatInBar: 1, changes: [] });

  // A change after the start waits for its beat; from that beat on it is the start.
  const firstChange = { config: sixty, applyAtHostTime: 3.5, beatInBarAtApply: 2 };
  const pending = withConfigChange(start, sixty, { applyAtHostTime: 3.5, beatInBarAtApply: 2 });
  expect(pendingPlaybackAt(pending, 3.4)).toEqual({ ...start, changes: [firstChange] });
  expect(pendingPlaybackAt(pending, 3.5)).toEqual({ config: sixty, startHostTime: 3.5, startBeatInBar: 2, changes: [] });

  // With several changes, the last one due is the start and later ones stay queued.
  const threeFour = { ...sixty, beatsPerBar: 3 };
  const secondChange = { config: threeFour, applyAtHostTime: 6.5, beatInBarAtApply: 1 };
  const twice = withConfigChange(pending, threeFour, { applyAtHostTime: 6.5, beatInBarAtApply: 1 });
  expect(pendingPlaybackAt(twice, 4)).toEqual({ config: sixty, startHostTime: 3.5, startBeatInBar: 2, changes: [secondChange] });
  expect(pendingPlaybackAt(twice, 7)).toEqual({ config: threeFour, startHostTime: 6.5, startBeatInBar: 1, changes: [] });

  // A change anchored at or before the start (a snapshot's join beat) replaces the start.
  expect(withConfigChange(pendingFromStart(sixty, 6.5), threeFour, { applyAtHostTime: 4.5, beatInBarAtApply: 1 }))
    .toEqual({ config: threeFour, startHostTime: 4.5, startBeatInBar: 1, changes: [] });

  // Without an anchor the settings apply from the start, as before changes were anchored.
  expect(withConfigChange(pending, threeFour, null)).toEqual({ ...start, config: threeFour });
});

test("beatPositionAt counts the bar from the beat a grid starts on", () => {
  // A grid that starts at 3.5 on beat 2 of 4, at 60 BPM.
  const config = { bpm: 60, beatsPerBar: 4, beatUnit: 4 };
  expect(beatPositionAt(3.75, 3.5, config, 2)).toEqual({ beatIndex: 0, beatInBar: 2, secondsPerBeat: 1, progress: 0.25 });
  expect(beatPositionAt(6.5, 3.5, config, 2).beatInBar).toBe(1);
  expect(beatPositionAt(6.5, 3.5, { ...config, beatsPerBar: 0 }, 0).beatInBar).toBe(0);
});

test("engine reserves no beat at or after the end time, then stops its timer", () => {
  const host = device();
  host.engine.start(FOUR_FOUR, 1, host.hostNow(), { endHostTime: 5 });
  expect(host.engine.endHostTime()).toBe(5);
  host.timers.advanceTo(4300);
  expect(host.timers.intervalCount).toBe(1);
  // 4.5 is reserved at 4.325s and the next beat is the end, so there is nothing more to schedule.
  host.timers.advanceTo(4400);
  expect(host.timers.intervalCount).toBe(0);
  host.timers.advanceTo(8000);
  expect(heard(host.clicks)).toEqual([
    [1, true], [1.5, false], [2, false], [2.5, false], [3, true], [3.5, false], [4, false], [4.5, false],
  ]);
  // The reserved beats are kept, so the display can finish the last one.
  expect(host.engine.beatPositionHeardAt(4.75)).toEqual({ beatIndex: 7, beatInBar: 4, secondsPerBeat: 0.5, progress: 0.5 });
  expect(host.engine.beatPositionHeardAt(6)!.progress).toBe(1);
  host.engine.stop();
  expect(host.engine.endHostTime()).toBeNull();
});

test("engine reserves the last beat before the end, and a beat within the epsilon of the end counts as at it", () => {
  for (const [endHostTime, lastBeat] of [[4.6, 4.5], [5 + 1e-7, 4.5], [5 - 1e-7, 4.5], [5.0001, 5]] as const) {
    const host = device();
    host.engine.start(FOUR_FOUR, 1, host.hostNow(), { endHostTime });
    host.timers.advanceTo(8000);
    expect(heard(host.clicks).at(-1)![0]).toBe(lastBeat);
    expect(host.timers.intervalCount).toBe(0);
  }
});

test("engine started at or after the end time reserves nothing", () => {
  const host = device();
  host.timers.advanceTo(5000);
  host.engine.start(FOUR_FOUR, 1, host.hostNow(), { endHostTime: 5 });
  host.timers.advanceTo(8000);
  expect(host.clicks).toEqual([]);
  expect(host.timers.intervalCount).toBe(0);
});

test("engine finds no strong beat or anchor at or after the end time", () => {
  const host = device();
  host.engine.start(FOUR_FOUR, 1, host.hostNow(), { endHostTime: 5 });
  host.timers.advanceTo(1100);
  expect(host.engine.nextStrongBeatHostTime(1.1)).toBe(3);
  // The next downbeat would be 5, the end.
  expect(host.engine.nextStrongBeatHostTime(3.1)).toBeNull();
  expect(host.engine.nextStrongBeatHostTime(5)).toBeNull();
  expect(host.engine.nextStrongBeatHostTime(9)).toBeNull();
  expect(host.engine.anchorForConfigChange(FOUR_FOUR, 4.1)).toEqual({ applyAtHostTime: 4.5, beatInBarAtApply: 4 });
  expect(host.engine.anchorForConfigChange(FOUR_FOUR, 4.6)).toBeNull();
  expect(host.engine.anchorForConfigChange({ ...FOUR_FOUR, beatsPerBar: 3 }, 3.1)).toBeNull();

  // Without an end, playback goes on until stopped, as before.
  const open = device();
  open.engine.start(FOUR_FOUR, 1, open.hostNow());
  expect(open.engine.endHostTime()).toBeNull();
  expect(open.engine.nextStrongBeatHostTime(3.1)).toBe(5);
});

/** Every beat of a plan as [host time, accented], in the form heard() gives. */
function planBeats(plan: PlaybackPlan): [number, boolean][] {
  return plan.segments.flatMap((segment) => {
    const beatLength = 60 / segment.config.bpm;
    return Array.from({ length: segment.bars * segment.config.beatsPerBar }, (_, beat): [number, boolean] => [
      Math.round((segment.fromHostTime + beat * beatLength) * 1e6) / 1e6,
      beat % segment.config.beatsPerBar === 0,
    ]);
  });
}

/** Starts a device on a plan at its current time, as a participant does once it can play. */
function startOnPlan(target: ReturnType<typeof device>, plan: PlaybackPlan): void {
  const hostNow = target.hostNow();
  const pending = { config: plan.config, startHostTime: plan.startHostTime, startBeatInBar: 1, changes: plan.changes };
  const playback = pendingPlaybackAt(pending, hostNow);
  target.engine.start(playback.config, playback.startHostTime, hostNow, {
    startBeatInBar: playback.startBeatInBar,
    changes: playback.changes,
    endHostTime: plan.endHostTime,
  });
}

/** 120 4/4 x2, 132 4/4 x2, 100 3/4 x2. */
const SHORT_SONG: Song = {
  id: "song",
  title: "",
  sections: [
    { name: "A", bpm: 120, beatsPerBar: 4, beatUnit: 4, bars: 2 },
    { name: "B", bpm: 132, beatsPerBar: 4, beatUnit: 4, bars: 2 },
    { name: "C", bpm: 100, beatsPerBar: 3, beatUnit: 4, bars: 2 },
  ],
};

test("host and participants play a song plan on the same clicks and end together", () => {
  const plan = buildPlaybackPlan(SHORT_SONG, { startSectionIndex: 0, startBar: 1, countInBars: 1, startHostTime: 1 });
  const host = device();
  host.engine.start(plan.config, plan.startHostTime, host.hostNow(), { changes: plan.changes, endHostTime: plan.endHostTime });
  const participant = participantDevice({ outputLatency: 0.03 });
  startOnPlan(participant, plan);
  // Joins during section B (7s to about 10.64s), on its own timer phase.
  const late = participantDevice();
  late.timers.advanceTo(7410);
  startOnPlan(late, plan);
  for (const target of [host, participant, late]) target.timers.advanceTo(20000);

  // One count-in bar, then each bar starts accented with its section's settings.
  const expected = planBeats(plan);
  expect(expected).toHaveLength(4 + 8 + 8 + 6);
  expect(heard(host.clicks)).toEqual(expected);
  expect(heard(participant.clicks)).toEqual(expected);
  expect(heard(late.clicks)).toEqual(expected.filter(([time]) => time >= 7.41));
  for (const target of [host, participant, late]) {
    expect(target.engine.endHostTime()).toBe(plan.endHostTime);
    expect(target.timers.intervalCount).toBe(0);
    expect(target.engine.nextStrongBeatHostTime(plan.endHostTime)).toBeNull();
  }
  expect(heard(host.clicks).at(-1)![0]).toBeCloseTo(plan.endHostTime - 0.6, 6);
});

// Host times are epoch seconds (about 1.8e9), where adding a beat length that is not a binary
// fraction (0.6s at 100 BPM) rounds every time. Beat times added up one by one drift off the
// plan's boundaries by more than the time epsilon within a few dozen beats.
test("a long song plan stays on its grid at epoch-scale host times, for a late joiner too", () => {
  const song: Song = {
    id: "song",
    title: "",
    sections: [
      { name: "A", bpm: 100, beatsPerBar: 3, beatUnit: 4, bars: 40 },
      { name: "B", bpm: 132, beatsPerBar: 4, beatUnit: 4, bars: 8 },
      { name: "C", bpm: 100, beatsPerBar: 3, beatUnit: 4, bars: 8 },
    ],
  };
  const startHostTime = 1_793_000_000.25;
  const plan = buildPlaybackPlan(song, { startSectionIndex: 0, startBar: 1, countInBars: 0, startHostTime });
  const beforeStartMs = (startHostTime - 1) * 1000;
  const host = device({ timerPhaseMs: beforeStartMs });
  host.engine.start(plan.config, plan.startHostTime, host.hostNow(), { changes: plan.changes, endHostTime: plan.endHostTime });
  const participant = device({ localOffset: -1000, timerPhaseMs: beforeStartMs + 7 });
  startOnPlan(participant, plan);
  // Joins 100 beats into section A.
  const late = device({ localOffset: -1000, timerPhaseMs: beforeStartMs + 1000 + 60_210 });
  startOnPlan(late, plan);
  const endMs = (plan.endHostTime + 1) * 1000;
  for (const target of [host, participant, late]) target.timers.advanceTo(endMs);

  const expected = planBeats(plan);
  expect(expected).toHaveLength(120 + 32 + 24);
  const expectOnGrid = (clicks: Click[], beats: [number, boolean][]) => {
    expect(clicks).toHaveLength(beats.length);
    clicks.forEach((click, index) => {
      expect(Math.abs(click.hostTime - beats[index]![0])).toBeLessThan(2e-6);
      expect(click.accented).toBe(beats[index]![1]);
    });
  };
  expectOnGrid(host.clicks, expected);
  expectOnGrid(participant.clicks, expected);
  expectOnGrid(late.clicks, expected.filter(([time]) => time >= startHostTime + 60.21));
  for (const target of [host, participant, late]) expect(target.timers.intervalCount).toBe(0);
});
