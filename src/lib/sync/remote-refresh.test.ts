import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deriveSyncCredentials } from "./protocol";
import { PcRefreshError, requestPcRefresh, type PcRefreshPhase, type PcRefreshRequest } from "./remote-refresh";

const syncCode = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const requestId = "de305d54-75b4-431b-adb2-eb6b9e546014";
const pending: PcRefreshRequest = {
  requestId, requestedAt: "2026-11-15T01:00:00.000Z", expiresAt: "2026-11-15T01:02:00.000Z", status: "pending",
};
const succeeded = { ...pending, status: "succeeded" as const, completedAt: "2026-11-15T01:00:35.000Z" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const options = { syncCode, bridgeUrl: "http://localhost:3001", pollIntervalMs: 1 };

beforeAll(() => { if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto); });
afterEach(() => { vi.useRealTimers(); });

describe("remote PC refresh", () => {
  it("requests one collection, tracks PC progress, and completes only after its upload acknowledgement", async () => {
    const credentials = await deriveSyncCredentials(syncCode);
    const phases: PcRefreshPhase[] = [];
    const responses = [pending, { ...pending, status: "running" }, succeeded];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${credentials.bearerToken}`);
      expect(init?.cache).toBe("no-store");
      return json(responses.shift());
    });
    const result = await requestPcRefresh({ ...options, fetchImpl: fetchMock, onProgress: phase => phases.push(phase) });
    expect(result).toEqual(succeeded);
    expect(phases).toEqual(["requesting", "waiting", "fetching"]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET", "GET"]);
    expect(fetchMock.mock.calls[0][1]?.body).toBe("{}");
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("requestId")).toBe(requestId);
    for (const [input] of fetchMock.mock.calls) {
      expect(String(input)).toContain(`/api/v1/refresh/${credentials.channelId}`);
      expect(String(input)).not.toContain(syncCode);
      expect(String(input)).not.toContain(credentials.bearerToken);
      expect(String(input)).not.toContain("snapshot");
    }
  });

  it("accepts an already-running coalesced request without posting twice", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ ...pending, status: "running" }))
      .mockResolvedValueOnce(json(succeeded));
    const phases: PcRefreshPhase[] = [];
    await requestPcRefresh({ ...options, fetchImpl: fetchMock, onProgress: phase => phases.push(phase) });
    expect(phases).toEqual(["requesting", "fetching"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["auth_required", "auth-required", "ログイン"],
    ["page_required", "page-required", "ジョブ履歴"],
    ["disabled", "disabled", "有効"],
    ["sync_failed", "sync-failed", "取得できません"],
  ])("turns PC failure %s into an actionable safe error", async (errorCode, code, message) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(pending))
      .mockResolvedValueOnce(json({ ...succeeded, status: "failed", errorCode, message: "PRIVATE OFFICIAL RESPONSE" }));
    const error = await requestPcRefresh({ ...options, fetchImpl: fetchMock }).catch(error => error);
    expect(error).toBeInstanceOf(PcRefreshError);
    expect(error).toMatchObject({ code });
    expect(error.message).toContain(message);
    expect(error.message).not.toContain("PRIVATE");
  });

  it("stops polling at the deadline when the PC never answers", async () => {
    const fetchMock = vi.fn(async () => json(pending));
    await expect(requestPcRefresh({ ...options, fetchImpl: fetchMock, timeoutMs: 25 })).rejects.toMatchObject({ code: "timeout" });
    const calls = fetchMock.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("bounds even a fetch implementation that ignores AbortSignal", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    await expect(requestPcRefresh({ ...options, fetchImpl: fetchMock, timeoutMs: 25 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("limits an individual network request to 12 seconds without waiting for the PC deadline", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const fetching = new Promise<void>(resolve => { started = resolve; });
    const fetchMock = vi.fn(() => { started(); return new Promise<Response>(() => undefined); });
    const assertion = expect(requestPcRefresh({ ...options, fetchImpl: fetchMock })).rejects.toMatchObject({ code: "unavailable" });
    await fetching;
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled response body as well as request headers", async () => {
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({ start() { /* Intentionally never completes. */ } })));
    await expect(requestPcRefresh({ ...options, fetchImpl: fetchMock, timeoutMs: 25 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("returns expiry when the bridge no longer has the requested command", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(pending)).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(requestPcRefresh({ ...options, fetchImpl: fetchMock })).rejects.toMatchObject({ code: "expired" });
  });

  it.each([
    { ...succeeded, requestId: "../../different" },
    { ...succeeded, status: "unknown" },
    { ...succeeded, completedAt: undefined },
    { ...succeeded, expiresAt: pending.requestedAt },
    { ...succeeded, completedAt: "2026-11-15T01:03:00.000Z" },
    { ...succeeded, status: "failed", errorCode: "PRIVATE_ERROR" },
  ])("rejects malformed response %# without treating it as successful collection", async value => {
    await expect(requestPcRefresh({ ...options, fetchImpl: vi.fn(async () => json(value)) })).rejects.toMatchObject({ code: "invalid-response" });
  });

  it.each([
    { ...succeeded, requestId: "de305d54-75b4-431b-adb2-eb6b9e546015" },
    { ...succeeded, requestedAt: "2026-11-15T01:00:01.000Z" },
  ])("does not accept an acknowledgement for a different request %#", async value => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(pending)).mockResolvedValueOnce(json(value));
    await expect(requestPcRefresh({ ...options, fetchImpl: fetchMock })).rejects.toMatchObject({ code: "invalid-response" });
  });

  it.each([[401, "unauthorized"], [403, "unauthorized"], [429, "rate-limited"], [503, "unavailable"]])("maps HTTP %s to a safe error", async (status, code) => {
    const fetchMock = vi.fn(async () => json({ message: "private internal detail" }, status as number));
    const error = await requestPcRefresh({ ...options, fetchImpl: fetchMock }).catch(error => error);
    expect(error).toMatchObject({ code });
    expect(error.message).not.toContain("private");
  });

  it("does not send a request after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async () => json(pending));
    await expect(requestPcRefresh({ ...options, signal: controller.signal, fetchImpl: fetchMock })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels in-progress polling without starting another request", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => json(pending));
    await expect(requestPcRefresh({
      ...options, signal: controller.signal, fetchImpl: fetchMock,
      onProgress: phase => { if (phase === "waiting") controller.abort(); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid JSON and oversized metadata", async () => {
    await expect(requestPcRefresh({ ...options, fetchImpl: vi.fn(async () => new Response("not json")) })).rejects.toMatchObject({ code: "invalid-response" });
    await expect(requestPcRefresh({ ...options, fetchImpl: vi.fn(async () => json({ ...pending, extra: "x".repeat(16_384) })) })).rejects.toMatchObject({ code: "invalid-response" });
  });
});
