export type PeerRole = "host" | "client";

export type SignalMessage =
  | { type: "register"; role: PeerRole; name?: string }
  | { type: "registered"; role: PeerRole; id: string; hostPresent: boolean }
  | { type: "host_available"; hostPresent: boolean }
  | { type: "client_joined"; clientId: string; name: string }
  | { type: "client_left"; clientId: string }
  | { type: "offer"; to: string; from?: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; to: string; from?: string; sdp: RTCSessionDescriptionInit }
  | { type: "ice"; to: string; from?: string; candidate: RTCIceCandidateInit }
  | { type: "error"; message: string };

export type MeterKey = "3/4" | "4/4" | "5/4" | "6/8";

export type MetronomeConfig = {
  bpm: number;
  beatsPerBar: number;
  beatUnit: number;
};

export type ControlMessage =
  | ({ type: "config" } & MetronomeConfig)
  | ({ type: "start"; startHostTime: number; sentHostTime: number } & MetronomeConfig)
  | { type: "stop"; sentHostTime: number }
  | ({
      type: "state_snapshot";
      isPlaying: boolean;
      startHostTime: number | null;
      sentHostTime: number;
    } & MetronomeConfig);

export type SyncMessage =
  | { type: "ping"; id: number; clientSendTime: number }
  | { type: "pong"; id: number; clientSendTime: number; hostReceiveTime: number; hostSendTime: number }
  | { type: "sync_report"; rtt: number; offset: number; jitter: number; sampleCount: number };

export type BeatInfo = {
  beatIndex: number;
  beatInBar: number;
  secondsPerBeat: number;
};
