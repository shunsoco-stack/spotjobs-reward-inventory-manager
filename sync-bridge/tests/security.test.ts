import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateCors, parseAdditionalOrigins } from "../src/cors.js";
import {
  isAuthorizedChannel,
  parseAllowedChannelIds,
  parseBearerToken,
} from "../src/security.js";

describe("sync bridge security", () => {
  it("accepts only canonical 32-byte bearer tokens bound to their SHA-256 channel", () => {
    const token = Buffer.alloc(32, 42);
    const encoded = token.toString("base64url");
    const channel = createHash("sha256").update(token).digest("base64url");
    expect(parseBearerToken(`Bearer ${encoded}`)).toEqual(token);
    expect(isAuthorizedChannel(channel, `Bearer ${encoded}`)).toBe(true);
    expect(isAuthorizedChannel(channel, `bearer ${encoded}`)).toBe(false);
    expect(isAuthorizedChannel(channel, `Bearer ${encoded}=`)).toBe(false);
  });

  it("validates the server-side personal channel allowlist", () => {
    const first = Buffer.alloc(32, 1).toString("base64url");
    const second = Buffer.alloc(32, 2).toString("base64url");
    expect(parseAllowedChannelIds(`${first}, ${second}`)).toEqual(new Set([first, second]));
    expect(() => parseAllowedChannelIds("not-a-channel")).toThrow();
  });

  it("allows an exact extension origin and rejects malformed lookalikes", () => {
    const extension = `chrome-extension://${"a".repeat(32)}`;
    expect(evaluateCors(extension).allowed).toBe(true);
    expect(evaluateCors(`${extension}.example`).allowed).toBe(false);
  });

  it("allows local development ports without opening arbitrary network origins", () => {
    expect(evaluateCors("http://localhost:3058").allowed).toBe(true);
    expect(evaluateCors("https://127.0.0.1:4173").allowed).toBe(true);
    expect(evaluateCors("https://192.168.0.2:3058").allowed).toBe(false);
    expect(evaluateCors("https://localhost.attacker.example").allowed).toBe(false);
  });

  it("only accepts exact HTTPS origins in the configurable allowlist", () => {
    const origins = parseAdditionalOrigins("https://preview.example.com");
    expect(evaluateCors("https://preview.example.com", origins).allowed).toBe(true);
    expect(() => parseAdditionalOrigins("http://preview.example.com")).toThrow();
    expect(() => parseAdditionalOrigins("https://preview.example.com/path")).toThrow();
  });
});
