import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_PARTICIPANTS,
  MAX_SIGNAL_FRAME_LENGTH,
  parseMaxParticipants,
  parseSignalMessage,
  resolveSignalTarget,
} from "../src/protocol.ts";

const sdp: RTCSessionDescriptionInit = { type: "offer", sdp: "v=0" };
const candidate = { candidate: "candidate:1 1 udp 1 192.168.1.20 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 };

function parse(value: unknown) {
  return parseSignalMessage(JSON.stringify(value));
}

describe("signal message parsing", () => {
  test("accepts register messages for both roles", () => {
    expect(parse({ type: "register", role: "host", name: "Host" }))
      .toEqual({ ok: true, message: { type: "register", role: "host", name: "Host" } });
    expect(parse({ type: "register", role: "client", roomId: "room1", name: "Client 7" }))
      .toEqual({ ok: true, message: { type: "register", role: "client", roomId: "room1", name: "Client 7" } });
    expect(parse({ type: "register", role: "client" }))
      .toEqual({ ok: true, message: { type: "register", role: "client" } });
  });

  test("accepts offer, answer and ice and drops other fields", () => {
    expect(parse({ type: "offer", to: "client-1", sdp, from: "spoofed", extra: true }))
      .toEqual({ ok: true, message: { type: "offer", to: "client-1", sdp } });
    expect(parse({ type: "answer", to: "host", sdp: { type: "answer", sdp: "v=0" } }))
      .toEqual({ ok: true, message: { type: "answer", to: "host", sdp: { type: "answer", sdp: "v=0" } } });
    expect(parse({ type: "ice", to: "host", candidate }))
      .toEqual({ ok: true, message: { type: "ice", to: "host", candidate } });
  });

  test("rejects frames that are not text, too large or not JSON", () => {
    expect(parseSignalMessage(new ArrayBuffer(8))).toMatchObject({ ok: false, reason: "binary_frame" });
    expect(parseSignalMessage("{not json")).toMatchObject({ ok: false, reason: "invalid_json" });
    expect(parseSignalMessage("ping")).toMatchObject({ ok: false, reason: "invalid_json" });

    const frame = (length: number) => JSON.stringify({ type: "ice", to: "host", candidate: { candidate: "x".repeat(length) } });
    const overhead = frame(0).length;
    expect(frame(MAX_SIGNAL_FRAME_LENGTH - overhead)).toHaveLength(MAX_SIGNAL_FRAME_LENGTH);
    expect(parseSignalMessage(frame(MAX_SIGNAL_FRAME_LENGTH - overhead)).ok).toBe(true);
    expect(parseSignalMessage(frame(MAX_SIGNAL_FRAME_LENGTH - overhead + 1))).toMatchObject({ ok: false, reason: "too_large" });
  });

  test("rejects unknown and server-only message types", () => {
    const values = [null, [], 42, "offer", {}, { type: 1 }, { type: "hello" }, { type: "registered", role: "host" }, { type: "error", message: "x" }];
    for (const value of values) {
      expect(parse(value)).toMatchObject({ ok: false, reason: "unknown_type" });
    }
  });

  test("rejects messages with missing or mistyped fields", () => {
    const invalid = [
      { type: "register" },
      { type: "register", role: "admin" },
      { type: "register", role: "host", name: 5 },
      { type: "register", role: "client", roomId: ["room1"] },
      { type: "offer", sdp },
      { type: "offer", to: "", sdp },
      { type: "offer", to: 7, sdp },
      { type: "offer", to: "client-1" },
      { type: "offer", to: "client-1", sdp: "v=0" },
      { type: "offer", to: "client-1", sdp: { sdp: "v=0" } },
      { type: "offer", to: "client-1", sdp: { type: "offer", sdp: 1 } },
      { type: "answer", to: "host", sdp: null },
      { type: "answer", to: "host", sdp: [sdp] },
      { type: "ice", to: "host" },
      { type: "ice", to: "host", candidate: "candidate:1" },
      { type: "ice", to: "host", candidate: { candidate: 1 } },
    ];
    for (const value of invalid) {
      expect(parse(value)).toEqual({ ok: false, reason: "invalid_fields", error: `Invalid ${value.type} message.` });
    }
  });
});

describe("signal routing", () => {
  test("lets a participant address only the host, by alias or id", () => {
    expect(resolveSignalTarget("client", "host", "host-1")).toEqual({ kind: "host" });
    expect(resolveSignalTarget("client", "host-1", "host-1")).toEqual({ kind: "host" });
    expect(resolveSignalTarget("client", "client-2", "host-1"))
      .toMatchObject({ kind: "forbidden", reason: "client_to_client" });
  });

  test("lets the host address participants but not itself", () => {
    expect(resolveSignalTarget("host", "client-2", "host-1")).toEqual({ kind: "client", clientId: "client-2" });
    expect(resolveSignalTarget("host", "host", "host-1")).toMatchObject({ kind: "forbidden", reason: "host_to_self" });
    expect(resolveSignalTarget("host", "host-1", "host-1")).toMatchObject({ kind: "forbidden", reason: "host_to_self" });
  });
});

describe("participant cap", () => {
  test("reads MAX_PARTICIPANTS and falls back to 50", () => {
    expect(DEFAULT_MAX_PARTICIPANTS).toBe(50);
    expect(parseMaxParticipants("12")).toBe(12);
    expect(parseMaxParticipants(8)).toBe(8);
    for (const value of [undefined, "", "abc", "0", "-3", "2.5", 0, Number.NaN]) {
      expect(parseMaxParticipants(value)).toBe(50);
    }
  });
});
