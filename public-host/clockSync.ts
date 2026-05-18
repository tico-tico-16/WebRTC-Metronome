import type { SyncMessage } from "../src/types.ts";

export function nowSeconds(): number {
  return performance.now() / 1000;
}

export function createHostSyncHandler(sendReport: (message: SyncMessage) => void) {
  return (message: SyncMessage) => {
    if (message.type !== "ping") return;

    const hostReceiveTime = nowSeconds();
    sendReport({
      type: "pong",
      id: message.id,
      clientSendTime: message.clientSendTime,
      hostReceiveTime,
      hostSendTime: nowSeconds(),
    });
  };
}
