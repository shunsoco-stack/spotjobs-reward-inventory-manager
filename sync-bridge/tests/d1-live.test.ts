import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { D1GatewayClient } from "../src/d1-client.js";
import { D1RefreshStore, D1SnapshotStore } from "../src/d1-storage.js";
import { handleRefreshRequest } from "../src/refresh-service.js";
import { handleSnapshotRequest } from "../src/service.js";
import { MemoryRateLimiter, type StoredSnapshot } from "../src/storage.js";
import type { RefreshCommand } from "../src/refresh-store.js";

// Explicit opt-in. This uses a fresh synthetic channel, not a real user's inbox.
// It does not change the production allowlist or connect to Redis/Blob.
describe.skipIf(process.env.SPOTLOG_D1_LIVE !== "1")("live D1 sync storage", () => {
  it("coalesces phone requests, carries the PC result, and preserves terminal state on real D1", async () => {
    const auth = randomBytes(32);
    const channelId = createHash("sha256").update(auth).digest("base64url");
    const authorization = `Bearer ${auth.toString("base64url")}`;
    const origin = "https://spotjobs-reward-inventory-manager.vercel.app";
    const gateway = new D1GatewayClient();
    const refresh = new D1RefreshStore(gateway);
    const snapshots = new D1SnapshotStore(gateway);
    const common = { rateLimiter: new MemoryRateLimiter(), allowedChannelIds: new Set([channelId]) };
    const createdIds = new Set<string>();
    const requestId = () => { const id = randomUUID(); createdIds.add(id); return id; };
    const refreshRequest = (method: string, body?: unknown, id?: string) => handleRefreshRequest(
      { method, channelId, authorization, origin, body, requestId: id },
      { ...common, store: refresh, requestId },
    );
    const snapshotRequest = (method: string, body?: unknown) => handleSnapshotRequest(
      { method, channelId, authorization, origin, body },
      { ...common, store: snapshots },
    );
    try {
      await expect(gateway.request({ op: "ping" })).resolves.toEqual({ ok: true });
      expect((await refreshRequest("GET")).status).toBe(204);
      expect((await snapshotRequest("GET")).status).toBe(404);
      const requests = await Promise.all([refreshRequest("POST", {}), refreshRequest("POST", {})]);
      expect(requests.map(result => result.status)).toEqual([200, 200]);
      const first = requests[0].body as RefreshCommand;
      expect((requests[1].body as RefreshCommand).requestId).toBe(first.requestId);
      expect((await refreshRequest("GET")).body).toEqual(first);
      expect((await refreshRequest("PUT", { requestId: first.requestId, status: "running" })).status).toBe(200);

      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", randomBytes(32), iv);
      const ciphertext = Buffer.concat([cipher.update('{"synthetic":true}'), cipher.final(), cipher.getAuthTag()]);
      const envelope = {
        version: 1, source: "spotjobs-edge", recordCount: 0,
        collectedAt: new Date().toISOString(), iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"),
      };
      const upload = await snapshotRequest("PUT", envelope);
      expect(upload.status).toBe(200);
      expect((await refreshRequest("PUT", { requestId: first.requestId, status: "succeeded" })).status).toBe(200);
      const result = await refreshRequest("GET", undefined, first.requestId);
      expect(result.body).toMatchObject({ requestId: first.requestId, status: "succeeded" });
      const downloaded = await snapshotRequest("GET");
      expect(downloaded.status).toBe(200);
      const stored = downloaded.body as StoredSnapshot;
      expect(stored.envelope).toEqual(envelope);
      expect(Date.parse(stored.storedAt)).toBeGreaterThanOrEqual(Date.parse(first.requestedAt));
      expect(Date.parse(stored.expiresAt) - Date.parse(stored.storedAt)).toBe(90 * 86_400_000);
      expect(downloaded.headers["Cache-Control"]).toContain("no-store");

      // Exercise the public protocol's largest allowed ciphertext on Workers Free.
      // This is synthetic binary data and the comparison never prints its contents.
      const largeEnvelope = { ...envelope, ciphertext: Buffer.alloc(700 * 1024, 7).toString("base64url") };
      expect((await snapshotRequest("PUT", largeEnvelope)).status).toBe(200);
      const largeDownload = await snapshotRequest("GET");
      expect(largeDownload.status).toBe(200);
      expect((largeDownload.body as StoredSnapshot).envelope.ciphertext.length).toBe(largeEnvelope.ciphertext.length);
      expect(createHash("sha256").update((largeDownload.body as StoredSnapshot).envelope.ciphertext).digest("hex"))
        .toBe(createHash("sha256").update(largeEnvelope.ciphertext).digest("hex"));

      const second = (await refreshRequest("POST", {})).body as RefreshCommand;
      expect(second.requestId).not.toBe(first.requestId);
      // An old acknowledgement cannot downgrade the terminal result or change latest.
      expect((await refreshRequest("PUT", { requestId: first.requestId, status: "failed" })).body)
        .toMatchObject({ status: "succeeded" });
      expect((await refreshRequest("GET")).body).toMatchObject({ requestId: second.requestId, status: "pending" });
      const pending = (await refresh.get(channelId, second.requestId))!;
      const updates = await Promise.all([
        refresh.put(channelId, { ...pending.value, status: "running" }, pending.revision),
        refresh.put(channelId, { ...pending.value, status: "running" }, pending.revision),
      ]);
      expect(updates.sort()).toEqual([false, true]);
      expect((await snapshotRequest("DELETE")).status).toBe(204);
      expect((await snapshotRequest("GET")).status).toBe(404);
    } finally {
      // Delete only this test's known keys; never enumerate or clear a database.
      const prefix = `spotlog:v1:${channelId}`;
      for (const key of [`${prefix}:snapshot`, `${prefix}:refresh:latest`, ...[...createdIds].map(id => `${prefix}:refresh:${id}`)]) {
        await gateway.request({ op: "delete", key });
      }
    }
  }, 60_000);
});
