import type { ControlMessage, SignalMessage, SyncMessage } from "../../shared/types.ts";
import { RTC_CONFIGURATION } from "../shared/webrtcConfig.ts";

type SendSignal = (message: SignalMessage) => void;
type ControlListener = (message: ControlMessage) => void;
type SyncListener = (message: SyncMessage) => void;
type StateListener = (state: string) => void;

export class ClientWebRTC {
  private pc: RTCPeerConnection | null = null;
  private control: RTCDataChannel | null = null;
  private sync: RTCDataChannel | null = null;
  private controlListeners = new Set<ControlListener>();
  private syncListeners = new Set<SyncListener>();
  private stateListeners = new Set<StateListener>();

  constructor(private sendSignal: SendSignal) {}

  onControl(listener: ControlListener): void {
    this.controlListeners.add(listener);
  }

  onSync(listener: SyncListener): void {
    this.syncListeners.add(listener);
  }

  onState(listener: StateListener): void {
    this.stateListeners.add(listener);
  }

  async handleSignal(message: SignalMessage): Promise<void> {
    if (message.type === "offer") {
      await this.acceptOffer(message);
      return;
    }

    if (message.type === "ice" && this.pc) {
      await this.pc.addIceCandidate(message.candidate);
    }
  }

  sendSync(message: SyncMessage): void {
    if (this.sync?.readyState === "open") {
      this.sync.send(JSON.stringify(message));
    }
  }

  private async acceptOffer(message: Extract<SignalMessage, { type: "offer" }>): Promise<void> {
    this.pc?.close();
    const pc = new RTCPeerConnection(RTC_CONFIGURATION);
    this.pc = pc;

    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        this.sendSignal({ type: "ice", to: "host", candidate: event.candidate.toJSON() });
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      this.emitState(pc.connectionState);
    });

    pc.addEventListener("datachannel", (event) => {
      if (event.channel.label === "control") {
        this.control = event.channel;
        event.channel.addEventListener("message", (raw) => {
          const controlMessage = JSON.parse(String(raw.data)) as ControlMessage;
          for (const listener of this.controlListeners) listener(controlMessage);
        });
      }

      if (event.channel.label === "sync") {
        this.sync = event.channel;
        event.channel.addEventListener("open", () => this.emitState("sync open"));
        event.channel.addEventListener("message", (raw) => {
          const syncMessage = JSON.parse(String(raw.data)) as SyncMessage;
          for (const listener of this.syncListeners) listener(syncMessage);
        });
      }
    });

    await pc.setRemoteDescription(message.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.sendSignal({ type: "answer", to: "host", sdp: answer });
  }

  private emitState(state: string): void {
    for (const listener of this.stateListeners) listener(state);
  }
}
