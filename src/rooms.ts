import type { PeerRole, SignalMessage } from "./types";

type Socket = Bun.ServerWebSocket<PeerData>;

export type PeerData = {
  id: string;
  role: PeerRole;
  name: string;
};

let nextPeerId = 1;
let host: Socket | null = null;
const clients = new Map<string, Socket>();

function makePeerId(role: PeerRole): string {
  return `${role}-${nextPeerId++}`;
}

function send(socket: Socket, message: SignalMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcastToClients(message: SignalMessage): void {
  for (const client of clients.values()) {
    send(client, message);
  }
}

export function registerPeer(socket: Socket, role: PeerRole, name?: string): void {
  if (role === "host") {
    if (host && host.readyState === WebSocket.OPEN) {
      send(socket, { type: "error", message: "A host is already connected." });
      socket.close();
      return;
    }

    host = socket;
  } else {
    clients.set(socket.data.id, socket);
  }

  socket.data.role = role;
  socket.data.name = name?.trim() || socket.data.id;

  send(socket, {
    type: "registered",
    role,
    id: socket.data.id,
    hostPresent: Boolean(host),
  });

  if (role === "host") {
    for (const client of clients.values()) {
      send(socket, {
        type: "client_joined",
        clientId: client.data.id,
        name: client.data.name,
      });
    }
    broadcastToClients({ type: "host_available", hostPresent: true });
    return;
  }

  if (host) {
    send(host, {
      type: "client_joined",
      clientId: socket.data.id,
      name: socket.data.name,
    });
  }
}

export function createPeerData(): PeerData {
  return {
    id: makePeerId("client"),
    role: "client",
    name: "unregistered",
  };
}

export function routeSignal(socket: Socket, message: SignalMessage): void {
  if (message.type === "register") {
    socket.data.id = makePeerId(message.role);
    registerPeer(socket, message.role, message.name);
    return;
  }

  if (!socket.data.id || socket.data.name === "unregistered") {
    send(socket, { type: "error", message: "Register before sending signaling messages." });
    return;
  }

  if (message.type === "offer" || message.type === "answer" || message.type === "ice") {
    const target = message.to === "host" || message.to === host?.data.id ? host : clients.get(message.to);
    if (!target) {
      send(socket, { type: "error", message: `Target ${message.to} is not connected.` });
      return;
    }

    send(target, { ...message, from: socket.data.id });
  }
}

export function removePeer(socket: Socket): void {
  const { id, role } = socket.data;

  if (role === "host" && host === socket) {
    host = null;
    broadcastToClients({ type: "host_available", hostPresent: false });
    return;
  }

  if (clients.delete(id) && host) {
    send(host, { type: "client_left", clientId: id });
  }
}
