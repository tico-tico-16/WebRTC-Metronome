import { networkInterfaces } from "node:os";
import { createPeerData, removePeer, routeSignal, type PeerData } from "./rooms";
import type { SignalMessage } from "./types";

const clientRoot = `${import.meta.dir}/../public-client`;
const hostRoot = `${import.meta.dir}/../public-host`;
const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
const lanHost = detectLanHost();
const participantUrl = `http://${lanHost}:3000`;
const hostUrl = `http://${lanHost}:3001`;
const signalingUrl = `ws://${lanHost}:3001/ws`;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
};

function extensionOf(pathname: string): string {
  const dot = pathname.lastIndexOf(".");
  return dot === -1 ? "" : pathname.slice(dot);
}

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

async function serveStatic(root: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const segments = decodeURIComponent(pathname)
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..");
  const filePath = `${root}/${segments.join("/")}`;

  if (!filePath.startsWith(root)) {
    return new Response("Forbidden", { status: 403 });
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }

  const extension = extensionOf(filePath);
  const headers = { "Content-Type": contentTypes[extension] ?? "application/octet-stream" };

  if (extension === ".ts") {
    const source = await file.text();
    return new Response(transpiler.transformSync(source), { headers });
  }

  if (filePath === `${hostRoot}/index.html`) {
    const source = await file.text();
    return new Response(source.replaceAll("__PARTICIPANT_URL__", participantUrl), { headers });
  }

  return new Response(file, { headers });
}

Bun.serve<PeerData>({
  port: 3001,
  hostname: "0.0.0.0",
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(request, { data: createPeerData() });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }

    return serveStatic(hostRoot, request);
  },
  websocket: {
    message(socket, raw) {
      try {
        routeSignal(socket, JSON.parse(String(raw)) as SignalMessage);
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", message: `Invalid signaling message: ${error}` }));
      }
    },
    close(socket) {
      removePeer(socket);
    },
  },
});

Bun.serve({
  port: 3000,
  hostname: "0.0.0.0",
  fetch(request) {
    return serveStatic(clientRoot, request);
  },
});

console.log(`Participant page: ${participantUrl}`);
console.log(`Host page:        ${hostUrl}`);
console.log(`Signaling:        ${signalingUrl}`);
