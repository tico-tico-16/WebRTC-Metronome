import type { SignalMessage } from "../../shared/types.ts";
import { SignalingSocket, signalingBaseUrl, type CloseListener, type SignalListener } from "../shared/signalingSocket.ts";

export class SignalingClient {
  private readonly socket = new SignalingSocket();

  connect(roomId: string, name: string): void {
    const url = `${signalingBaseUrl()}/client?room=${encodeURIComponent(roomId)}`;
    this.socket.connect(url, { type: "register", role: "client", roomId, name });
  }

  onMessage(listener: SignalListener): void {
    this.socket.onMessage(listener);
  }

  onClose(listener: CloseListener): void {
    this.socket.onClose(listener);
  }

  send(message: SignalMessage): void {
    this.socket.send(message);
  }
}
