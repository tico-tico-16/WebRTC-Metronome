import type { SyncMessage } from "../src/types.ts";

export type ClockStats = {
  rtt: number | null;
  offset: number | null;
  jitter: number | null;
  sampleCount: number;
  stable: boolean;
};

type Sender = (message: SyncMessage) => void;

export function nowSeconds(): number {
  return (performance.timeOrigin + performance.now()) / 1000;
}

export class ClockSync {
  private nextPingId = 1;
  private offsets: number[] = [];
  private rtts: number[] = [];
  private timer: number | null = null;

  stats: ClockStats = {
    rtt: null,
    offset: null,
    jitter: null,
    sampleCount: 0,
    stable: false,
  };

  constructor(private send: Sender) {}

  start(): void {
    this.stop();
    this.ping();
    this.timer = window.setInterval(() => this.ping(), 350);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  handle(message: SyncMessage): SyncMessage | null {
    if (message.type !== "pong") return null;

    const clientReceiveTime = nowSeconds();
    const rtt = clientReceiveTime - message.clientSendTime - (message.hostSendTime - message.hostReceiveTime);
    const offset = (message.hostReceiveTime + message.hostSendTime) / 2 - (message.clientSendTime + clientReceiveTime) / 2;

    this.rtts.push(Math.max(0, rtt));
    this.offsets.push(offset);
    if (this.rtts.length > 12) this.rtts.shift();
    if (this.offsets.length > 12) this.offsets.shift();

    const best = this.offsets
      .map((value, index) => ({ value, rtt: this.rtts[index] ?? Number.POSITIVE_INFINITY }))
      .sort((a, b) => a.rtt - b.rtt)
      .slice(0, 5)
      .map((sample) => sample.value);

    const averageOffset = best.reduce((sum, value) => sum + value, 0) / best.length;
    const jitter =
      best.reduce((sum, value) => sum + Math.abs(value - averageOffset), 0) / Math.max(1, best.length);

    const bestRtt = Math.min(...this.rtts);
    this.stats = {
      rtt: bestRtt,
      offset: averageOffset,
      jitter,
      sampleCount: this.offsets.length,
      stable: this.offsets.length >= 5 && jitter < 0.025,
    };

    return {
      type: "sync_report",
      rtt: bestRtt,
      offset: averageOffset,
      jitter,
      sampleCount: this.stats.sampleCount,
    };
  }

  hostNow(): number {
    return nowSeconds() + (this.stats.offset ?? 0);
  }

  localTimeForHostTime(hostTime: number): number {
    return hostTime - (this.stats.offset ?? 0);
  }

  private ping(): void {
    this.send({
      type: "ping",
      id: this.nextPingId++,
      clientSendTime: nowSeconds(),
    });
  }
}
