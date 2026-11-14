import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock("@vercel/blob", () => ({ ...mocks, BlobPreconditionFailedError: class extends Error {} }));
import { BlobPreconditionFailedError } from "@vercel/blob";
import { VercelBlobRefreshStore, type RefreshCommand } from "../src/refresh-store.js";

const channelId = Buffer.alloc(32, 11).toString("base64url");
const command: RefreshCommand = {
  requestId: "00000000-0000-4000-8000-000000000001",
  requestedAt: "2026-11-15T01:00:00.000Z",
  expiresAt: "2026-11-15T01:02:00.000Z",
  status: "pending",
};
const response = (value: unknown) => ({ statusCode: 200, stream: new Blob([JSON.stringify(value)]).stream(), blob: { etag: "etag-1" } });

describe("private refresh Blob storage", () => {
  beforeEach(() => vi.resetAllMocks());

  it("bypasses CDN caches when reading commands and the latest pointer", async () => {
    const store = new VercelBlobRefreshStore("private-token");
    mocks.get.mockResolvedValueOnce(response(command));
    await expect(store.get(channelId, command.requestId)).resolves.toEqual({ value: command, revision: "etag-1" });
    mocks.get.mockResolvedValueOnce(response({ requestId: command.requestId }));
    await expect(store.latest(channelId)).resolves.toEqual({ value: { requestId: command.requestId }, revision: "etag-1" });
    for (const call of mocks.get.mock.calls) expect(call[1]).toEqual({ access: "private", useCache: false, token: "private-token" });
  });

  it("uses ETags for updates, first-write protection for creation, and automatic metadata deletion", async () => {
    const store = new VercelBlobRefreshStore("private-token");
    mocks.put.mockResolvedValue({});
    await expect(store.put(channelId, command, null)).resolves.toBe(true);
    await expect(store.put(channelId, { ...command, status: "running" }, "etag-1")).resolves.toBe(true);
    await expect(store.setLatest(channelId, command.requestId, "pointer-etag")).resolves.toBe(true);
    expect(mocks.put.mock.calls[0][2]).toMatchObject({ access: "private", allowOverwrite: false, addRandomSuffix: false, ttlDays: 1 });
    expect(mocks.put.mock.calls[1][2]).toMatchObject({ allowOverwrite: true, ifMatch: "etag-1", ttlDays: 1 });
    expect(mocks.put.mock.calls[2][2]).toMatchObject({ ifMatch: "pointer-etag" });
  });

  it("returns conflicts instead of overwriting a state changed by another function", async () => {
    const store = new VercelBlobRefreshStore();
    mocks.put.mockRejectedValue(new BlobPreconditionFailedError());
    await expect(store.put(channelId, command, "old-etag")).resolves.toBe(false);
  });

  it("handles concurrent initial creation only when the path exists", async () => {
    const store = new VercelBlobRefreshStore();
    mocks.put.mockRejectedValue(new Error("Already exists"));
    mocks.get.mockResolvedValueOnce(response(command));
    await expect(store.put(channelId, command, null)).resolves.toBe(false);
    mocks.get.mockResolvedValueOnce(null);
    await expect(store.put(channelId, command, null)).rejects.toThrow("Already exists");
  });

  it("rejects malformed data, invalid terminal state and mismatched IDs", async () => {
    const store = new VercelBlobRefreshStore();
    for (const value of [{}, { ...command, status: "succeeded" }, { ...command, requestId: "bad-id" }, { ...command, expiresAt: "invalid" }]) {
      mocks.get.mockResolvedValueOnce(response(value));
      await expect(store.get(channelId, command.requestId)).resolves.toBeNull();
    }
  });
});
