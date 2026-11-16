import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UpstashRestClient } from "../src/redis-client.js";
import { RedisRefreshStore, RedisSnapshotStore } from "../src/redis-storage.js";
import type { RefreshCommand } from "../src/refresh-store.js";
import type { StoredSnapshot } from "../src/storage.js";

// Explicit opt-in only. All values are synthetic and keys use a fresh random
// channel unrelated to any user's configured channel. No credentials are logged.
describe.skipIf(process.env.SPOTLOG_REDIS_LIVE !== "1")("live Redis atomic storage", () => {
  it("executes real Lua CAS, keeps revisions separate, and applies all expiration policies", async () => {
    const channelId = randomBytes(32).toString("base64url");
    const requestId = randomUUID();
    const prefix = `spotlog:v1:${channelId}`;
    const keys = [`${prefix}:snapshot`, `${prefix}:refresh:latest`, `${prefix}:refresh:${requestId}`];
    const redis = new UpstashRestClient();
    const refresh = new RedisRefreshStore(redis);
    const snapshots = new RedisSnapshotStore(redis);
    const now = Date.now();
    const command: RefreshCommand = {
      requestId, requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 120_000).toISOString(), status: "pending",
    };
    const snapshot: StoredSnapshot = {
      envelope: {
        version: 1, source: "spotjobs-edge", recordCount: 0, collectedAt: new Date(now).toISOString(),
        iv: Buffer.alloc(12, 7).toString("base64url"), ciphertext: Buffer.alloc(20, 8).toString("base64url"),
      },
      storedAt: new Date(now).toISOString(), expiresAt: new Date(now + 7_776_000_000).toISOString(),
    };
    try {
      await expect(refresh.latest(channelId)).resolves.toBeNull();
      const creations = await Promise.all([refresh.put(channelId, command, null), refresh.put(channelId, command, null)]);
      expect(creations.sort()).toEqual([false, true]);
      const first = (await refresh.get(channelId, requestId))!;
      expect(first.value).toEqual(command);
      await expect(refresh.put(channelId, { ...command, status: "running" }, first.revision)).resolves.toBe(true);
      await expect(refresh.put(channelId, command, first.revision)).resolves.toBe(false);
      const running = (await refresh.get(channelId, requestId))!;
      expect(running.revision).not.toBe(first.revision);
      expect(running.value.status).toBe("running");
      await expect(refresh.setLatest(channelId, requestId, null)).resolves.toBe(true);
      await expect(refresh.setLatest(channelId, randomUUID(), null)).resolves.toBe(false);
      expect((await refresh.latest(channelId))?.value.requestId).toBe(requestId);
      await snapshots.put(channelId, snapshot);
      await expect(snapshots.get(channelId)).resolves.toEqual(snapshot);
      for (const [key, maximum] of [[keys[0], 7_776_000], [keys[1], 180], [keys[2], 86_400]] as const) {
        const ttl = await redis.command(["TTL", key]);
        expect(typeof ttl).toBe("number");
        expect(Number(ttl)).toBeGreaterThan(0);
        expect(Number(ttl)).toBeLessThanOrEqual(maximum);
      }
      await snapshots.delete(channelId);
      await expect(snapshots.get(channelId)).resolves.toBeNull();
    } finally {
      // Delete only this test's exact keys, including the short-lived pointer.
      await redis.command(["DEL", ...keys]);
    }
  }, 30_000);
});
