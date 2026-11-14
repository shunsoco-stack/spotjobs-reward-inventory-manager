import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteRemoteSpotJobsSnapshot, pullSpotJobsSnapshot, syncFromBridge, SyncBridgeError } from "./client";
import { clearSyncPreferences, loadSyncPreferences, resolveSyncBridgeUrl, saveSyncPreferences, SYNC_PREFERENCES_KEY, updateSyncPreferences } from "./preferences";
import { deriveSyncCredentials, encryptSyncSnapshot } from "./protocol";
import type { SpotJobsSyncSnapshot } from "./import";
import { defaultSettings } from "../core";

const syncCode = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const payload: SpotJobsSyncSnapshot = {
  version: 1, collectedAt: "2026-11-13T03:00:00.000Z", sourceVersion: "spotlog-edge/0.1.0",
  records: [{
    externalId: "job-1", workType: "BATTERY_EJECT", completedAt: "2026-11-13T02:00:00.000Z",
    quantity: 2, storeName: "駅前店", estimatedReward: 0, earlyRefill: null,
  }],
};

let memory: Map<string, string>;
beforeAll(() => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
});
beforeEach(() => {
  memory = new Map();
  vi.stubGlobal("window", { localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("sync bridge client", () => {
  it("authenticates, decrypts, and validates the documented GET wrapper", async () => {
    const credentials = await deriveSyncCredentials(syncCode);
    const envelope = await encryptSyncSnapshot(payload, credentials);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${credentials.bearerToken}`);
      return new Response(JSON.stringify({ envelope, storedAt: "2026-11-13T03:01:00.000Z", expiresAt: "2027-02-11T03:01:00.000Z" }), { status: 200 });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const pulled = await pullSpotJobsSnapshot({ syncCode, bridgeUrl: "http://localhost:3001", fetchImpl });
    expect(pulled).toEqual({ snapshot: payload, channelId: credentials.channelId, storedAt: "2026-11-13T03:01:00.000Z", expiresAt: "2027-02-11T03:01:00.000Z" });
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/api/v1/snapshot/${credentials.channelId}`);
  });

  it("maps missing snapshots and invalid wrappers to safe typed errors", async () => {
    const missing = vi.fn(async () => new Response(JSON.stringify({ error: { code: "snapshot_not_found" } }), { status: 404 })) as unknown as typeof fetch;
    await expect(pullSpotJobsSnapshot({ syncCode, bridgeUrl: "http://localhost", fetchImpl: missing })).rejects.toMatchObject({ code: "not-found" });
    const invalid = vi.fn(async () => new Response(JSON.stringify({ envelope: {}, storedAt: "bad", expiresAt: "bad" }), { status: 200 })) as unknown as typeof fetch;
    await expect(pullSpotJobsSnapshot({ syncCode, bridgeUrl: "http://localhost", fetchImpl: invalid })).rejects.toThrow();
  });

  it("imports the full snapshot on a fresh cross-device connection without a cutoff", async () => {
    const credentials = await deriveSyncCredentials(syncCode);
    const envelope = await encryptSyncSnapshot(payload, credentials);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      envelope,
      storedAt: "2026-11-13T03:01:00.000Z",
      expiresAt: "2027-02-11T03:01:00.000Z",
    }), { status: 200 })) as unknown as typeof fetch;
    const data = { version: 2 as const, records: [], settings: structuredClone(defaultSettings), lastArea: "omitted" as const };

    const result = await syncFromBridge(data, {
      syncCode,
      bridgeUrl: "http://localhost",
      fetchImpl,
    });

    expect(result.imported).toBe(1);
    expect(result.data.records).toHaveLength(1);
    expect(result.data.records[0]).toMatchObject({
      id: "spotjobs:job-1",
      type: "pickup",
      quantity: 2,
      createdAt: "2026-11-13T02:00:00.000Z",
    });
  });

  it("protects existing manual history only when an explicit future-only cutoff is set", async () => {
    const credentials = await deriveSyncCredentials(syncCode);
    const envelope = await encryptSyncSnapshot(payload, credentials);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      envelope,
      storedAt: "2026-11-13T03:01:00.000Z",
      expiresAt: "2027-02-11T03:01:00.000Z",
    }), { status: 200 })) as unknown as typeof fetch;
    const data = { version: 2 as const, records: [], settings: structuredClone(defaultSettings), lastArea: "omitted" as const };
    const result = await syncFromBridge(data, {
      syncCode,
      bridgeUrl: "http://localhost",
      fetchImpl,
      importAfter: "2026-11-13T02:30:00.000Z",
    });
    expect(result.imported).toBe(0);
    expect(result.data.records).toHaveLength(0);
  });

  it("deletes only the remote encrypted snapshot and accepts an already-empty channel", async () => {
    const remove = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await expect(deleteRemoteSpotJobsSnapshot({ syncCode, bridgeUrl: "http://localhost", fetchImpl: remove })).resolves.toBeUndefined();
    const absent = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(deleteRemoteSpotJobsSnapshot({ syncCode, bridgeUrl: "http://localhost", fetchImpl: absent })).resolves.toBeUndefined();
  });

  it("uses a fixed production bridge and permits overrides only on localhost", () => {
    expect(resolveSyncBridgeUrl()).toBe("https://spotjobs-reward-inventory-sync.vercel.app");
    expect(resolveSyncBridgeUrl("http://127.0.0.1:9000/")).toBe("http://127.0.0.1:9000");
    expect(() => resolveSyncBridgeUrl("https://example.com")).toThrow("ローカル開発");
  });
});

describe("device-local sync preferences", () => {
  it("keeps the pairing code outside AppData and records safe status metadata", () => {
    const saved = saveSyncPreferences({
      enabled: true, syncCode, lastStatus: "success", lastAttemptAt: "2026-11-13T03:00:00Z",
      lastSuccessAt: "2026-11-13T03:00:01Z", importAfter: "2026-11-13T02:59:00Z", lastMessage: "2件を同期しました",
    });
    expect(saved.syncCode).toBe(syncCode);
    expect(loadSyncPreferences()).toEqual(saved);
    expect(updateSyncPreferences({ lastMessage: "更新済み" })).toMatchObject({ enabled: true, syncCode, lastMessage: "更新済み" });
    expect(memory.get(SYNC_PREFERENCES_KEY)).toContain(syncCode);
    clearSyncPreferences();
    expect(loadSyncPreferences()).toEqual({ enabled: false });
  });

  it("never enables a corrupt or missing pairing code", () => {
    expect(() => saveSyncPreferences({ enabled: true })).toThrow("同期コード");
    memory.set(SYNC_PREFERENCES_KEY, JSON.stringify({ enabled: true, syncCode: "broken" }));
    expect(loadSyncPreferences()).toEqual({ enabled: false });
    expect(new SyncBridgeError("x", "unavailable").code).toBe("unavailable");
  });
});
