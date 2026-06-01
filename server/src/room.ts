import { DurableObject } from "cloudflare:workers";
import type { PeerRole, SignalMessage } from "../../shared/types";

type WebSocketAttachment = {
  id: string;
  role: PeerRole;
  name: string;
  roomId: string;
  frontendOrigin: string;
};

type PeerSocket = WebSocket;

type RoomPeers = {
  host: PeerSocket | null;
  clients: Map<string, PeerSocket>;
};

function send(socket: PeerSocket, message: SignalMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function closeWithError(socket: PeerSocket, message: string): void {
  send(socket, { type: "error", message });
  socket.close();
}

function makePeerId(role: PeerRole): string {
  return `${role}-${crypto.randomUUID().slice(0, 8)}`;
}

function readAttachment(socket: PeerSocket): WebSocketAttachment | null {
  try {
    return socket.deserializeAttachment();
  } catch {
    return null;
  }
}

function writeAttachment(socket: PeerSocket, attachment: WebSocketAttachment): void {
  socket.serializeAttachment(attachment);
}

function logRoomEvent(event: string, details: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...details }));
}

export class RoomDurableObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") as PeerRole | null;
    const roomId = url.searchParams.get("room")?.trim() ?? "";

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      logRoomEvent("room_connect_rejected", { role, roomId, status: 400, reason: "missing_websocket_upgrade" });
      return new Response("Expected WebSocket upgrade.", { status: 400 });
    }

    if ((role !== "host" && role !== "client") || !roomId) {
      logRoomEvent("room_connect_rejected", { role, roomId, status: 400, reason: "missing_registration_data" });
      return new Response("Missing room registration data.", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1] as PeerSocket];
    writeAttachment(server, {
      id: "",
      role,
      name: "unregistered",
      roomId,
      frontendOrigin: url.searchParams.get("frontendOrigin") ?? "",
    });
    this.ctx.acceptWebSocket(server);
    logRoomEvent("room_socket_accepted", { role, roomId });

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
  }

  override async webSocketMessage(socket: PeerSocket, raw: string | ArrayBuffer): Promise<void> {
    try {
      const message = JSON.parse(String(raw)) as SignalMessage;
      const attachment = readAttachment(socket);
      logRoomEvent("signal_received", {
        roomId: attachment?.roomId,
        peerId: attachment?.id,
        role: attachment?.role,
        type: message.type,
      });
      await this.routeSignal(socket, message);
    } catch (error) {
      logRoomEvent("signal_invalid", { error: String(error) });
      send(socket, { type: "error", message: `Invalid signaling message: ${error}` });
    }
  }

  override webSocketClose(socket: PeerSocket): void {
    const attachment = readAttachment(socket);
    logRoomEvent("socket_closed", { roomId: attachment?.roomId, peerId: attachment?.id, role: attachment?.role });
    this.removePeer(socket);
  }

  override webSocketError(socket: PeerSocket): void {
    const attachment = readAttachment(socket);
    logRoomEvent("socket_error", { roomId: attachment?.roomId, peerId: attachment?.id, role: attachment?.role });
    this.removePeer(socket);
  }

  private getPeers(): RoomPeers {
    const peers: RoomPeers = {
      host: null,
      clients: new Map(),
    };

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.id || socket.readyState !== WebSocket.OPEN) continue;

      if (attachment.role === "host") {
        peers.host = socket;
      } else {
        peers.clients.set(attachment.id, socket);
      }
    }

    return peers;
  }

  private async routeSignal(socket: PeerSocket, message: SignalMessage): Promise<void> {
    if (message.type === "register") {
      this.registerPeer(socket, message);
      return;
    }

    const attachment = readAttachment(socket);
    if (!attachment?.id || attachment.name === "unregistered") {
      logRoomEvent("signal_rejected", { roomId: attachment?.roomId, peerId: attachment?.id, reason: "unregistered" });
      send(socket, { type: "error", message: "Register before sending signaling messages." });
      return;
    }

    const peers = this.getPeers();
    if (!peers.host) {
      logRoomEvent("signal_rejected", { roomId: attachment.roomId, peerId: attachment.id, reason: "room_closed" });
      send(socket, { type: "error", message: "Room is closed." });
      return;
    }

    if (message.type === "offer" || message.type === "answer" || message.type === "ice") {
      const target = message.to === "host" || message.to === readAttachment(peers.host)?.id
        ? peers.host
        : peers.clients.get(message.to);

      if (!target || target.readyState !== WebSocket.OPEN) {
        logRoomEvent("signal_rejected", {
          roomId: attachment.roomId,
          peerId: attachment.id,
          target: message.to,
          type: message.type,
          reason: "target_not_connected",
        });
        send(socket, { type: "error", message: `Target ${message.to} is not connected.` });
        return;
      }

      send(target, { ...message, from: attachment.id });
      logRoomEvent("signal_forwarded", {
        roomId: attachment.roomId,
        from: attachment.id,
        to: message.to,
        type: message.type,
      });
    }
  }

  private registerPeer(socket: PeerSocket, message: Extract<SignalMessage, { type: "register" }>): void {
    const attachment = readAttachment(socket);
    if (!attachment) {
      logRoomEvent("register_rejected", { reason: "missing_metadata" });
      closeWithError(socket, "Missing WebSocket metadata.");
      return;
    }

    if (attachment.role !== message.role) {
      logRoomEvent("register_rejected", { roomId: attachment.roomId, role: message.role, reason: "role_mismatch" });
      closeWithError(socket, "WebSocket role does not match registration role.");
      return;
    }

    if (message.role === "host") {
      this.registerHost(socket, attachment, message.name);
      return;
    }

    this.registerClient(socket, attachment, message.roomId, message.name);
  }

  private registerHost(socket: PeerSocket, attachment: WebSocketAttachment, name?: string): void {
    const peers = this.getPeers();
    if (peers.host && peers.host !== socket) {
      logRoomEvent("register_rejected", { roomId: attachment.roomId, role: "host", reason: "host_exists" });
      closeWithError(socket, "Room already has a host.");
      return;
    }

    const registered = {
      ...attachment,
      id: makePeerId("host"),
      name: name?.trim() || "Host",
    };
    writeAttachment(socket, registered);
    logRoomEvent("host_registered", { roomId: registered.roomId, peerId: registered.id, name: registered.name });

    const participantUrl = this.createParticipantUrl(registered.roomId);
    send(socket, {
      type: "registered",
      role: "host",
      id: registered.id,
      roomId: registered.roomId,
      hostPresent: true,
      participantUrl,
    });
  }

  private registerClient(
    socket: PeerSocket,
    attachment: WebSocketAttachment,
    roomId: string | undefined,
    name?: string,
  ): void {
    if (!roomId || roomId !== attachment.roomId) {
      logRoomEvent("register_rejected", {
        roomId: attachment.roomId,
        requestedRoomId: roomId,
        role: "client",
        reason: "room_mismatch",
      });
      closeWithError(socket, "Open the participant URL shared by the host.");
      return;
    }

    const peers = this.getPeers();
    if (!peers.host) {
      logRoomEvent("register_rejected", { roomId: attachment.roomId, role: "client", reason: "host_missing" });
      closeWithError(socket, "Room not found or already closed.");
      return;
    }

    const id = makePeerId("client");
    const registered = {
      ...attachment,
      id,
      name: name?.trim() || id,
    };
    writeAttachment(socket, registered);
    logRoomEvent("client_registered", { roomId: registered.roomId, peerId: registered.id, name: registered.name });

    send(socket, {
      type: "registered",
      role: "client",
      id: registered.id,
      roomId: registered.roomId,
      hostPresent: true,
    });

    send(peers.host, {
      type: "client_joined",
      clientId: registered.id,
      name: registered.name,
    });
  }

  private removePeer(socket: PeerSocket): void {
    const attachment = readAttachment(socket);
    if (!attachment?.id) return;

    const peers = this.getPeers();
    if (attachment.role === "host") {
      logRoomEvent("host_removed", { roomId: attachment.roomId, peerId: attachment.id, clientCount: peers.clients.size });
      for (const client of peers.clients.values()) {
        send(client, { type: "host_available", hostPresent: false });
        client.close();
      }
      return;
    }

    if (attachment.role === "client" && peers.host) {
      logRoomEvent("client_removed", { roomId: attachment.roomId, peerId: attachment.id });
      send(peers.host, { type: "client_left", clientId: attachment.id });
    }
  }

  private createParticipantUrl(roomId: string): string {
    const socket = this.ctx.getWebSockets().find((candidate) => readAttachment(candidate)?.roomId === roomId);
    const origin = socket ? readAttachment(socket)?.frontendOrigin ?? "" : "";
    return `${origin}/client/?room=${encodeURIComponent(roomId)}`;
  }
}
