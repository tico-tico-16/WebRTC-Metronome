import { RoomDurableObject } from "./room";

export { RoomDurableObject };

const ROOM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function makeRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let roomId = "";

  for (const byte of bytes) {
    roomId += ROOM_ID_ALPHABET[byte % ROOM_ID_ALPHABET.length];
  }

  return roomId;
}

function getFrontendOrigin(request: Request): string {
  const origin = request.headers.get("Origin");
  if (origin) return origin;

  const url = new URL(request.url);
  return url.origin;
}

function getWebSocketUpgrade(request: Request): string | null {
  return request.headers.get("Upgrade")?.toLowerCase() ?? null;
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

function logServerEvent(event: string, details: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...details }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    logServerEvent("request", {
      method: request.method,
      path: url.pathname,
      search: url.search,
      upgrade: getWebSocketUpgrade(request),
    });

    if (!url.pathname.startsWith("/ws")) {
      logServerEvent("request_rejected", { path: url.pathname, status: 404, reason: "not_ws_path" });
      return new Response("Signaling server. Connect to /ws/host or /ws/client?room=<roomId>.", { status: 404 });
    }

    if (getWebSocketUpgrade(request) !== "websocket") {
      logServerEvent("request_rejected", { path: url.pathname, status: 400, reason: "missing_websocket_upgrade" });
      return badRequest("Expected WebSocket upgrade.");
    }

    const role = url.pathname === "/ws/host" ? "host" : url.pathname === "/ws/client" ? "client" : null;
    if (!role) {
      logServerEvent("request_rejected", { path: url.pathname, status: 400, reason: "unknown_ws_path" });
      return badRequest("Connect to /ws/host or /ws/client?room=<roomId>.");
    }

    const roomId = role === "host" ? makeRoomId() : url.searchParams.get("room")?.trim();
    if (!roomId) {
      logServerEvent("request_rejected", { path: url.pathname, role, status: 400, reason: "missing_room_id" });
      return badRequest("Missing room id.");
    }

    const durableObjectUrl = new URL(request.url);
    durableObjectUrl.pathname = "/connect";
    durableObjectUrl.search = "";
    durableObjectUrl.searchParams.set("role", role);
    durableObjectUrl.searchParams.set("room", roomId);
    durableObjectUrl.searchParams.set("frontendOrigin", getFrontendOrigin(request));

    const roomObject = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    logServerEvent("room_connect_forwarded", { role, roomId });
    return roomObject.fetch(new Request(durableObjectUrl, request));
  },
};
