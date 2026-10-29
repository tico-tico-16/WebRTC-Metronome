/** The signaling server names peers `${role}-${8 hex}` and sets `from` itself, so it cannot be forged. */
export function isHostPeerId(id: string | undefined): boolean {
  return id?.startsWith("host-") ?? false;
}

/**
 * Remote ICE candidates for one connection. `addIceCandidate` rejects until the remote description is set,
 * and signals are handled without waiting for the previous one, so candidates that arrive while
 * `setRemoteDescription` is pending are held and added in arrival order once it resolves.
 */
export class IceCandidateQueue {
  private pending: RTCIceCandidateInit[] | null = [];

  constructor(
    private pc: RTCPeerConnection,
    private peerId: string,
  ) {}

  add(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.pending) {
      this.pending.push(candidate);
      return Promise.resolve();
    }
    return this.addNow(candidate);
  }

  /** Call once the remote description is set; later candidates are added immediately. */
  async flush(): Promise<void> {
    const pending = this.pending ?? [];
    this.pending = null;
    // Each call is queued on the connection as it is made, so the order holds without awaiting each one.
    await Promise.all(pending.map((candidate) => this.addNow(candidate)));
  }

  private async addNow(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (error) {
      // One bad candidate does not stop the others from connecting.
      console.warn(`Could not add an ICE candidate from ${this.peerId}`, error);
    }
  }
}
