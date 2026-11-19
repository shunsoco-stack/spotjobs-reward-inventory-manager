import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RedisRefreshStore, RedisSnapshotStore, REDIS_CAS_SCRIPT } from "../src/redis-storage.js";
import { type RedisCommand, type RedisExecutor } from "../src/redis-client.js";
import { handleRefreshRequest } from "../src/refresh-service.js";
import { type RefreshCommand } from "../src/refresh-store.js";
import { MemoryRateLimiter, type StoredSnapshot } from "../src/storage.js";

const authToken = Buffer.alloc(32, 36);
const channelId = createHash("sha256").update(authToken).digest("base64url");
const authorization = `Bearer ${authToken.toString("base64url")}`;
const epoch = Date.parse("2026-11-17T01:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const command: RefreshCommand = { requestId: uuid(1), requestedAt: new Date(epoch).toISOString(), expiresAt: new Date(epoch + 120_000).toISOString(), status: "pending" };
const snapshot: StoredSnapshot = {
  envelope: { version: 1, source: "spotjobs-edge", iv: Buffer.alloc(12, 4).toString("base64url"), ciphertext: Buffer.alloc(20, 8).toString("base64url"), recordCount: 1, collectedAt: new Date(epoch).toISOString() },
  storedAt: new Date(epoch).toISOString(), expiresAt: new Date(epoch + 7_776_000_000).toISOString(),
};

/** Models Redis's documented atomic CAS contract; live EVAL is verified at deployment. */
class TestRedis implements RedisExecutor {
  now = epoch;
  values = new Map<string, { raw: string; expires: number }>();
  calls: RedisCommand[] = [];

  private current(key: string) {
    const entry = this.values.get(key);
    if (entry && entry.expires <= this.now) this.values.delete(key);
    return this.values.get(key);
  }

  async command(args: RedisCommand): Promise<unknown> {
    this.calls.push(args);
    const key = String(args[args[0] === "EVAL" ? 3 : 1]);
    if (args[0] === "GET") return this.current(key)?.raw ?? null;
    if (args[0] === "DEL") return this.values.delete(key) ? 1 : 0;
    if (args[0] === "SET") {
      expect(args[3]).toBe("EX");
      this.values.set(key, { raw: String(args[2]), expires: this.now + Number(args[4]) * 1000 });
      return "OK";
    }
    expect(args[0]).toBe("EVAL");
    expect(args[1]).toBe(REDIS_CAS_SCRIPT);
    expect(args[2]).toBe(1);
    const current = this.current(key);
    const expected = args[4];
    if (expected === "" ? !!current : !current || JSON.parse(current.raw).revision !== expected) return 0;
    this.values.set(key, { raw: String(args[5]), expires: this.now + Number(args[6]) * 1000 });
    return 1;
  }
}

describe("Redis encrypted snapshots", () => {
  it("stores one ciphertext snapshot with its configured TTL and round-trips it", async () => {
    const redis = new TestRedis();
    const store = new RedisSnapshotStore(redis, () => redis.now);
    await expect(store.get(channelId)).resolves.toBeNull();
    await store.put(channelId, snapshot);
    expect(redis.calls[1]).toEqual(["SET", `spotlog:v1:${channelId}:snapshot`, JSON.stringify(snapshot), "EX", 7_776_000]);
    await expect(store.get(channelId)).resolves.toEqual(snapshot);
    await store.delete(channelId);
    await expect(store.get(channelId)).resolves.toBeNull();
  });

  it("returns expired snapshots as absent without a racy DEL after reading", async () => {
    const redis = { command: vi.fn<RedisExecutor["command"]>().mockResolvedValue(JSON.stringify(snapshot)) };
    const store = new RedisSnapshotStore(redis, () => Date.parse(snapshot.expiresAt));
    await expect(store.get(channelId)).resolves.toBeNull();
    expect(redis.command).toHaveBeenCalledOnce();
  });

  it("rejects corrupt data and failed writes instead of silently emptying history", async () => {
    for (const invalid of ["not-json", "{}", JSON.stringify({ ...snapshot, envelope: {} }), 12]) {
      const store = new RedisSnapshotStore({ command: vi.fn<RedisExecutor["command"]>().mockResolvedValue(invalid) });
      await expect(store.get(channelId)).rejects.toMatchObject({ code: "redis_invalid_data" });
    }
    const redis = { command: vi.fn<RedisExecutor["command"]>().mockResolvedValue(null) };
    const store = new RedisSnapshotStore(redis, () => epoch);
    await expect(store.put(channelId, snapshot)).rejects.toMatchObject({ code: "redis_invalid_response" });
    await expect(store.put(channelId, { ...snapshot, expiresAt: new Date(epoch).toISOString() })).rejects.toMatchObject({ code: "redis_invalid_data" });
  });
});

describe("Redis refresh commands", () => {
  it("atomically rejects duplicate creation and stale revisions", async () => {
    const redis = new TestRedis();
    const store = new RedisRefreshStore(redis);
    const creations = await Promise.all([store.put(channelId, command, null), store.put(channelId, command, null)]);
    expect(creations.sort()).toEqual([false, true]);
    const first = (await store.get(channelId, command.requestId))!;
    expect(first.value).toEqual(command);
    const writes = await Promise.all([
      store.put(channelId, { ...command, status: "running" }, first.revision),
      store.put(channelId, { ...command, status: "running" }, first.revision),
    ]);
    expect(writes.sort()).toEqual([false, true]);
    const latest = (await store.get(channelId, command.requestId))!;
    expect(latest.revision).not.toBe(first.revision);
    expect(redis.calls.filter(call => call[0] === "EVAL").every(call => call[6] === 86400)).toBe(true);
  });

  it("expires the latest pointer after180seconds while retaining command ACK history for1day", async () => {
    const redis = new TestRedis();
    const store = new RedisRefreshStore(redis);
    await store.put(channelId, command, null);
    await store.setLatest(channelId, command.requestId, null);
    const pointer = (await store.latest(channelId))!;
    await expect(store.setLatest(channelId, uuid(2), null)).resolves.toBe(false);
    await expect(store.setLatest(channelId, uuid(2), pointer.revision)).resolves.toBe(true);
    redis.now += 180_000;
    await expect(store.latest(channelId)).resolves.toBeNull();
    await expect(store.get(channelId, command.requestId)).resolves.toMatchObject({ value: command });
    const before = redis.calls.length;
    expect((await handleRefreshRequest({ method: "GET", channelId, authorization }, { store, rateLimiter: new MemoryRateLimiter(), allowedChannelIds: new Set([channelId]) })).status).toBe(204);
    expect(redis.calls.slice(before).map(call => call[0])).toEqual(["GET"]);
    redis.now = epoch + 86_400_000;
    await expect(store.get(channelId, command.requestId)).resolves.toBeNull();
  });

  it("coalesces concurrent phone requests and preserves terminal ACKs through the real service", async () => {
    const redis = new TestRedis();
    const store = new RedisRefreshStore(redis);
    let id = 0;
    const dependencies = { store, rateLimiter: new MemoryRateLimiter(), allowedChannelIds: new Set([channelId]), now: () => new Date(redis.now), requestId: () => uuid(++id) };
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

  it("rejects malformed metadata, mismatched request IDs and invalid write responses", async () => {
    const redis = { command: vi.fn<RedisExecutor["command"]>() };
    const store = new RedisRefreshStore(redis);
    for (const raw of ["bad-json", "{}", JSON.stringify({ value: command, revision: "bad-revision" }), JSON.stringify({ value: { ...command, requestId: uuid(2) }, revision: uuid(3) })]) {
      redis.command.mockResolvedValueOnce(raw);
      await expect(store.get(channelId, command.requestId)).rejects.toMatchObject({ code: "redis_invalid_data" });
    }
    redis.command.mockResolvedValueOnce(JSON.stringify({ value: { requestId: "bad-id" }, revision: uuid(3) }));
    await expect(store.latest(channelId)).rejects.toMatchObject({ code: "redis_invalid_data" });
    redis.command.mockResolvedValueOnce("OK");
    await expect(store.put(channelId, command, null)).rejects.toMatchObject({ code: "redis_invalid_response" });
    await expect(store.put(channelId, command, "bad-revision")).rejects.toMatchObject({ code: "redis_invalid_data" });
  });

  it("keeps channel key spaces separate and rejects unsafe identifiers", async () => {
    const redis = new TestRedis();
    const store = new RedisRefreshStore(redis);
    await store.put(channelId, command, null);
    await expect(store.get(Buffer.alloc(32, 18).toString("base64url"), command.requestId)).resolves.toBeNull();
    await expect(store.get(channelId, "../other-key")).rejects.toMatchObject({ code: "redis_invalid_data" });
    await expect(store.latest("../other-channel")).rejects.toMatchObject({ code: "redis_invalid_data" });
    await store.delete(channelId, command.requestId);
    await expect(store.get(channelId, command.requestId)).resolves.toBeNull();
  });
});
