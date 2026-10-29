import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import type { SignalMessage } from "../../shared/types.ts";
import { ClientWebRTC } from "../client/webrtc.ts";
import { HostWebRTC } from "../host/webrtc.ts";
import { isHostPeerId } from "../shared/peerSignals.ts";
import { FakeRtc } from "./helpers/browser.ts";

const HOST_ID = "host-0000aaaa";
const CLIENT_ID = "client-1111bbbb";

function candidate(index: number): RTCIceCandidateInit {
  return { candidate: `candidate:${index} 1 udp 2122260223 192.0.2.${index} 5000${index} typ host`, sdpMid: "0", sdpMLineIndex: 0 };
}

function ice(from: string, index: number): SignalMessage {
  return { type: "ice", to: "self", from, candidate: candidate(index) };
}

// The relay delivers signals in order, but each handler is started without waiting for the previous one,
// so candidates can arrive while setRemoteDescription is still pending.
describe.serial("WebRTC signal handling", () => {
  let rtc: FakeRtc;
  let warn: Mock<typeof console.warn>;
  let sent: SignalMessage[];

  beforeEach(() => {
    rtc = new FakeRtc();
    rtc.install();
    warn = spyOn(console, "warn").mockImplementation(() => {});
    sent = [];
  });

  afterEach(() => {
    warn.mockRestore();
    rtc.restore();
  });

  describe("host", () => {
    async function createHost() {
      const host = new HostWebRTC((message) => sent.push(message), () => ({
        isPlaying: false,
        config: { bpm: 120, beatsPerBar: 4, beatUnit: 4 },
        startHostTime: null,
        sentHostTime: 0,
      }));
      await host.addClient(CLIENT_ID, "Client 1");
      return { host, pc: rtc.connections[0]! };
    }

    const answer: SignalMessage = { type: "answer", to: HOST_ID, from: CLIENT_ID, sdp: { type: "answer", sdp: "answer-sdp" } };

    test("adds candidates that arrive before the answer is applied, in order, then later ones at once", async () => {
      const { host, pc } = await createHost();
      const answered = host.handleSignal(answer);
      const early = [host.handleSignal(ice(CLIENT_ID, 1)), host.handleSignal(ice(CLIENT_ID, 2))];
      expect(pc.addedCandidates).toEqual([]);

      pc.applyRemoteDescription();
      await Promise.all([answered, ...early]);
      expect(pc.addedCandidates).toEqual([candidate(1), candidate(2)]);

      await host.handleSignal(ice(CLIENT_ID, 3));
      expect(pc.addedCandidates).toEqual([candidate(1), candidate(2), candidate(3)]);
      expect(warn).not.toHaveBeenCalled();
    });

    test("marks the participant failed without rejecting when the answer cannot be applied", async () => {
      const { host, pc } = await createHost();
      let changes = 0;
      host.onChange(() => { changes += 1; });
      const answered = host.handleSignal(answer);
      const early = host.handleSignal(ice(CLIENT_ID, 1));

      pc.rejectRemoteDescription();
      await expect(answered).resolves.toBeUndefined();
      await expect(early).resolves.toBeUndefined();
      expect(host.peers.get(CLIENT_ID)!.status).toBe("failed");
      expect(changes).toBe(1);
      expect(pc.addedCandidates).toEqual([]);
      expect(String(warn.mock.calls[0]![0])).toContain(CLIENT_ID);
    });

    test("logs a candidate the connection rejects and keeps adding the rest", async () => {
      const { host, pc } = await createHost();
      pc.invalidCandidates.add(candidate(1).candidate!);
      const answered = host.handleSignal(answer);
      const early = [host.handleSignal(ice(CLIENT_ID, 1)), host.handleSignal(ice(CLIENT_ID, 2))];

      pc.applyRemoteDescription();
      await Promise.all([answered, ...early]);
      expect(pc.addedCandidates).toEqual([candidate(2)]);
      expect(host.peers.get(CLIENT_ID)!.status).toBe("connecting");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(CLIENT_ID);
    });
  });

  describe("participant", () => {
    const offer: SignalMessage = { type: "offer", to: CLIENT_ID, from: HOST_ID, sdp: { type: "offer", sdp: "offer-sdp" } };

    function createClient() {
      const client = new ClientWebRTC((message) => sent.push(message));
      const states: string[] = [];
      client.onState((state) => states.push(state));
      return { client, states };
    }

    test("adds candidates that arrive before the offer is applied, in order, then later ones at once", async () => {
      const { client, states } = createClient();
      const accepted = client.handleSignal(offer);
      const pc = rtc.connections[0]!;
      const early = [client.handleSignal(ice(HOST_ID, 1)), client.handleSignal(ice(HOST_ID, 2))];
      expect(pc.addedCandidates).toEqual([]);

      pc.applyRemoteDescription();
      await Promise.all([accepted, ...early]);
      expect(pc.addedCandidates).toEqual([candidate(1), candidate(2)]);
      expect(sent).toEqual([{ type: "answer", to: "host", sdp: { type: "answer", sdp: "answer-sdp" } }]);

      await client.handleSignal(ice(HOST_ID, 3));
      expect(pc.addedCandidates).toEqual([candidate(1), candidate(2), candidate(3)]);
      expect(states).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    test("reports failed without rejecting when the offer cannot be applied", async () => {
      const { client, states } = createClient();
      const accepted = client.handleSignal(offer);
      const pc = rtc.connections[0]!;
      const early = client.handleSignal(ice(HOST_ID, 1));

      pc.rejectRemoteDescription();
      await expect(accepted).resolves.toBeUndefined();
      await expect(early).resolves.toBeUndefined();
      expect(states).toEqual(["failed"]);
      expect(sent).toEqual([]);
      expect(pc.addedCandidates).toEqual([]);
      expect(String(warn.mock.calls[0]![0])).toContain(HOST_ID);
    });

    test("does not report the failure of an offer replaced by a newer one", async () => {
      const { client, states } = createClient();
      const first = client.handleSignal(offer);
      const second = client.handleSignal(offer);
      const [oldPc, newPc] = rtc.connections;
      expect(oldPc!.closed).toBe(true);

      oldPc!.rejectRemoteDescription(new DOMException("The connection was closed", "InvalidStateError"));
      newPc!.applyRemoteDescription();
      await Promise.all([first, second]);
      expect(states).toEqual([]);
      expect(sent).toHaveLength(1);
    });
  });
});

describe("signal sender", () => {
  test("participants accept connection signals only from the host", () => {
    expect(isHostPeerId(HOST_ID)).toBe(true);
    expect(isHostPeerId(CLIENT_ID)).toBe(false);
    expect(isHostPeerId("hostile-1234abcd")).toBe(false);
    expect(isHostPeerId("host")).toBe(false);
    expect(isHostPeerId(undefined)).toBe(false);
  });
});
