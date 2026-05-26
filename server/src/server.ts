import { networkInterfaces } from "node:os";
import QRCode from "qrcode";
import { configureRooms, createPeerData, removePeer, routeSignal, type PeerData } from "./rooms";
import type { SignalMessage } from "../../shared/types";

const lanHost = detectLanHost();
const hostUrl = `http://${lanHost}:3000/host/`;
const signalingUrl = `ws://${lanHost}:3001/ws`;

function privateIpv4Rank(address: string): number {
  if (address.startsWith("192.168.")) return 1;
  if (address.startsWith("10.")) return 2;

  const match = /^172\.(\d{1,3})\./.exec(address);
  if (match) {
    const secondOctet = Number(match[1]);
    if (secondOctet >= 16 && secondOctet <= 31) return 3;
  }

  if (address.startsWith("100.")) return 10;
  return 20;
}

function detectLanHost(): string {
  const candidates = Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter((networkInterface) => networkInterface.family === "IPv4" && !networkInterface.internal)
    .map((networkInterface) => networkInterface.address)
    .sort((a, b) => privateIpv4Rank(a) - privateIpv4Rank(b));

  return candidates[0] ?? "localhost";
}

configureRooms({
  async createParticipantInvite(roomId) {
    const participantUrl = `http://${lanHost}:3000/client/?room=${encodeURIComponent(roomId)}`;
    const participantQrSvg = await QRCode.toString(participantUrl, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      color: {
        dark: "#111111",
        light: "#ffffff",
      },
    });

    return { participantUrl, participantQrSvg };
  },
});

Bun.serve<PeerData>({
  port: 3001,
  hostname: "0.0.0.0",
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(request, { data: createPeerData() });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }

    return new Response("Signaling server. Connect to /ws with WebSocket.", { status: 404 });
  },
  websocket: {
    message(socket, raw) {
      try {
        void routeSignal(socket, JSON.parse(String(raw)) as SignalMessage).catch((error) => {
          socket.send(JSON.stringify({ type: "error", message: `Signaling failed: ${error}` }));
        });
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", message: `Invalid signaling message: ${error}` }));
      }
    },
    close(socket) {
      removePeer(socket);
    },
  },
});

console.log(`Frontend host:    ${hostUrl}`);
console.log(`Signaling:        ${signalingUrl}`);
