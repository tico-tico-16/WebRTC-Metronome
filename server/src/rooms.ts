import type { PeerRole, SignalMessage } from "../../shared/types";

type Socket = Bun.ServerWebSocket<PeerData>;

export type PeerData = {
  id: string;
  role: PeerRole;
  name: string;
  roomId: string | null;
};

type Room = {
  id: string;
  host: Socket;
  clients: Map<string, Socket>;
};

type ParticipantInvite = {
  participantUrl: string;
  participantQrSvg: string;
};

let nextPeerId = 1;
const rooms = new Map<string, Room>();
let createParticipantInvite: (roomId: string) => Promise<ParticipantInvite> = async (roomId) => ({
  participantUrl: `/?room=${encodeURIComponent(roomId)}`,
  participantQrSvg: "",
});

export function configureRooms(options: {
  createParticipantInvite: (roomId: string) => Promise<ParticipantInvite>;
}): void {
  createParticipantInvite = options.createParticipantInvite;
}

function makePeerId(role: PeerRole): string {
  return `${role}-${nextPeerId++}`;
}

function makeRoomId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let id = "";

  for (const byte of bytes) {
    id += alphabet[byte % alphabet.length];
  }

  return id;
}

function createRoomId(): string {
  let roomId = makeRoomId();
  while (rooms.has(roomId)) {
    roomId = makeRoomId();
  }
  return roomId;
}

function send(socket: Socket, message: SignalMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function closeWithError(socket: Socket, message: string): void {
  send(socket, { type: "error", message });
  socket.close();
}

async function registerHost(socket: Socket, name?: string): Promise<void> {
  const roomId = createRoomId();
  const room: Room = {
    id: roomId,
    host: socket,
    clients: new Map(),
  };
  const invite = await createParticipantInvite(roomId);

  rooms.set(roomId, room);
  socket.data.id = makePeerId("host");
  socket.data.role = "host";
  socket.data.name = name?.trim() || "Host";
  socket.data.roomId = roomId;

  send(socket, {
    type: "registered",
    role: "host",
    id: socket.data.id,
    roomId,
    hostPresent: true,
    participantUrl: invite.participantUrl,
    participantQrSvg: invite.participantQrSvg,
  });
}

function registerClient(socket: Socket, roomId: string | undefined, name?: string): void {
  if (!roomId) {
    closeWithError(socket, "Open the participant URL shared by the host.");
    return;
  }

  const room = rooms.get(roomId);
  if (!room || room.host.readyState !== WebSocket.OPEN) {
    closeWithError(socket, "Room not found or already closed.");
    return;
  }

  socket.data.id = makePeerId("client");
  socket.data.role = "client";
  socket.data.name = name?.trim() || socket.data.id;
  socket.data.roomId = roomId;
  room.clients.set(socket.data.id, socket);

  send(socket, {
    type: "registered",
    role: "client",
    id: socket.data.id,
    roomId,
    hostPresent: true,
  });

  send(room.host, {
    type: "client_joined",
    clientId: socket.data.id,
    name: socket.data.name,
  });
}

export function createPeerData(): PeerData {
  return {
    id: "",
    role: "client",
    name: "unregistered",
    roomId: null,
  };
}

export async function routeSignal(socket: Socket, message: SignalMessage): Promise<void> {
  if (message.type === "register") {
    if (message.role === "host") {
      await registerHost(socket, message.name);
      return;
    }

    registerClient(socket, message.roomId, message.name);
    return;
  }

  if (!socket.data.id || !socket.data.roomId || socket.data.name === "unregistered") {
    send(socket, { type: "error", message: "Register before sending signaling messages." });
    return;
  }

  const room = rooms.get(socket.data.roomId);
  if (!room) {
    send(socket, { type: "error", message: "Room is closed." });
    return;
  }

  if (message.type === "offer" || message.type === "answer" || message.type === "ice") {
    const target = message.to === "host" || message.to === room.host.data.id ? room.host : room.clients.get(message.to);
    if (!target || target.readyState !== WebSocket.OPEN) {
      send(socket, { type: "error", message: `Target ${message.to} is not connected.` });
      return;
    }

    send(target, { ...message, from: socket.data.id });
  }
}

export function removePeer(socket: Socket): void {
  const { id, role, roomId } = socket.data;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  if (role === "host" && room.host === socket) {
    rooms.delete(roomId);
    for (const client of room.clients.values()) {
      send(client, { type: "host_available", hostPresent: false });
      client.close();
    }
    return;
  }

  if (room.clients.delete(id) && room.host.readyState === WebSocket.OPEN) {
    send(room.host, { type: "client_left", clientId: id });
  }
}
