import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EncryptedSnapshotEnvelope } from "../src/protocol.js";
import { handleSnapshotRequest } from "../src/service.js";
import {
  MemoryRateLimiter,
  MemorySnapshotStore,
  type RateLimiter,
} from "../src/storage.js";

const authToken = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const authorization = `Bearer ${authToken.toString("base64url")}`;
const channelId = createHash("sha256").update(authToken).digest("base64url");
const origin = "https://spotlog-worker.vercel.app";

const envelope: EncryptedSnapshotEnvelope = {
  version: 1,
  iv: Buffer.alloc(12, 3).toString("base64url"),
  ciphertext: Buffer.alloc(32, 7).toString("base64url"),
  recordCount: 2,
  source: "spotjobs-edge",
  collectedAt: "2026-11-13T01:02:03.000Z",
};

function dependencies(overrides: Partial<Parameters<typeof handleSnapshotRequest>[1]> = {}) {
  return {
    store: new MemorySnapshotStore(),
    rateLimiter: new MemoryRateLimiter(),
    allowedChannelIds: new Set([channelId]),
    now: () => new Date("2026-11-13T01:05:00.000Z"),
    snapshotTtlSeconds: 3600,
    ...overrides,
  };
}

function request(
  method: string,
  overrides: Partial<Parameters<typeof handleSnapshotRequest>[0]> = {},
) {
  return {
    method,
    channelId,
    authorization,
    origin,
    body: envelope,
    ...overrides,
  };
}

describe("encrypted snapshot service", () => {
  it("stores and returns only the encrypted envelope with retention metadata", async () => {
    const deps = dependencies();
    const put = await handleSnapshotRequest(request("PUT"), deps);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({
      ok: true,
      storedAt: "2026-11-13T01:05:00.000Z",
      expiresAt: "2026-11-13T02:05:00.000Z",
    });

    const get = await handleSnapshotRequest(request("GET", { body: undefined }), deps);
    expect(get.status).toBe(200);
    expect(get.body).toEqual({
      envelope,
      storedAt: "2026-11-13T01:05:00.000Z",
      expiresAt: "2026-11-13T02:05:00.000Z",
    });
    expect(JSON.stringify(get.body)).not.toContain("spotName");
  });

  it("deletes the encrypted cloud snapshot", async () => {
    const deps = dependencies();
    await handleSnapshotRequest(request("PUT"), deps);
    const deleted = await handleSnapshotRequest(request("DELETE", { body: undefined }), deps);
    expect(deleted.status).toBe(204);
    expect(deleted.body).toBeUndefined();
    expect((await handleSnapshotRequest(request("GET", { body: undefined }), deps)).status).toBe(404);
  });

  it("rejects missing and mismatched bearer credentials", async () => {
    const deps = dependencies();
    const missing = await handleSnapshotRequest(request("GET", { authorization: undefined }), deps);
    expect(missing.status).toBe(401);

    const other = Buffer.alloc(32, 99).toString("base64url");
    const mismatched = await handleSnapshotRequest(
      request("GET", { authorization: `Bearer ${other}` }),
      deps,
    );
    expect(mismatched.status).toBe(401);
  });

  it("fails closed when the bridge allowlist is absent", async () => {
    const result = await handleSnapshotRequest(
      request("GET"),
      dependencies({ allowedChannelIds: new Set() }),
    );
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: { code: "bridge_not_configured" } });
  });

  it("does not reveal whether an unconfigured channel exists", async () => {
    const otherToken = Buffer.alloc(32, 88);
    const otherChannel = createHash("sha256").update(otherToken).digest("base64url");
    const result = await handleSnapshotRequest(
      request("GET", {
        channelId: otherChannel,
        authorization: `Bearer ${otherToken.toString("base64url")}`,
      }),
      dependencies(),
    );
    expect(result.status).toBe(404);
  });

  it("rejects disallowed origins without reflecting them", async () => {
    const result = await handleSnapshotRequest(
      request("GET", { origin: "https://attacker.example" }),
      dependencies(),
    );
    expect(result.status).toBe(403);
    expect(result.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("answers a trusted preflight without requiring credentials", async () => {
    const result = await handleSnapshotRequest(
      request("OPTIONS", { authorization: undefined, channelId: "" }),
      dependencies(),
    );
    expect(result.status).toBe(204);
    expect(result.headers["Access-Control-Allow-Origin"]).toBe(origin);
    expect(result.headers["Access-Control-Allow-Methods"]).toContain("DELETE");
  });

  it("strictly rejects unknown fields and malformed encryption metadata", async () => {
    const withExtra = { ...envelope, plaintext: "must never be accepted" };
    const extraResult = await handleSnapshotRequest(
      request("PUT", { body: withExtra }),
      dependencies(),
    );
    expect(extraResult.status).toBe(400);

    const badIv = { ...envelope, iv: Buffer.alloc(8).toString("base64url") };
    const ivResult = await handleSnapshotRequest(request("PUT", { body: badIv }), dependencies());
    expect(ivResult.status).toBe(400);
  });

  it("rejects over-limit requests before parsing the body", async () => {
    const result = await handleSnapshotRequest(
      request("PUT", { contentLength: 1024 * 1024 + 1 }),
      dependencies(),
    );
    expect(result.status).toBe(413);
    expect(result.body).toMatchObject({ error: { code: "snapshot_too_large" } });
  });

  it("returns retry guidance when rate limited", async () => {
    const denied: RateLimiter = {
      consume: async () => ({ allowed: false, retryAfterSeconds: 17 }),
    };
    const result = await handleSnapshotRequest(
      request("GET"),
      dependencies({ rateLimiter: denied }),
    );
    expect(result.status).toBe(429);
    expect(result.headers["Retry-After"]).toBe("17");
  });

  it("rejects unsupported methods", async () => {
    const result = await handleSnapshotRequest(request("POST"), dependencies());
    expect(result.status).toBe(405);
    expect(result.headers.Allow).toBe("GET, PUT, DELETE, OPTIONS");
  });
});
