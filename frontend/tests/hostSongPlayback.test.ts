import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ControlMessage } from "../../shared/types.ts";
import { hostPlaybackState, songStartMessage } from "../host/songPlayback.ts";
import { HostWebRTC, type HostPlaybackState } from "../host/webrtc.ts";
import { pendingFromStart } from "../shared/metronome/configChange.ts";
import type { Song } from "../shared/song/model.ts";
import { buildPlaybackPlan, planMessage } from "../shared/song/plan.ts";
import { FakeRtc, type FakeDataChannel } from "./helpers/browser.ts";

/** Two bars at 240 4/4, then two at 180 3/4. */
const SONG: Song = {
  id: "song",
  title: "曲 1",
  sections: [
    { name: "A", bpm: 240, beatsPerBar: 4, beatUnit: 4, bars: 2 },
    { name: "", bpm: 180, beatsPerBar: 3, beatUnit: 4, bars: 2 },
  ],
};
const START_HOST_TIME = 1_793_000_002.5;
const PLAN = buildPlaybackPlan(SONG, { startSectionIndex: 0, startBar: 1, countInBars: 1, startHostTime: START_HOST_TIME });
const A = { bpm: 240, beatsPerBar: 4, beatUnit: 4 };
const APPLIED = { bpm: 96, beatsPerBar: 6, beatUnit: 8 };

/** Answers like the engine; records the times it was asked about. */
function schedulerStub(nextStrongBeat: number | null) {
  const asked: number[] = [];
  return {
    asked,
    nextStrongBeatHostTime(atHostTime: number): number | null {
      asked.push(atHostTime);
      return nextStrongBeat;
    },
  };
}

describe("song start message", () => {
  test("starts at the plan's start with its first settings and carries the plan", () => {
    const message = songStartMessage(PLAN, START_HOST_TIME - 2);
    expect(message).toEqual({
      type: "start", ...A, startHostTime: START_HOST_TIME, sentHostTime: START_HOST_TIME - 2, plan: planMessage(PLAN),
    });
    // Count-in, A, then the second section with its own settings, and the end after it.
    expect(message.plan!.segments.map((segment) => segment.kind)).toEqual(["countIn", "section", "section"]);
    expect(message.plan!.changes.map((change) => change.config)).toEqual([A, { bpm: 180, beatsPerBar: 3, beatUnit: 4 }]);
    expect(message.plan!.endHostTime).toBe(START_HOST_TIME + 1 + 2 + 2);
  });

  test("a participant receiving it keeps the changes and the end", () => {
    const received = JSON.parse(JSON.stringify(songStartMessage(PLAN, START_HOST_TIME - 2))) as Extract<ControlMessage, { type: "start" }>;
    const config = { bpm: received.bpm, beatsPerBar: received.beatsPerBar, beatUnit: received.beatUnit };
    expect(pendingFromStart(config, received.startHostTime, received.plan)).toEqual({
      config: A, startHostTime: START_HOST_TIME, startBeatInBar: 1, changes: PLAN.changes, endHostTime: PLAN.endHostTime,
    });
  });
});

describe("host playback state for late joiners", () => {
  test("while a song plays, the plan's original start and first settings with the plan", () => {
    const scheduler = schedulerStub(START_HOST_TIME + 4);
    const state = hostPlaybackState(
      { isPlaying: true, appliedConfig: APPLIED, startHostTime: START_HOST_TIME, activePlan: PLAN },
      scheduler,
      START_HOST_TIME + 3.2,
    );
    expect(state).toEqual({
      isPlaying: true, config: A, startHostTime: START_HOST_TIME, sentHostTime: START_HOST_TIME + 3.2, plan: planMessage(PLAN),
    });
    // Not the next strong beat: the participant rebuilds the grid from the plan.
    expect(scheduler.asked).toEqual([]);
  });

  test("the plain metronome sends the next strong beat with the applied settings and no plan", () => {
    const scheduler = schedulerStub(110);
    const playing = hostPlaybackState({ isPlaying: true, appliedConfig: APPLIED, startHostTime: 100, activePlan: null }, scheduler, 108.3);
    expect(playing).toEqual({ isPlaying: true, config: APPLIED, startHostTime: 110, sentHostTime: 108.3 });
    expect(scheduler.asked).toEqual([108.3]);
    // Before the scheduler has a grid, the start time itself.
    expect(hostPlaybackState({ isPlaying: true, appliedConfig: APPLIED, startHostTime: 100, activePlan: null }, schedulerStub(null), 99))
      .toMatchObject({ startHostTime: 100 });
    const stopped = hostPlaybackState({ isPlaying: false, appliedConfig: APPLIED, startHostTime: null, activePlan: PLAN }, scheduler, 120);
    expect(stopped).toEqual({ isPlaying: false, config: APPLIED, startHostTime: null, sentHostTime: 120 });
    expect("plan" in stopped).toBe(false);
  });
});

describe.serial("host snapshot while a song plays", () => {
  let rtc: FakeRtc;

  beforeEach(() => {
    rtc = new FakeRtc();
    rtc.install();
  });

  afterEach(() => {
    rtc.restore();
  });

  test("a participant joining mid-song gets the plan from its original start", async () => {
    let state: HostPlaybackState = hostPlaybackState(
      { isPlaying: true, appliedConfig: APPLIED, startHostTime: START_HOST_TIME, activePlan: PLAN },
      schedulerStub(null),
      START_HOST_TIME + 3.2,
    );
    const host = new HostWebRTC(() => {}, () => state);
    await host.addClient("client-1111bbbb", "Client 1");
    const peer = host.peers.get("client-1111bbbb")!;
    const control = peer.control as unknown as FakeDataChannel;
    control.readyState = "open";

    host.sendSnapshot(peer);
    state = hostPlaybackState({ isPlaying: false, appliedConfig: APPLIED, startHostTime: null, activePlan: null }, schedulerStub(null), START_HOST_TIME + 9);
    host.sendSnapshot(peer);

    const messages = control.sent.map((data) => JSON.parse(data) as ControlMessage);
    expect(messages).toEqual([
      {
        type: "state_snapshot", isPlaying: true, ...A, startHostTime: START_HOST_TIME, sentHostTime: START_HOST_TIME + 3.2,
        plan: planMessage(PLAN),
      },
      { type: "state_snapshot", isPlaying: false, ...APPLIED, startHostTime: null, sentHostTime: START_HOST_TIME + 9 },
    ] as ControlMessage[]);
  });
});
