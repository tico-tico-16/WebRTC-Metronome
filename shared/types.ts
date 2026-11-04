export type PeerRole = "host" | "client";

export type SignalMessage =
  | { type: "register"; role: PeerRole; name?: string; roomId?: string }
  | {
      type: "registered";
      role: PeerRole;
      id: string;
      roomId: string;
      hostPresent: boolean;
      participantUrl?: string;
    }
  | { type: "host_available"; hostPresent: boolean }
  | { type: "client_joined"; clientId: string; name: string }
  | { type: "client_left"; clientId: string }
  | { type: "offer"; to: string; from?: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; to: string; from?: string; sdp: RTCSessionDescriptionInit }
  | { type: "ice"; to: string; from?: string; candidate: RTCIceCandidateInit }
  | { type: "error"; message: string };

export type MetronomeConfig = {
  bpm: number;
  beatsPerBar: number;
  beatUnit: number;
};

/**
 * Where changed settings take effect while playing: from the beat at applyAtHostTime, which is beat
 * beatInBarAtApply (1-based, 0 without accents) of its bar. The host sends 0 for both when it is not
 * playing, as there is no beat to switch on.
 */
export type ConfigChangeAnchor = {
  applyAtHostTime: number;
  beatInBarAtApply: number;
};

/** Settings that take effect from an anchor beat. */
export type ConfigChange = ConfigChangeAnchor & { config: MetronomeConfig };

/**
 * One stretch of a song plan, in host seconds: a count-in, or one section (the first may start on a
 * later bar). firstBarInSong is the song's bar number of its first bar, 0 for a count-in, which is
 * not counted.
 */
export type PlanSegment = {
  kind: "countIn" | "section";
  sectionIndex: number;
  name: string;
  config: MetronomeConfig;
  fromHostTime: number;
  toHostTime: number;
  bars: number;
  firstBarInSong: number;
};

/**
 * A song played from a start: the changes at each segment boundary after the first segment, the
 * time playback ends, the segments for the display, and the song's bar count. The start time and
 * first settings travel in the message that carries it.
 */
export type PlaybackPlanMessage = {
  changes: ConfigChange[];
  endHostTime: number;
  segments: PlanSegment[];
  totalBars: number;
};

/**
 * start and state_snapshot carry a plan while the host plays a song. startHostTime is then the plan's
 * start (the first beat, of the count-in if there is one) and the settings are its first settings.
 * With a plan a snapshot sends that original start rather than the next strong beat, because the
 * participant rebuilds the whole grid from the plan. Without one, playback goes on until stop.
 */
export type ControlMessage =
  | ({ type: "config" } & MetronomeConfig & ConfigChangeAnchor)
  | ({ type: "start"; startHostTime: number; sentHostTime: number; plan?: PlaybackPlanMessage } & MetronomeConfig)
  | { type: "stop"; sentHostTime: number }
  | ({
      type: "state_snapshot";
      isPlaying: boolean;
      startHostTime: number | null;
      sentHostTime: number;
      plan?: PlaybackPlanMessage;
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

/** A beat plus how far through it a moment is, from 0 at the beat to 1 at the next. */
export type BeatPosition = BeatInfo & { progress: number };
