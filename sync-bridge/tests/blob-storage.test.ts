import { beforeEach, describe, expect, it, vi } from "vitest";

const blobMocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@vercel/blob", () => blobMocks);

import { VercelBlobSnapshotStore, type StoredSnapshot } from "../src/storage.js";

const channelId = Buffer.alloc(32, 5).toString("base64url");
const stored: StoredSnapshot = {
  envelope: {
    version: 1,
    iv: Buffer.alloc(12, 4).toString("base64url"),
    ciphertext: Buffer.alloc(20, 8).toString("base64url"),
    recordCount: 1,
    source: "spotjobs-edge",
    collectedAt: "2026-11-13T01:00:00.000Z",
  },
  storedAt: "2026-11-13T01:01:00.000Z",
  expiresAt: "2026-11-14T01:01:00.000Z",
};

describe("private Vercel Blob storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("overwrites one deterministic private ciphertext blob per channel", async () => {
    blobMocks.put.mockResolvedValue({});
    const store = new VercelBlobSnapshotStore("private-token");
    await store.put(channelId, stored);

    expect(blobMocks.put).toHaveBeenCalledWith(
      `snapshots/${channelId}.json`,
      JSON.stringify(stored),
      expect.objectContaining({
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
        token: "private-token",
      }),
    );
  });

  it("reads a valid private ciphertext snapshot", async () => {
    blobMocks.get.mockResolvedValue({
      statusCode: 200,
      stream: new Blob([JSON.stringify(stored)]).stream(),
    });
    const store = new VercelBlobSnapshotStore(
      "private-token",
      () => Date.parse("2026-11-13T02:00:00.000Z"),
    );
    await expect(store.get(channelId)).resolves.toEqual(stored);
    expect(blobMocks.get).toHaveBeenCalledWith(`snapshots/${channelId}.json`, {
      access: "private",
      useCache: false,
      token: "private-token",
    });
  });

  it("treats an expired snapshot as absent and deletes it best-effort", async () => {
    blobMocks.get.mockResolvedValue({
      statusCode: 200,
      stream: new Blob([JSON.stringify(stored)]).stream(),
    });
    blobMocks.del.mockResolvedValue(undefined);
    const store = new VercelBlobSnapshotStore(
      "private-token",
      () => Date.parse("2026-11-15T00:00:00.000Z"),
    );
    await expect(store.get(channelId)).resolves.toBeNull();
    expect(blobMocks.del).toHaveBeenCalledWith(`snapshots/${channelId}.json`, {
      token: "private-token",
    });
  });

  it("deletes the deterministic private blob", async () => {
    blobMocks.del.mockResolvedValue(undefined);
    const store = new VercelBlobSnapshotStore("private-token");
    await store.delete(channelId);
    expect(blobMocks.del).toHaveBeenCalledWith(`snapshots/${channelId}.json`, {
      token: "private-token",
    });
  });
});
