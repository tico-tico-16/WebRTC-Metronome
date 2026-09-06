import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MetronomeConfig } from "../../shared/types.ts";
import { HostMetronomeScheduler, beatAtHostTime as hostBeatAtTime, secondsPerBeat as hostBeatLength } from "../host/metronome.ts";
import { MetronomeScheduler, beatAtHostTime as clientBeatAtTime, secondsPerBeat as clientBeatLength } from "../client/metronome.ts";
import { FakeBrowser } from "./helpers/browser.ts";

const config: MetronomeConfig = { bpm: 120, beatsPerBar: 4, beatUnit: 4 };
type Role = "host" | "client";

// These tests exercise the public API, first against the original implementations.
// Serial suites also protect the temporary browser globals with --concurrent.
describe.serial("metronome public behavior", () => {
  let browser: FakeBrowser;
  beforeEach(() => { browser = new FakeBrowser(); browser.install(); });
  afterEach(() => browser.restore());

  function create(role: Role, hostOffset = () => 0) {
    const scheduler = role === "host" ? new HostMetronomeScheduler() : new MetronomeScheduler();
    return {
      scheduler,
      async start(nextConfig = config, startHostTime = 1, hostNow = browser.timers.nowMs / 1000 + hostOffset()) {
        if (scheduler instanceof HostMetronomeScheduler) {
          await scheduler.start(nextConfig, startHostTime, hostNow);
        } else {
          await scheduler.enableAudio();
          scheduler.start(nextConfig, startHostTime, hostNow, (time) => time - hostOffset());
        }
      },
    };
  }

  function expectClickTimes(times: number[]) {
    expect(browser.clicks).toHaveLength(times.length);
    times.forEach((time, index) => expect(browser.clicks[index]!.time).toBeCloseTo(100 + time, 8));
  }

  for (const role of ["host", "client"] as const) {
    describe(role, () => {
      for (const beatsPerBar of [0, 1, 3, 4]) {
        test(`generates beats and accents with meter ${beatsPerBar}`, async () => {
          const { scheduler, start } = create(role);
          await start({ ...config, beatsPerBar });
          expect(scheduler.beatAtHostTime(0.9)).toBeNull();
          browser.timers.advanceTo(3500);
          expectClickTimes([1, 1.5, 2, 2.5, 3, 3.5]);
          const expectedAccents: Record<number, boolean[]> = {
            0: [false, false, false, false, false, false],
            1: [true, true, true, true, true, true],
            3: [true, false, false, true, false, false],
            4: [true, false, false, false, true, false],
          };
          expect(browser.clicks.map((click) => click.accented)).toEqual(expectedAccents[beatsPerBar]!);
          expect(scheduler.beatAtHostTime(1.499)).toEqual({ beatIndex: 0, beatInBar: beatsPerBar ? 1 : 0, secondsPerBeat: 0.5 });
          expect(scheduler.beatAtHostTime(1.5)).toEqual({ beatIndex: 1, beatInBar: beatsPerBar === 0 ? 0 : beatsPerBar === 1 ? 1 : 2, secondsPerBeat: 0.5 });
        });
      }

      test("starts on the next beat when joining late", async () => {
        browser.timers.nowMs = 1600;
        const { scheduler, start } = create(role);
        await start();
        browser.timers.advanceTo(2400);
        expectClickTimes([2, 2.5]);
        expect(scheduler.beatAtHostTime(2)).toEqual({ beatIndex: 2, beatInBar: 3, secondsPerBeat: 0.5 });
      });

      test("includes a beat when starting exactly on its boundary", async () => {
        browser.timers.nowMs = 1500;
        const { start } = create(role);
        await start();
        expectClickTimes([1.5]);
      });

      test("uses a 25ms interval and includes the 180ms lookahead boundary", async () => {
        const { start } = create(role);
        await start();
        browser.timers.advanceTo(800);
        expectClickTimes([]);
        browser.timers.advanceTo(824);
        expectClickTimes([]);
        browser.timers.advanceTo(825);
        expectClickTimes([1]);
        browser.timers.runIntervalsAt(1319);
        expectClickTimes([1]);
        browser.timers.runIntervalsAt(1320);
        expectClickTimes([1, 1.5]);
      });

      test("skips beats more than 20ms late after a stalled timer", async () => {
        const { scheduler, start } = create(role);
        await start();
        browser.timers.runIntervalsAt(1021);
        expectClickTimes([]);
        browser.timers.runIntervalsAt(1519);
        expectClickTimes([1.5]);
        expect(scheduler.beatAtHostTime(1.5)?.beatIndex).toBe(1);
      });

      test("includes a beat exactly 20ms late", async () => {
        const { start } = create(role);
        await start();
        browser.timers.runIntervalsAt(1020);
        expectClickTimes([1]);
      });

      for (const offsetMs of [-200, 0, 200]) {
        test(`applies ${offsetMs}ms output correction only to audio time`, async () => {
          const { scheduler, start } = create(role);
          scheduler.setOutputOffsetMs(offsetMs);
          await start();
          browser.timers.advanceTo(3600);
          expectClickTimes([1, 1.5, 2, 2.5, 3, 3.5].map((time) => time + offsetMs / 1000));
          expect(scheduler.beatAtHostTime(3)).toEqual({ beatIndex: 4, beatInBar: 1, secondsPerBeat: 0.5 });
        });
      }

      test("preserves the next beat when tempo changes", async () => {
        const { scheduler, start } = create(role);
        await start();
        browser.timers.advanceTo(1800);
        scheduler.updateConfig({ ...config, bpm: 60 });
        browser.timers.advanceTo(3900);
        expectClickTimes([1, 1.5, 2, 3, 4]);
        expect(scheduler.beatAtHostTime(1.5)?.secondsPerBeat).toBe(0.5);
        expect(scheduler.beatAtHostTime(2)?.secondsPerBeat).toBe(1);
      });

      test("applies changed output correction to subsequent reservations", async () => {
        const { scheduler, start } = create(role);
        await start();
        browser.timers.advanceTo(1400);
        scheduler.setOutputOffsetMs(100);
        browser.timers.advanceTo(2000);
        expectClickTimes([1, 1.5, 2.1]);
        expect(scheduler.beatAtHostTime(2)?.beatIndex).toBe(2);
      });

      test("clamps the next position on meter changes and handles unmetered playback", async () => {
        const { scheduler, start } = create(role);
        await start();
        browser.timers.advanceTo(2100);
        scheduler.updateConfig({ ...config, beatsPerBar: 3 });
        browser.timers.advanceTo(2400);
        expect(scheduler.beatAtHostTime(2.5)?.beatInBar).toBe(1);
        scheduler.updateConfig({ ...config, beatsPerBar: 0 });
        browser.timers.advanceTo(2900);
        expect(scheduler.beatAtHostTime(3)?.beatInBar).toBe(0);
        scheduler.updateConfig({ ...config, beatsPerBar: 4 });
        browser.timers.advanceTo(3400);
        expect(scheduler.beatAtHostTime(3.5)?.beatInBar).toBe(1);
      });

      test("retains only 64 scheduled beats for lookup", async () => {
        const { scheduler, start } = create(role);
        await start();
        browser.timers.advanceTo(33500);
        expect(browser.clicks).toHaveLength(66);
        expect(scheduler.beatAtHostTime(1.5)).toBeNull();
        expect(scheduler.beatAtHostTime(2)?.beatIndex).toBe(2);
      });

      test("reuses the audio context and replaces the interval on restart", async () => {
        const { start } = create(role);
        await start();
        await start(config, 2);
        expect(browser.contexts).toHaveLength(1);
        expect(browser.timers.intervalCount).toBe(1);
        expect(browser.timers.clearedIntervals).toHaveLength(1);
        browser.timers.advanceTo(2400);
        expectClickTimes([2, 2.5]);
      });

      test("generates the existing strong and weak click envelopes", async () => {
        const { start } = create(role);
        await start();
        browser.timers.advanceTo(1400);
        const context = browser.contexts[0]!;
        for (const [index, frequency, peak, time] of [[0, 1000, 0.42, 101], [1, 700, 0.28, 101.5]] as const) {
          const oscillator = context.oscillators[index]!;
          const gain = context.gains[index]!;
          expect(oscillator.type).toBe("sine");
          expect(oscillator.frequency.events).toEqual([{ method: "set", value: frequency, time }]);
          expect(gain.gain.events).toEqual([
            { method: "set", value: 0.0001, time },
            { method: "ramp", value: peak, time: time + 0.004 },
            { method: "ramp", value: 0.0001, time: time + 0.07 },
          ]);
          expect(oscillator.starts).toEqual([time]);
          expect(oscillator.stops).toEqual([time + 0.08]);
          expect(oscillator.destination).toBe(gain);
          expect(gain.destination).toBe(context.destination);
        }
      });

      test("aligns vibration with corrected audio and cancels it when disabled", async () => {
        const { scheduler, start } = create(role);
        scheduler.setOutputOffsetMs(100);
        scheduler.setVibrationEnabled(true);
        await start();
        browser.timers.advanceTo(1620);
        expect(browser.vibrations.map((event) => event.durationMs)).toEqual([60, 25]);
        expect(browser.vibrations[0]!.atMs).toBeCloseTo(1100, 6);
        expect(browser.vibrations[1]!.atMs).toBeCloseTo(1600, 6);
        browser.timers.advanceTo(1950);
        expect(browser.timers.timeoutCount).toBe(1);
        scheduler.setVibrationEnabled(false);
        expect(browser.timers.timeoutCount).toBe(0);
        browser.timers.advanceTo(2600);
        expect(browser.vibrations.map((event) => event.durationMs)).toEqual([60, 25, 0]);
      });

      test("does not schedule vibration on unsupported devices", async () => {
        browser.install(false);
        const { scheduler, start } = create(role);
        scheduler.setVibrationEnabled(true);
        await start();
        browser.timers.advanceTo(900);
        expect(browser.timers.timeoutCount).toBe(0);
        scheduler.stop();
        expect(browser.vibrations).toEqual([]);
      });

      test("stop clears scheduling, vibration and beat lookup, then allows a new start", async () => {
        const { scheduler, start } = create(role);
        scheduler.setVibrationEnabled(true);
        await start();
        browser.timers.advanceTo(900);
        expect(browser.clicks).toHaveLength(1);
        expect(browser.timers.timeoutCount).toBe(1);
        scheduler.stop();
        scheduler.stop();
        expect(browser.timers.intervalCount).toBe(0);
        expect(browser.timers.timeoutCount).toBe(0);
        expect(scheduler.beatAtHostTime(1)).toBeNull();
        browser.timers.advanceTo(3000);
        expect(browser.clicks).toHaveLength(1);
        expect(browser.vibrations.every((event) => event.durationMs === 0)).toBe(true);
        await start(config, 4);
        browser.timers.advanceTo(3900);
        expectClickTimes([1, 4]);
      });
    });
  }

  test("host and client produce the same musical beats despite clock difference and correction", async () => {
    const host = new HostMetronomeScheduler();
    const client = new MetronomeScheduler();
    await host.start(config, 8, 0);
    await client.enableAudio();
    client.setOutputOffsetMs(150);
    client.start(config, 8, 7, (time) => time - 7);
    browser.timers.advanceTo(8500);
    const hostBeats = browser.contexts[0]!.oscillators.map((oscillator) => oscillator.starts[0]! - 100);
    const clientBeats = browser.contexts[1]!.oscillators.map((oscillator) => oscillator.starts[0]! - 100 + 7 - 0.15)
      .filter((time) => time <= 8.500001);
    expect(hostBeats).toEqual([8, 8.5]);
    expect(clientBeats).toHaveLength(hostBeats.length);
    hostBeats.forEach((time, index) => expect(clientBeats[index]!).toBeCloseTo(time, 8));
    expect(host.beatAtHostTime(8.5)).toEqual(client.beatAtHostTime(8.5));
  });

  test("evaluates the client clock conversion again for later reservations", async () => {
    let offset = 7;
    const { scheduler, start } = create("client", () => offset);
    await start(config, 8);
    browser.timers.advanceTo(900);
    offset = 7.1;
    browser.timers.advanceTo(1300);
    expectClickTimes([1, 1.4]);
    expect(scheduler.beatAtHostTime(8.5)).toEqual({ beatIndex: 1, beatInBar: 2, secondsPerBeat: 0.5 });
  });

  test("host start waits for audio and propagates resume failure", async () => {
    const resume = Promise.withResolvers<void>();
    browser.resumeAudio = () => resume.promise;
    const host = new HostMetronomeScheduler();
    const starting = host.start(config, 1, 0);
    expect(browser.timers.intervalCount).toBe(0);
    resume.resolve();
    await starting;
    expect(browser.timers.intervalCount).toBe(1);
    host.stop();
    browser.resumeAudio = () => Promise.reject(new Error("audio denied"));
    await expect(host.start(config, 1, 0)).rejects.toThrow("audio denied");
    expect(browser.timers.intervalCount).toBe(0);
  });

  test("client start stays synchronous and waits for a running, enabled context to schedule", async () => {
    const client = new MetronomeScheduler();
    expect(client.start(config, 1, 0, (time) => time)).toBeUndefined();
    browser.timers.advanceTo(850);
    expect(browser.contexts).toHaveLength(0);
    expect(client.isAudioEnabled()).toBe(false);
    const resume = Promise.withResolvers<void>();
    browser.resumeAudio = () => resume.promise;
    const enabling = client.enableAudio();
    browser.timers.advanceTo(900);
    expectClickTimes([]);
    resume.resolve();
    await enabling;
    expect(client.isAudioEnabled()).toBe(true);
    browser.timers.advanceTo(925);
    expectClickTimes([1]);
    browser.contexts[0]!.state = "suspended";
    expect(client.isAudioEnabled()).toBe(false);
    browser.timers.advanceTo(1400);
    expectClickTimes([1]);
  });

  test("client audio failure rejects without enabling playback", async () => {
    browser.resumeAudio = () => Promise.reject(new Error("audio denied"));
    const client = new MetronomeScheduler();
    await expect(client.enableAudio()).rejects.toThrow("audio denied");
    expect(client.isAudioEnabled()).toBe(false);
    client.start(config, 1, 0, (time) => time);
    browser.timers.advanceTo(1400);
    expectClickTimes([]);
  });

  test("host retains its context-based scheduling gate after audio is suspended", async () => {
    const host = new HostMetronomeScheduler();
    await host.start(config, 1, 0);
    browser.contexts[0]!.state = "suspended";
    browser.timers.advanceTo(900);
    expectClickTimes([1]);
  });

  test("host strong-beat lookup supplies a late participant's start time", async () => {
    const host = new HostMetronomeScheduler();
    expect(host.nextStrongBeatHostTime(0)).toBeNull();
    await host.start(config, 1, 0);
    expect(host.nextStrongBeatHostTime(0)).toBe(1);
    browser.timers.advanceTo(1600);
    const joinTime = host.nextStrongBeatHostTime(1.6)!;
    expect(joinTime).toBe(3);
    const client = new MetronomeScheduler();
    await client.enableAudio();
    client.start(config, joinTime, 1.6, (time) => time);
    browser.timers.advanceTo(2900);
    expect(host.nextStrongBeatHostTime(2.9)).toBe(3);
    expect(browser.contexts[1]!.oscillators[0]!.starts).toEqual([103]);
    expect(client.beatAtHostTime(3)?.beatInBar).toBe(1);
    host.updateConfig({ ...config, beatsPerBar: 0 });
    expect(host.nextStrongBeatHostTime(2.9)).toBe(3.5);
    host.stop();
    expect(host.nextStrongBeatHostTime(3)).toBeNull();
  });

  test("standalone beat helpers retain pre-start and unmetered behavior", () => {
    for (const [beatAtTime, beatLength] of [[hostBeatAtTime, hostBeatLength], [clientBeatAtTime, clientBeatLength]] as const) {
      expect(beatLength(config)).toBe(0.5);
      expect(beatAtTime(0, null, config)).toEqual({ beatIndex: 0, beatInBar: 1, secondsPerBeat: 0.5 });
      expect(beatAtTime(0.9, 1, { ...config, beatsPerBar: 0 }).beatInBar).toBe(1);
      expect(beatAtTime(1, 1, { ...config, beatsPerBar: 0 }).beatInBar).toBe(0);
      expect(beatAtTime(3, 1, config)).toEqual({ beatIndex: 4, beatInBar: 1, secondsPerBeat: 0.5 });
    }
  });
});
