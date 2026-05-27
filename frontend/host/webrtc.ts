import type { ControlMessage, MetronomeConfig, SignalMessage, SyncMessage } from "../../shared/types.ts";
import { RTC_CONFIGURATION } from "../shared/webrtcConfig.ts";
import { createHostSyncHandler } from "./clockSync.ts";

export type HostPeer = {
  id: string;
  name: string;
  pc: RTCPeerConnection;
  control: RTCDataChannel;
  sync: RTCDataChannel;
  status: string;
  rtt: number | null;
  offset: number | null;
  jitter: number | null;
};

type StateProvider = () => {
  isPlaying: boolean;
  config: MetronomeConfig;
  startHostTime: number | null;
  sentHostTime: number;
};

type SendSignal = (message: SignalMessage) => void;
type ChangeListener = () => void;

export class HostWebRTC {
  readonly peers = new Map<string, HostPeer>();
  private listeners = new Set<ChangeListener>();

  constructor(
    private sendSignal: SendSignal,
    private getState: StateProvider,
  ) {}

  onChange(listener: ChangeListener): void {
    this.listeners.add(listener);
  }

  async addClient(clientId: string, name: string): Promise<void> {
    if (this.peers.has(clientId)) return;

    const pc = new RTCPeerConnection(RTC_CONFIGURATION);
    const control = pc.createDataChannel("control", { ordered: true });
    const sync = pc.createDataChannel("sync", { ordered: false, maxRetransmits: 0 });
    const peer: HostPeer = { id: clientId, name, pc, control, sync, status: "connecting", rtt: null, offset: null, jitter: null };
    this.peers.set(clientId, peer);

    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        this.sendSignal({ type: "ice", to: clientId, candidate: event.candidate.toJSON() });
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      peer.status = pc.connectionState;
      this.emitChange();
    });

    control.addEventListener("open", () => {
      this.sendSnapshot(peer);
      this.emitChange();
    });

    sync.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as SyncMessage;
      if (message.type === "sync_report") {
        peer.rtt = message.rtt;
        peer.offset = message.offset;
        peer.jitter = message.jitter;
        this.emitChange();
        return;
      }

      createHostSyncHandler((reply) => this.sendSync(peer, reply))(message);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.sendSignal({ type: "offer", to: clientId, sdp: offer });
    this.emitChange();
  }

  async handleSignal(message: SignalMessage): Promise<void> {
    if ((message.type === "answer" || message.type === "ice") && message.from) {
      const peer = this.peers.get(message.from);
      if (!peer) return;

      if (message.type === "answer") {
        await peer.pc.setRemoteDescription(message.sdp);
        return;
      }

      await peer.pc.addIceCandidate(message.candidate);
    }
  }

  removeClient(clientId: string): void {
    const peer = this.peers.get(clientId);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(clientId);
    this.emitChange();
  }

  broadcastControl(message: ControlMessage): void {
    for (const peer of this.peers.values()) {
      this.sendControl(peer, message);
    }
  }

  sendSnapshot(peer: HostPeer): void {
    const state = this.getState();
    this.sendControl(peer, {
      type: "state_snapshot",
      isPlaying: state.isPlaying,
      bpm: state.config.bpm,
      beatsPerBar: state.config.beatsPerBar,
      beatUnit: state.config.beatUnit,
      startHostTime: state.startHostTime,
      sentHostTime: state.sentHostTime,
    });
  }

  private sendControl(peer: HostPeer, message: ControlMessage): void {
    if (peer.control.readyState === "open") {
      peer.control.send(JSON.stringify(message));
    }
  }

  private sendSync(peer: HostPeer, message: SyncMessage): void {
    if (peer.sync.readyState === "open") {
      peer.sync.send(JSON.stringify(message));
    }
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}
