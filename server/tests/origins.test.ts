import { describe, expect, test } from "bun:test";
import { checkOrigin, isDevelopmentHostname, parseAllowedOrigins, participantUrl } from "../src/origins.ts";

const PRODUCTION = "https://metronome.tico-tico.com";

describe("allowed origins", () => {
  test("parses the comma-separated var into normalized origins", () => {
    expect(parseAllowedOrigins(PRODUCTION)).toEqual([PRODUCTION]);
    expect(parseAllowedOrigins(` ${PRODUCTION}/ , https://Preview.Example.com:8443 ,,`))
      .toEqual([PRODUCTION, "https://preview.example.com:8443"]);
    expect(parseAllowedOrigins(`${PRODUCTION},${PRODUCTION}`)).toEqual([PRODUCTION]);
  });

  test("drops entries that are not http(s) origins", () => {
    expect(parseAllowedOrigins("not a url, ftp://files.example.com, null")).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
});

describe("development hostnames", () => {
  test("accepts loopback names", () => {
    expect(["localhost", "127.0.0.1", "[::1]"].filter(isDevelopmentHostname)).toEqual(["localhost", "127.0.0.1", "[::1]"]);
  });

  test("accepts private IPv4 ranges only", () => {
    const hostnames = [
      "10.0.0.1", "10.255.255.255",
      "172.16.0.1", "172.31.255.254", "172.15.0.1", "172.32.0.1",
      "192.168.1.20", "192.169.1.20",
      "8.8.8.8", "100.64.0.1", "169.254.1.1",
    ];
    expect(hostnames.filter(isDevelopmentHostname))
      .toEqual(["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.1.20"]);
  });

  test("rejects public names and look-alikes", () => {
    const hostnames = ["metronome.tico-tico.com", "localhost.evil.com", "10.0.0.1.evil.com", "192.168.1", "192.168.1.256", "[::2]", ""];
    expect(hostnames.filter(isDevelopmentHostname)).toEqual([]);
  });
});

describe("origin check", () => {
  const allowed = [PRODUCTION];

  test("accepts configured origins and passes them on normalized", () => {
    expect(checkOrigin(PRODUCTION, allowed)).toEqual({ allowed: true, origin: PRODUCTION });
    expect(checkOrigin("https://METRONOME.tico-tico.com", allowed)).toEqual({ allowed: true, origin: PRODUCTION });
  });

  test("accepts localhost and private LAN origins without configuration", () => {
    expect(checkOrigin("http://localhost:3000", [])).toEqual({ allowed: true, origin: "http://localhost:3000" });
    expect(checkOrigin("http://127.0.0.1:3000", [])).toEqual({ allowed: true, origin: "http://127.0.0.1:3000" });
    expect(checkOrigin("http://[::1]:3000", [])).toEqual({ allowed: true, origin: "http://[::1]:3000" });
    expect(checkOrigin("http://192.168.1.20:3000", allowed)).toEqual({ allowed: true, origin: "http://192.168.1.20:3000" });
  });

  test("rejects a missing, malformed or unknown origin", () => {
    expect(checkOrigin(null, allowed)).toEqual({ allowed: false, reason: "missing_origin" });
    expect(checkOrigin("", allowed)).toEqual({ allowed: false, reason: "missing_origin" });
    expect(checkOrigin("null", allowed)).toEqual({ allowed: false, reason: "invalid_origin" });
    expect(checkOrigin("chrome-extension://abcdef", allowed)).toEqual({ allowed: false, reason: "invalid_origin" });
    expect(checkOrigin("https://evil.example.com", allowed)).toEqual({ allowed: false, reason: "origin_not_allowed" });
    expect(checkOrigin("http://metronome.tico-tico.com", allowed)).toEqual({ allowed: false, reason: "origin_not_allowed" });
    expect(checkOrigin("https://metronome.tico-tico.com.evil.com", allowed)).toEqual({ allowed: false, reason: "origin_not_allowed" });
  });
});

describe("participant URL", () => {
  test("uses the host page's origin", () => {
    expect(participantUrl("Ab3 x", "http://192.168.1.20:3000", [PRODUCTION]))
      .toBe("http://192.168.1.20:3000/client/?room=Ab3%20x");
  });

  test("falls back to the first allowed origin, not the signaling server", () => {
    expect(participantUrl("room1", "", [PRODUCTION, "https://other.example.com"]))
      .toBe(`${PRODUCTION}/client/?room=room1`);
  });
});
