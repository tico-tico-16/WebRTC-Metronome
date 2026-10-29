import type { SignalMessage } from "../../shared/types.ts";
import { SignalingSocket, signalingBaseUrl, type SignalListener } from "../shared/signalingSocket.ts";

export class SignalingClient {
  private readonly socket = new SignalingSocket();

  connect(): void {
    this.socket.connect(`${signalingBaseUrl()}/host`, { type: "register", role: "host", name: "Host" });
  }

  onMessage(listener: SignalListener): void {
    this.socket.onMessage(listener);
  }

  send(message: SignalMessage): void {
    this.socket.send(message);
  }
}
