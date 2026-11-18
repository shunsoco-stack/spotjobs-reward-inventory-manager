import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { D1RefreshStore, D1SnapshotStore } from "../src/d1-storage.js";
import type { D1GatewayExecutor, D1GatewayRequest, D1GatewayResult } from "../src/d1-client.js";
import { handleRefreshRequest } from "../src/refresh-service.js";
import type { RefreshCommand } from "../src/refresh-store.js";
import { MemoryRateLimiter, type StoredSnapshot } from "../src/storage.js";

const authToken = Buffer.alloc(32, 36);
const channelId = createHash("sha256").update(authToken).digest("base64url");
const authorization = `Bearer ${authToken.toString("base64url")}`;
const epoch = Date.parse("2026-11-19T01:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const command: RefreshCommand = { requestId: uuid(1), requestedAt: new Date(epoch).toISOString(), expiresAt: new Date(epoch + 120_000).toISOString(), status: "pending" };
const snapshot: StoredSnapshot = {
  envelope: { version: 1, source: "spotjobs-edge", iv: Buffer.alloc(12, 4).toString("base64url"), ciphertext: Buffer.alloc(20, 8).toString("base64url"), recordCount: 1, collectedAt: new Date(epoch).toISOString() },
  storedAt: new Date(epoch).toISOString(), expiresAt: new Date(epoch + 7_776_000_000).toISOString(),
};

/** Models the gateway's atomic contract; the Worker tests cover actual SQL CAS. */
class TestGateway implements D1GatewayExecutor {
  now = epoch;
  values = new Map<string, { raw: string; revision: string | null; expiresAt: number }>();
  calls: D1GatewayRequest[] = [];

  private current(key: string) {
    const entry = this.values.get(key);
    return entry && entry.expiresAt > this.now ? entry : undefined;
  }

  async request(command: D1GatewayRequest): Promise<D1GatewayResult> {
    this.calls.push(command);
    if (command.op === "ping") return { ok: true };
    if (command.op === "get") return { ok: true, value: this.current(command.key)?.raw ?? null };
    if (command.op === "delete") { this.values.delete(command.key); return { ok: true }; }
    if (command.op === "set") {
      this.values.set(command.key, { raw: command.value, revision: null, expiresAt: command.expiresAt });
      return { ok: true };
    }
    const current = this.current(command.key);
    if (command.expectedRevision === null ? !!current : !current || current.revision !== command.expectedRevision) {
      return { ok: true, applied: false };
    }
    expect(JSON.parse(command.value).revision).toBe(command.revision);
    this.values.set(command.key, { raw: command.value, revision: command.revision, expiresAt: command.expiresAt });
    return { ok: true, applied: true };
  }
}

describe("D1 encrypted snapshot adapter", () => {
  it("round-trips ciphertext and uses an absolute expiration timestamp", async () => {
    const gateway = new TestGateway();
    const store = new D1SnapshotStore(gateway, () => gateway.now);
    await expect(store.get(channelId)).resolves.toBeNull();
    await store.put(channelId, snapshot);
    expect(gateway.calls[1]).toEqual({ op: "set", key: `spotlog:v1:${channelId}:snapshot`, value: JSON.stringify(snapshot), expiresAt: epoch + 7_776_000_000 });
    await expect(store.get(channelId)).resolves.toEqual(snapshot);
    await store.delete(channelId);
    await expect(store.get(channelId)).resolves.toBeNull();
  });

  it("treats expired snapshots as absent without deleting a concurrently replaced row", async () => {
    const gateway = { request: vi.fn<D1GatewayExecutor["request"]>().mockResolvedValue({ ok: true, value: JSON.stringify(snapshot) }) };
    const store = new D1SnapshotStore(gateway, () => Date.parse(snapshot.expiresAt));
    await expect(store.get(channelId)).resolves.toBeNull();
    expect(gateway.request).toHaveBeenCalledOnce();
  });

  it("does not mistake corrupted data for missing history", async () => {
    for (const invalid of ["not-json", "{}", JSON.stringify({ ...snapshot, envelope: {} }), undefined]) {
      const store = new D1SnapshotStore({ request: vi.fn<D1GatewayExecutor["request"]>().mockResolvedValue({ ok: true, value: invalid }) });
      await expect(store.get(channelId)).rejects.toMatchObject({ code: "d1_invalid_data" });
    }
    const gateway = new TestGateway();
    const store = new D1SnapshotStore(gateway, () => epoch);
    await expect(store.put(channelId, { ...snapshot, expiresAt: new Date(epoch).toISOString() })).rejects.toMatchObject({ code: "d1_invalid_data" });
    expect(gateway.calls).toHaveLength(0);
  });
});

describe("D1 refresh adapter", () => {
  it("uses a single atomic CAS for duplicate creation and stale revision rejection", async () => {
    const gateway = new TestGateway();
    const store = new D1RefreshStore(gateway, () => gateway.now);
    expect((await Promise.all([store.put(channelId, command, null), store.put(channelId, command, null)])).sort()).toEqual([false, true]);
    const first = (await store.get(channelId, command.requestId))!;
    const results = await Promise.all([
      store.put(channelId, { ...command, status: "running" }, first.revision),
      store.put(channelId, { ...command, status: "running" }, first.revision),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect((await store.get(channelId, command.requestId))!.revision).not.toBe(first.revision);
    const writes = gateway.calls.filter(call => call.op === "cas");
    expect(writes).toHaveLength(4);
    expect(writes.every(call => call.expiresAt === epoch + 86_400_000)).toBe(true);
  });

  it("expires the latest pointer at 180 seconds but retains command acknowledgements for one day", async () => {
    const gateway = new TestGateway();
    const store = new D1RefreshStore(gateway, () => gateway.now);
    await store.put(channelId, command, null);
    await store.setLatest(channelId, command.requestId, null);
    const pointer = (await store.latest(channelId))!;
    await expect(store.setLatest(channelId, uuid(2), null)).resolves.toBe(false);
    await expect(store.setLatest(channelId, uuid(2), pointer.revision)).resolves.toBe(true);
    gateway.now += 180_000;
    await expect(store.latest(channelId)).resolves.toBeNull();
    await expect(store.get(channelId, command.requestId)).resolves.toMatchObject({ value: command });
    const before = gateway.calls.length;
    const response = await handleRefreshRequest({ method: "GET", channelId, authorization }, {
      store, rateLimiter: new MemoryRateLimiter(), allowedChannelIds: new Set([channelId]),
    });
    expect(response.status).toBe(204);
    expect(gateway.calls.slice(before).map(call => call.op)).toEqual(["get"]);
    gateway.now = epoch + 86_400_000;
    await expect(store.get(channelId, command.requestId)).resolves.toBeNull();
  });

  it("coalesces phone requests and protects a newer request from stale acknowledgements", async () => {
    const gateway = new TestGateway();
    const store = new D1RefreshStore(gateway, () => gateway.now);
    let id = 0;
    const dependencies = { store, rateLimiter: new MemoryRateLimiter(), allowedChannelIds: new Set([channelId]), now: () => new Date(gateway.now), requestId: () => uuid(++id) };
    const request = (method: string, body?: unknown, requestId?: string) => handleRefreshRequest({ method, channelId, authorization, body, requestId }, dependencies);
    const responses = await Promise.all([request("POST", {}), request("POST", {}), request("POST", {})]);
    expect(responses.every(response => response.status === 200)).toBe(true);
    const ids = responses.map(response => (response.body as RefreshCommand).requestId);
    expect(new Set(ids).size).toBe(1);
    await Promise.all([request("PUT", { requestId: ids[0], status: "running" }), request("PUT", { requestId: ids[0], status: "succeeded" })]);
    expect((await request("GET")).body).toMatchObject({ requestId: ids[0], status: "succeeded" });
    const newer = (await request("POST", {})).body as RefreshCommand;
    expect(newer.requestId).not.toBe(ids[0]);
    await request("PUT", { requestId: ids[0], status: "failed" });
    expect((await request("GET")).body).toEqual(newer);
    expect((await request("GET", undefined, ids[0])).body).toMatchObject({ status: "succeeded" });
  });

  it("rejects malformed records, mismatched IDs, and invalid CAS responses", async () => {
    const gateway = { request: vi.fn<D1GatewayExecutor["request"]>() };
    const store = new D1RefreshStore(gateway);
    for (const value of ["bad-json", "{}", JSON.stringify({ value: command, revision: "bad-revision" }), JSON.stringify({ value: { ...command, requestId: uuid(2) }, revision: uuid(3) })]) {
      gateway.request.mockResolvedValueOnce({ ok: true, value });
      await expect(store.get(channelId, command.requestId)).rejects.toMatchObject({ code: "d1_invalid_data" });
    }
    gateway.request.mockResolvedValueOnce({ ok: true, value: JSON.stringify({ value: { requestId: "bad-id" }, revision: uuid(3) }) });
    await expect(store.latest(channelId)).rejects.toMatchObject({ code: "d1_invalid_data" });
    gateway.request.mockResolvedValueOnce({ ok: true });
    await expect(store.put(channelId, command, null)).rejects.toMatchObject({ code: "d1_invalid_response" });
    await expect(store.put(channelId, command, "bad-revision")).rejects.toMatchObject({ code: "d1_invalid_data" });
  });

  it("isolates channels and rejects unsafe identifiers", async () => {
    const gateway = new TestGateway();
    const store = new D1RefreshStore(gateway, () => gateway.now);
    await store.put(channelId, command, null);
    await expect(store.get(Buffer.alloc(32, 18).toString("base64url"), command.requestId)).resolves.toBeNull();
    await expect(store.get(channelId, "../other-key")).rejects.toMatchObject({ code: "d1_invalid_data" });
    await expect(store.latest("../other-channel")).rejects.toMatchObject({ code: "d1_invalid_data" });
    await store.delete(channelId, command.requestId);
    await expect(store.get(channelId, command.requestId)).resolves.toBeNull();
  });
});
