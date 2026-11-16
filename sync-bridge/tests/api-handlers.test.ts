import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import refreshHandler from "../api/refresh.js";
import snapshotHandler from "../api/snapshot.js";
import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";

const authToken = Buffer.alloc(32, 41);
const authorization = `Bearer ${authToken.toString("base64url")}`;
const channelId = createHash("sha256").update(authToken).digest("base64url");
const origin = "https://spotjobs-reward-inventory-manager.vercel.app";

function responseRecorder() {
  const result = { status: 0, headers: {} as Record<string, string | number | readonly string[]>, body: undefined as unknown };
  const response: VercelResponse = {
    setHeader(name, value) { result.headers[name] = value; return response; },
    status(status) { result.status = status; return response; },
    json(body) { result.body = body; return response; },
    end() { return response; },
  };
  return { result, response };
}

function request(overrides: Partial<VercelRequest> = {}): VercelRequest {
  return { method: "GET", query: { channelId }, headers: { origin, authorization }, ...overrides };
}

describe.each([
  ["snapshot", snapshotHandler],
  ["refresh", refreshHandler],
] as const)("%s API storage failure handling", (operation, handler) => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubEnv("SYNC_ALLOWED_CHANNEL_IDS", channelId);
    vi.stubEnv("SYNC_ALLOWED_ORIGINS", "");
    vi.stubEnv("SYNC_SNAPSHOT_TTL_SECONDS", "7776000");
    for (const key of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN", "BLOB_STORE_ID", "BLOB_READ_WRITE_TOKEN"]) {
      vi.stubEnv(key, "");
    }
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("answers trusted preflight without Redis configuration or storage access", async () => {
    const { response, result } = responseRecorder();
    await handler(request({ method: "OPTIONS", query: {}, headers: { origin } }), response);
    expect(result.status).toBe(204);
    expect(result.headers["Access-Control-Allow-Origin"]).toBe(origin);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests before any storage access", async () => {
    const { response, result } = responseRecorder();
    await handler(request({ headers: { origin } }), response);
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: { code: "unauthorized" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a readable CORS failure if Redis is not configured", async () => {
    const { response, result } = responseRecorder();
    await handler(request(), response);
    expect(result.status).toBe(503);
    expect(result.headers["Access-Control-Allow-Origin"]).toBe(origin);
    expect(result.headers["Cache-Control"]).toContain("no-store");
    expect(result.headers["Retry-After"]).toBe("30");
    expect(result.body).toMatchObject({ error: { code: "bridge_unavailable" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("sync_bridge_unavailable", { operation, code: "redis_not_configured" });
  });

  it("keeps provider failures, credentials, and channel identifiers out of responses and logs", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://sync-test.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "synthetic-storage-secret");
    fetchMock.mockRejectedValue(new Error(`https://sync-test.upstash.io synthetic-storage-secret ${authorization} ${channelId}`));
    const { response, result } = responseRecorder();
    await handler(request(), response);
    expect(result.status).toBe(503);
    expect(result.headers["Access-Control-Allow-Origin"]).toBe(origin);
    const emitted = JSON.stringify({ result, logs: vi.mocked(console.error).mock.calls });
    for (const privateValue of ["synthetic-storage-secret", "sync-test.upstash.io", authorization, channelId]) {
      expect(emitted).not.toContain(privateValue);
    }
    expect(console.error).toHaveBeenCalledWith("sync_bridge_unavailable", { operation, code: "redis_unavailable" });
  });

  it("does not reflect a disallowed origin or touch storage", async () => {
    const { response, result } = responseRecorder();
    await handler(request({ headers: { origin: "https://attacker.example", authorization } }), response);
    expect(result.status).toBe(403);
    expect(result.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves an explicitly configured trusted origin on storage errors", async () => {
    const additionalOrigin = "https://sync-client.example";
    vi.stubEnv("SYNC_ALLOWED_ORIGINS", additionalOrigin);
    const { response, result } = responseRecorder();
    await handler(request({ headers: { origin: additionalOrigin, authorization } }), response);
    expect(result.status).toBe(503);
    expect(result.headers["Access-Control-Allow-Origin"]).toBe(additionalOrigin);
  });

  it("fails closed on invalid configuration without leaking it or reflecting an untrusted origin", async () => {
    vi.stubEnv("SYNC_ALLOWED_CHANNEL_IDS", "invalid-private-channel-value");
    const trusted = responseRecorder();
    await handler(request(), trusted.response);
    expect(trusted.result.status).toBe(503);
    expect(trusted.result.headers["Access-Control-Allow-Origin"]).toBe(origin);
    expect(JSON.stringify(trusted.result)).not.toContain("invalid-private-channel-value");
    const untrusted = responseRecorder();
    await handler(request({ headers: { origin: "https://attacker.example", authorization } }), untrusted.response);
    expect(untrusted.result.status).toBe(403);
    expect(untrusted.result.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
