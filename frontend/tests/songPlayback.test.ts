import { expect, test } from "bun:test";
import { pendingFromStart, pendingPlaybackAt, withConfigChange } from "../shared/metronome/configChange.ts";
import { MetronomeEngine } from "../shared/metronome/engine.ts";
import type { Song } from "../shared/song/model.ts";
import { buildPlaybackPlan, planMessage } from "../shared/song/plan.ts";
import { ManualTimers } from "./helpers/browser.ts";

/** 120 4/4 x2, 132 4/4 x2, 100 3/4 x2. */
const SONG: Song = {
  id: "song",
  title: "",
  sections: [
    { name: "A", bpm: 120, beatsPerBar: 4, beatUnit: 4, bars: 2 },
    { name: "B", bpm: 132, beatsPerBar: 4, beatUnit: 4, bars: 2 },
    { name: "C", bpm: 100, beatsPerBar: 3, beatUnit: 4, bars: 2 },
  ],
};
const PLAN = buildPlaybackPlan(SONG, { startSectionIndex: 0, startBar: 1, countInBars: 1, startHostTime: 1 });
// Received over the data channel.
const MESSAGE = JSON.parse(JSON.stringify(planMessage(PLAN))) as ReturnType<typeof planMessage>;
const B_START = PLAN.segments[2]!.fromHostTime;
const C_START = PLAN.segments[3]!.fromHostTime;

test("a start with a plan keeps its changes and end until playback can start", () => {
  const pending = pendingFromStart(PLAN.config, PLAN.startHostTime, MESSAGE);
  expect(pending).toEqual({
    config: PLAN.config, startHostTime: 1, startBeatInBar: 1, changes: PLAN.changes, endHostTime: PLAN.endHostTime,
  });
  // The plan's own list is not shared, so queueing changes later cannot alter it.
  expect(pending.changes).not.toBe(MESSAGE.changes);

  // Starting later, the section being played is the start and the end stays.
  expect(pendingPlaybackAt(pending, B_START + 0.1)).toEqual({
    config: PLAN.segments[2]!.config, startHostTime: B_START, startBeatInBar: 1,
    changes: [PLAN.changes[2]!], endHostTime: PLAN.endHostTime,
  });
  expect(pendingPlaybackAt(pending, C_START)).toMatchObject({ startHostTime: C_START, changes: [], endHostTime: PLAN.endHostTime });
  expect(pendingPlaybackAt(pending, 0).endHostTime).toBe(PLAN.endHostTime);
});

test("a config change keeps the planned end", () => {
  const pending = pendingFromStart(PLAN.config, PLAN.startHostTime, MESSAGE);
  const sixty = { bpm: 60, beatsPerBar: 4, beatUnit: 4 };
  expect(withConfigChange(pending, sixty, null).endHostTime).toBe(PLAN.endHostTime);
  expect(withConfigChange(pending, sixty, { applyAtHostTime: 0.5, beatInBarAtApply: 1 }).endHostTime).toBe(PLAN.endHostTime);
  expect(withConfigChange(pending, sixty, { applyAtHostTime: 9, beatInBarAtApply: 1 }).endHostTime).toBe(PLAN.endHostTime);
});

test("a start without a plan has no end, as before", () => {
  const config = { bpm: 120, beatsPerBar: 4, beatUnit: 4 };
  const pending = pendingFromStart(config, 1);
  expect(pending).toEqual({ config, startHostTime: 1, startBeatInBar: 1, changes: [] });
  expect("endHostTime" in pending).toBe(false);
  expect("endHostTime" in pendingPlaybackAt(withConfigChange(pending, config, { applyAtHostTime: 3, beatInBarAtApply: 1 }), 4)).toBe(false);
});

/** An engine on a shared clock (timers.nowMs is host time in ms); clicks are recorded in host time. */
function device(localOffset: number, timerPhaseMs: number) {
  const timers = new ManualTimers();
  timers.nowMs = timerPhaseMs;
  const clicks: [number, boolean][] = [];
  const engine = new MetronomeEngine({
    now: () => timers.nowMs / 1000 + localOffset,
    hostToLocalTime: (hostTime) => hostTime + localOffset,
    canSchedule: () => true,
    timers,
    audio: {
      currentTime: () => 50 + timers.nowMs / 1000,
      click: (time, accented) => clicks.push([Math.round((time - 50) * 1e6) / 1e6, accented]),
      outputLatency: () => 0,
    },
    vibration: { setEnabled() {}, schedule() {}, cancel() {} },
  });
  return { timers, clicks, engine, hostNow: () => timers.nowMs / 1000 };
}

test("a participant that gets the plan mid-song plays the rest of it with the host and ends with it", () => {
  const host = device(0, 0);
  host.engine.start(PLAN.config, PLAN.startHostTime, host.hostNow(), { changes: PLAN.changes, endHostTime: PLAN.endHostTime });

  // A snapshot during section B: the participant rebuilds the grid from the plan's original start.
  const participant = device(-1000, 7_410);
  const hostNow = participant.hostNow();
  const playback = pendingPlaybackAt(pendingFromStart(PLAN.config, PLAN.startHostTime, MESSAGE), hostNow);
  participant.engine.start(playback.config, playback.startHostTime, hostNow, {
    startBeatInBar: playback.startBeatInBar,
    changes: playback.changes,
    endHostTime: playback.endHostTime,
  });
  host.timers.advanceTo(20_000);
  participant.timers.advanceTo(20_000);

  expect(participant.clicks.length).toBeGreaterThan(8);
  expect(participant.clicks).toEqual(host.clicks.filter(([time]) => time >= hostNow));
  expect(participant.engine.endHostTime()).toBe(host.engine.endHostTime()!);
  expect(participant.timers.intervalCount).toBe(0);
});
