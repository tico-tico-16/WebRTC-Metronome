// Validation and routing rules for signaling messages. Kept free of Workers runtime imports so Bun tests can load it.
import type { PeerRole, SignalMessage } from "../../shared/types";

/** SDP offers are a few KB; anything far longer is not a real signaling message. */
export const MAX_SIGNAL_FRAME_LENGTH = 64 * 1024;
export const DEFAULT_MAX_PARTICIPANTS = 50;

/** Messages a peer may send to the server; the other types only go from the server to peers. */
export type PeerSignalMessage = Extract<SignalMessage, { type: "register" | "offer" | "answer" | "ice" }>;

export type SignalParseResult =
  | { ok: true; message: PeerSignalMessage }
  | {
      ok: false;
      reason: "binary_frame" | "too_large" | "invalid_json" | "unknown_type" | "invalid_fields";
      error: string;
    };

export type SignalTarget =
  | { kind: "host" }
  | { kind: "client"; clientId: string }
  | { kind: "forbidden"; reason: "client_to_client" | "host_to_self"; error: string };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isTarget(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSessionDescription(value: unknown): value is RTCSessionDescriptionInit {
  return isObject(value) && typeof value.type === "string" && isOptionalString(value.sdp);
}

function isIceCandidate(value: unknown): value is RTCIceCandidateInit {
  return isObject(value) && isOptionalString(value.candidate);
}

function readMessage(value: JsonObject): PeerSignalMessage | null {
  switch (value.type) {
    case "register": {
      const { role, name, roomId } = value;
      if ((role !== "host" && role !== "client") || !isOptionalString(name) || !isOptionalString(roomId)) return null;
      return {
        type: "register",
        role,
        ...(name === undefined ? {} : { name }),
        ...(roomId === undefined ? {} : { roomId }),
      };
    }
    case "offer":
    case "answer": {
      const { to, sdp } = value;
      if (!isTarget(to) || !isSessionDescription(sdp)) return null;
      return { type: value.type, to, sdp };
    }
    case "ice": {
      const { to, candidate } = value;
      if (!isTarget(to) || !isIceCandidate(candidate)) return null;
      return { type: "ice", to, candidate };
    }
    default:
      return null;
  }
}

const PEER_MESSAGE_TYPES = new Set<unknown>(["register", "offer", "answer", "ice"]);

/**
 * Checks a raw WebSocket frame from a peer. Only the fields the server understands are kept,
 * so extra fields a peer adds never reach the other side (the server sets `from` itself).
 */
export function parseSignalMessage(raw: string | ArrayBuffer): SignalParseResult {
  if (typeof raw !== "string") {
    return { ok: false, reason: "binary_frame", error: "Signaling messages must be text." };
  }
  if (raw.length > MAX_SIGNAL_FRAME_LENGTH) {
    return { ok: false, reason: "too_large", error: "Signaling message is too large." };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_json", error: "Signaling message is not valid JSON." };
  }

  if (!isObject(value) || !PEER_MESSAGE_TYPES.has(value.type)) {
    return { ok: false, reason: "unknown_type", error: "Unknown signaling message type." };
  }

  const message = readMessage(value);
  if (!message) {
    return { ok: false, reason: "invalid_fields", error: `Invalid ${String(value.type)} message.` };
  }
  return { ok: true, message };
}

/**
 * Participants may only signal the host: an offer from another participant would replace
 * their connection to the host. The host addresses participants by id, never itself.
 */
export function resolveSignalTarget(senderRole: PeerRole, to: string, hostId: string): SignalTarget {
  const toHost = to === "host" || to === hostId;
  if (senderRole === "client") {
    return toHost
      ? { kind: "host" }
      : { kind: "forbidden", reason: "client_to_client", error: "Participants can only signal the host." };
  }
  return toHost
    ? { kind: "forbidden", reason: "host_to_self", error: "The host cannot signal itself." }
    : { kind: "client", clientId: to };
}

/** Reads the `MAX_PARTICIPANTS` var; anything but a positive integer falls back to the default. */
export function parseMaxParticipants(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PARTICIPANTS;
}
