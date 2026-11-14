import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleRefreshRequest, type RefreshDependencies, type RefreshRequest } from "../src/refresh-service.js";
import { MemoryRefreshStore, type RefreshCommand } from "../src/refresh-store.js";
import { MemoryRateLimiter } from "../src/storage.js";

const authToken = Buffer.alloc(32, 21);
const authorization = `Bearer ${authToken.toString("base64url")}`;
const channelId = createHash("sha256").update(authToken).digest("base64url");
const origin = "https://spotjobs-reward-inventory-manager.vercel.app";
const epoch = Date.parse("2026-11-15T01:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function setup(overrides: Partial<RefreshDependencies> = {}) {
  let current = epoch;
  let id = 0;
  const deps: RefreshDependencies = {
    store: new MemoryRefreshStore(),
    rateLimiter: new MemoryRateLimiter(() => current),
    allowedChannelIds: new Set([channelId]),
    now: () => new Date(current),
    requestId: () => uuid(++id),
    ...overrides,
  };
  const request = (method: string, options: Partial<RefreshRequest> = {}) => handleRefreshRequest({ method, channelId, authorization, origin, ...options }, deps);
  const create = async () => (await request("POST", { body: {} })).body as RefreshCommand;
  return { deps, request, create, advance: (ms: number) => { current += ms; } };
}

describe("PC refresh request service", () => {
  it("creates a command and returns it through latest and request-specific reads", async () => {
    const { request, create } = setup();
    expect((await request("GET")).status).toBe(204);
    const command = await create();
    expect(command).toEqual({ requestId: uuid(1), requestedAt: "2026-11-15T01:00:00.000Z", expiresAt: "2026-11-15T01:02:00.000Z", status: "pending" });
    expect((await request("GET")).body).toEqual(command);
    const byId = await request("GET", { requestId: command.requestId });
    expect(byId.body).toEqual(command);
    expect(byId.headers["Cache-Control"]).toContain("no-store");
  });

  it("coalesces pending and running requests, including simultaneous creation", async () => {
    const { request } = setup();
    const created = await Promise.all([request("POST", { body: {} }), request("POST", { body: {} }), request("POST", { body: {} })]);
    expect(created.every((response) => response.status === 200)).toBe(true);
    const ids = created.map((response) => (response.body as RefreshCommand).requestId);
    expect(new Set(ids).size).toBe(1);
    await request("PUT", { body: { requestId: ids[0], status: "running" } });
    expect((await request("POST")).body).toMatchObject({ requestId: ids[0], status: "running" });
  });

  it("marks successful completion only through acknowledgement and keeps terminal state immutable", async () => {
    const { request, create, advance } = setup();
    const command = await create();
    await request("PUT", { body: { requestId: command.requestId, status: "running" } });
    advance(8000);
    const completed = await request("PUT", { body: { requestId: command.requestId, status: "succeeded" } });
    expect(completed.body).toEqual({ ...command, status: "succeeded", completedAt: "2026-11-15T01:00:08.000Z" });
    for (const status of ["running", "failed", "succeeded"]) {
      expect((await request("PUT", { body: { requestId: command.requestId, status } })).body).toEqual(completed.body);
    }
  });

  it("never downgrades a terminal acknowledgement under simultaneous writes", async () => {
    const { request, create } = setup();
    const command = await create();
    await Promise.all([
      request("PUT", { body: { requestId: command.requestId, status: "running" } }),
      request("PUT", { body: { requestId: command.requestId, status: "succeeded" } }),
    ]);
    expect((await request("GET")).body).toMatchObject({ status: "succeeded", completedAt: expect.any(String) });
  });

  it("keeps acknowledgements for older commands separate from the newest command", async () => {
    const { request, create, advance } = setup();
    const first = await create();
    await request("PUT", { body: { requestId: first.requestId, status: "succeeded" } });
    advance(1000);
    const second = await create();
    expect(second.requestId).not.toBe(first.requestId);
    await request("PUT", { body: { requestId: first.requestId, status: "failed" } });
    expect((await request("GET")).body).toEqual(second);
    expect((await request("GET", { requestId: first.requestId })).body).toMatchObject({ status: "succeeded" });
  });

  it("expires abandoned commands and rejects late acknowledgements", async () => {
    const { request, create, advance } = setup();
    const command = await create();
    advance(120000);
    expect((await request("GET")).status).toBe(204);
    expect((await request("GET", { requestId: command.requestId })).status).toBe(204);
    const late = await request("PUT", { body: { requestId: command.requestId, status: "succeeded" } });
    expect(late.status).toBe(410);
    expect(late.body).toMatchObject({ error: { code: "refresh_expired" } });
    expect((await create()).requestId).not.toBe(command.requestId);
  });

  it("stores only allowlisted failure codes with completion timestamps", async () => {
    const { request, create } = setup();
    for (const errorCode of ["auth_required", "page_required", "disabled", "sync_failed"]) {
      const command = await create();
      const failed = await request("PUT", { body: { requestId: command.requestId, status: "failed", errorCode } });
      expect(failed.body).toMatchObject({ status: "failed", errorCode, completedAt: expect.any(String) });
    }
  });

  it("rejects arbitrary payloads and sensitive freeform errors", async () => {
    const { request, create } = setup();
    const command = await create();
    expect((await request("POST", { body: { history: [] } })).status).toBe(400);
    expect((await request("POST", { body: [] })).status).toBe(400);
    expect((await request("PUT", { body: { requestId: command.requestId, status: "failed", errorCode: "session-token" } })).status).toBe(400);
    expect((await request("PUT", { body: { requestId: command.requestId, status: "failed", message: "store name" } })).status).toBe(400);
    expect((await request("PUT", { body: { requestId: command.requestId, status: "succeeded", errorCode: "sync_failed" } })).status).toBe(400);
    expect((await request("PUT", { body: { requestId: command.requestId, status: { toString: null } } })).status).toBe(400);
    expect((await request("GET", { requestId: "../other-channel" })).status).toBe(400);
    expect((await request("POST", { contentLength: 1025 })).status).toBe(413);
    expect((await request("POST", { body: { text: "x".repeat(1025) } })).status).toBe(413);
  });

  it("requires matching credentials and a configured channel", async () => {
    const { request } = setup();
    expect((await request("POST", { authorization: undefined })).status).toBe(401);
    expect((await request("GET", { authorization: `Bearer ${Buffer.alloc(32, 99).toString("base64url")}` })).status).toBe(401);
    expect((await setup({ allowedChannelIds: new Set() }).request("POST")).status).toBe(503);
    expect((await setup({ allowedChannelIds: new Set([Buffer.alloc(32).toString("base64url")]) }).request("POST")).status).toBe(404);
  });

  it("allows trusted preflights and rejects foreign origins", async () => {
    const { request } = setup();
    const preflight = await request("OPTIONS", { authorization: undefined, channelId: "" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["Access-Control-Allow-Methods"]).toContain("POST");
    const rejected = await request("POST", { origin: "https://other.example" });
    expect(rejected.status).toBe(403);
    expect(rejected.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("rejects excess requests and unsupported methods", async () => {
    const { request } = setup();
    expect((await request("DELETE")).status).toBe(405);
    for (let i = 0; i < 10; i++) expect((await request("POST")).status).toBe(200);
    const limited = await request("POST");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("does not acknowledge unknown requests", async () => {
    const { request } = setup();
    expect((await request("GET", { requestId: uuid(99) })).status).toBe(204);
    expect((await request("PUT", { body: { requestId: uuid(99), status: "running" } })).status).toBe(404);
  });
});
