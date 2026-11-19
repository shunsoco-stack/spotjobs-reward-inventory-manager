import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleStorageRequest } from "../cloudflare/src/worker.ts";
import { SQLiteBinding } from "../cloudflare/tests/sqlite-binding.ts";
import { D1GatewayClient, type D1GatewayRequest } from "../src/d1-client.js";
import { D1RefreshStore, D1SnapshotStore } from "../src/d1-storage.js";
import { MAX_CIPHERTEXT_BYTES, type EncryptedSnapshotEnvelope } from "../src/protocol.js";
import { handleRefreshRequest } from "../src/refresh-service.js";
import type { RefreshCommand } from "../src/refresh-store.js";
import { handleSnapshotRequest } from "../src/service.js";
import { MemoryRateLimiter, type StoredSnapshot } from "../src/storage.js";

const databases: SQLiteBinding[] = [];
const gatewayUrl = "https://spotlog-sync.integration-test.workers.dev";

function setup() {
  const database = new SQLiteBinding();
  databases.push(database);
  let now = Date.parse("2026-11-19T01:00:00.000Z");
  const secret = Buffer.alloc(32, 72).toString("base64url");
  const authToken = Buffer.alloc(32, 43);
  const channelId = createHash("sha256").update(authToken).digest("base64url");
  const authorization = `Bearer ${authToken.toString("base64url")}`;
  const origin = "https://spotjobs-reward-inventory-manager.vercel.app";
  const transportCalls: { operation: D1GatewayRequest; status: number }[] = [];
  // Only HTTP serialization is intercepted. Authentication, validation and every
  // D1 SQL statement run through the production Worker and real SQLite schema.
  const workerFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe(`${gatewayUrl}/v1/storage`);
    const operation = JSON.parse(init!.body as string) as D1GatewayRequest;
    const response = await handleStorageRequest(request, { DB: database, SPOTLOG_GATEWAY_SECRET: secret }, () => now);
    transportCalls.push({ operation, status: response.status });
    return response;
  };
  const gateway = new D1GatewayClient({ credentials: () => ({ url: gatewayUrl, token: secret }), fetchImpl: workerFetch });
  const refresh = new D1RefreshStore(gateway, () => now);
  const snapshots = new D1SnapshotStore(gateway, () => now);
  const common = { rateLimiter: new MemoryRateLimiter(() => now), allowedChannelIds: new Set([channelId]), now: () => new Date(now) };
  const refreshRequest = (method: string, body?: unknown, requestId?: string) => handleRefreshRequest(
    { method, channelId, authorization, origin, body, requestId }, { ...common, store: refresh },
  );
  const snapshotRequest = (method: string, body?: unknown) => handleSnapshotRequest(
    { method, channelId, authorization, origin, body }, { ...common, store: snapshots },
  );
  const envelope = (bytes = 64): EncryptedSnapshotEnvelope => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", randomBytes(32), iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.alloc(bytes - 16, 23)), cipher.final(), cipher.getAuthTag()]);
    return { version: 1, source: "spotjobs-edge", recordCount: 2, collectedAt: new Date(now).toISOString(), iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  };
  return { database, gateway, refresh, snapshots, channelId, transportCalls, refreshRequest, snapshotRequest, envelope, advance: (milliseconds: number) => { now += milliseconds; } };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.unstubAllGlobals();
});

describe("Vercel services → D1 transport → Worker → SQLite", () => {
  it("carries a coalesced phone request through PC upload and completion", async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("External network access is forbidden in this test."); }));
    const context = setup();
    const { gateway, refreshRequest, snapshotRequest, transportCalls } = context;
    await expect(gateway.request({ op: "ping" })).resolves.toEqual({ ok: true });
    expect((await refreshRequest("GET")).status).toBe(204);

    const phoneRequests = await Promise.all([refreshRequest("POST", {}), refreshRequest("POST", {})]);
    expect(phoneRequests.map(result => result.status)).toEqual([200, 200]);
    const first = phoneRequests[0].body as RefreshCommand;
    expect((phoneRequests[1].body as RefreshCommand).requestId).toBe(first.requestId);
    expect((await refreshRequest("GET")).body).toEqual(first);
    expect((await refreshRequest("PUT", { requestId: first.requestId, status: "running" })).body).toMatchObject({ status: "running" });

    context.advance(1_000);
    const envelope = context.envelope();
    expect((await snapshotRequest("PUT", envelope)).status).toBe(200);
    expect((await refreshRequest("PUT", { requestId: first.requestId, status: "succeeded" })).status).toBe(200);
    expect((await refreshRequest("GET", undefined, first.requestId)).body).toMatchObject({ requestId: first.requestId, status: "succeeded" });
    const download = await snapshotRequest("GET");
    expect(download.status).toBe(200);
    const stored = download.body as StoredSnapshot;
    expect(stored.envelope).toEqual(envelope);
    expect(Date.parse(stored.storedAt)).toBeGreaterThan(Date.parse(first.requestedAt));
    expect(Date.parse(stored.expiresAt) - Date.parse(stored.storedAt)).toBe(90 * 86_400_000);
    expect(download.headers["Access-Control-Allow-Origin"]).toBe("https://spotjobs-reward-inventory-manager.vercel.app");
    expect(download.headers["Cache-Control"]).toContain("no-store");
    expect(transportCalls.every(call => call.status === 200)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps stale acknowledgements isolated and enforces request, pointer, and history expiry", async () => {
    const context = setup();
    const { refreshRequest, refresh, channelId, database } = context;
    const first = (await refreshRequest("POST", {})).body as RefreshCommand;
    await refreshRequest("PUT", { requestId: first.requestId, status: "succeeded" });
    const newer = (await refreshRequest("POST", {})).body as RefreshCommand;
    expect(newer.requestId).not.toBe(first.requestId);
    expect((await refreshRequest("PUT", { requestId: first.requestId, status: "failed" })).body).toMatchObject({ status: "succeeded" });
    expect((await refreshRequest("GET")).body).toEqual(newer);

    const pending = (await refresh.get(channelId, newer.requestId))!;
    const updates = await Promise.all([
      refresh.put(channelId, { ...pending.value, status: "running" }, pending.revision),
      refresh.put(channelId, { ...pending.value, status: "running" }, pending.revision),
    ]);
    expect(updates.sort()).toEqual([false, true]);

    context.advance(120_001);
    expect((await refreshRequest("GET", undefined, newer.requestId)).status).toBe(204);
    expect((await refreshRequest("PUT", { requestId: newer.requestId, status: "succeeded" })).status).toBe(410);
    context.advance(60_000);
    const before = database.statements.length;
    expect((await refreshRequest("GET")).status).toBe(204);
    expect(database.statements.length - before).toBe(1);
    await expect(refresh.get(channelId, newer.requestId)).resolves.not.toBeNull();
    context.advance(86_400_000);
    await expect(refresh.get(channelId, newer.requestId)).resolves.toBeNull();
  });

  it("round-trips the maximum valid 700 KiB ciphertext through HTTP JSON and the real database row", async () => {
    const context = setup();
    const envelope = context.envelope(MAX_CIPHERTEXT_BYTES);
    expect(Buffer.from(envelope.ciphertext, "base64url")).toHaveLength(700 * 1024);
    expect((await context.snapshotRequest("PUT", envelope)).status).toBe(200);
    const download = await context.snapshotRequest("GET");
    expect(download.status).toBe(200);
    expect((download.body as StoredSnapshot).envelope).toEqual(envelope);
    const lastWrite = context.transportCalls.find(call => call.operation.op === "set")!;
    expect(lastWrite.status).toBe(200);
    expect(JSON.stringify(lastWrite.operation).length).toBeLessThan(2 * 1024 * 1024);
    context.advance(90 * 86_400_000);
    expect((await context.snapshotRequest("GET")).status).toBe(404);
  });
});
