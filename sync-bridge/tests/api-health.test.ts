import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/health.js";
import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";

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

const origin = "https://spotjobs-reward-inventory-manager.vercel.app";
const request = (overrides: Partial<VercelRequest> = {}): VercelRequest => ({ method: "GET", headers: { origin }, query: {}, ...overrides });

describe("storage-aware health endpoint", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubEnv("SYNC_ALLOWED_CHANNEL_IDS", Buffer.alloc(32, 43).toString("base64url"));
    vi.stubEnv("SYNC_ALLOWED_ORIGINS", "");
    vi.stubEnv("SPOTLOG_D1_GATEWAY_URL", "https://sync-test.account.workers.dev");
    vi.stubEnv("SPOTLOG_D1_GATEWAY_TOKEN", Buffer.alloc(32, 75).toString("base64url"));
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("only reports healthy after a live D1 gateway ping succeeds", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    const { response, result } = responseRecorder();
    await handler(request(), response);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, service: "spotjobs-encrypted-sync-bridge", protocolVersion: 1, storage: "d1" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ op: "ping" });
  });

  it("does not declare old Blob or Redis configurations healthy", async () => {
    vi.stubEnv("SPOTLOG_D1_GATEWAY_URL", "");
    vi.stubEnv("SPOTLOG_D1_GATEWAY_TOKEN", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://existing-other-app.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "do-not-use-existing-token");
    vi.stubEnv("BLOB_STORE_ID", "old-suspended-store");
    const { response, result } = responseRecorder();
    await handler(request(), response);
    expect(result.status).toBe(503);
    expect(result.headers["Access-Control-Allow-Origin"]).toBe(origin);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not ping a datastore when the personal allowlist is absent", async () => {
    vi.stubEnv("SYNC_ALLOWED_CHANNEL_IDS", "");
    const { response, result } = responseRecorder();
    await handler(request(), response);
    expect(result.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["OPTIONS", "POST"])("handles %s without a datastore request", async method => {
    const { response, result } = responseRecorder();
    await handler(request({ method }), response);
    expect(result.status).toBe(method === "OPTIONS" ? 204 : 405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an untrusted origin before pinging", async () => {
    const { response, result } = responseRecorder();
    await handler(request({ headers: { origin: "https://attacker.example" } }), response);
    expect(result.status).toBe(403);
    expect(result.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a safe failure when the provider is unavailable", async () => {
    fetchMock.mockResolvedValue(new Response("secret provider error", { status: 503 }));
    const { response, result } = responseRecorder();
    await handler(request(), response);
    expect(result.status).toBe(503);
    expect(JSON.stringify({ result, logs: vi.mocked(console.error).mock.calls })).not.toMatch(/secret|workers\.dev/);
    expect(console.error).toHaveBeenCalledWith("sync_bridge_unavailable", { operation: "health", code: "d1_unavailable" });
  });

  it("rejects a gateway response without ok true", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false })));
    const { response, result } = responseRecorder();
    await handler(request(), response);
    expect(result.status).toBe(503);
  });

  it("bounds a stalled storage health check to three seconds", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const { response, result } = responseRecorder();
    const pending = handler(request(), response);
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;
    expect(result.status).toBe(503);
    expect(console.error).toHaveBeenCalledWith("sync_bridge_unavailable", { operation: "health", code: "d1_timeout" });
  });
});
