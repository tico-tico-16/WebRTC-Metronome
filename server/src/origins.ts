// Origin checks for WebSocket upgrades. Kept free of Workers runtime imports so Bun tests can load it.

export type OriginCheck =
  | { allowed: true; origin: string }
  | { allowed: false; reason: "missing_origin" | "invalid_origin" | "origin_not_allowed" };

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function ipv4Octets(hostname: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return null;
  const octets = match.slice(1).map(Number) as [number, number, number, number];
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** Splits the comma-separated `ALLOWED_ORIGINS` var into normalized origins, dropping invalid entries. */
export function parseAllowedOrigins(value: string | undefined): string[] {
  const origins: string[] = [];
  for (const entry of (value ?? "").split(",")) {
    const origin = entry.trim() ? normalizeOrigin(entry.trim()) : null;
    if (origin && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/** Loopback and private IPv4 hosts, so `bun run dev` works from LAN devices without configuration. */
export function isDevelopmentHostname(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  const octets = ipv4Octets(hostname);
  if (!octets) return false;
  const [first, second] = octets;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

/**
 * Browsers always send `Origin` on WebSocket upgrades, so a missing one is rejected too.
 * The accepted origin is returned normalized for building the participant URL.
 */
export function checkOrigin(header: string | null, allowedOrigins: readonly string[]): OriginCheck {
  if (!header) return { allowed: false, reason: "missing_origin" };
  const origin = normalizeOrigin(header);
  if (!origin) return { allowed: false, reason: "invalid_origin" };
  if (allowedOrigins.includes(origin) || isDevelopmentHostname(new URL(origin).hostname)) {
    return { allowed: true, origin };
  }
  return { allowed: false, reason: "origin_not_allowed" };
}

/** The participant URL is on the host page's origin, or else on the first configured frontend origin. */
export function participantUrl(roomId: string, frontendOrigin: string, allowedOrigins: readonly string[]): string {
  const origin = frontendOrigin || allowedOrigins[0] || "";
  return `${origin}/client/?room=${encodeURIComponent(roomId)}`;
}
