import { afterEach, describe, expect, it, vi } from "vitest";
import { D1GatewayClient, D1StorageError, readD1GatewayCredentials } from "../src/d1-client.js";

const credentials = { url: "https://spotlog-sync.test-account.workers.dev", token: Buffer.alloc(32, 73).toString("base64url") };
const json = (body: unknown) => new Response(JSON.stringify(body));

describe("dedicated D1 gateway transport", () => {
  afterEach(() => vi.useRealTimers());

  it("uses a single POST body and dedicated token without redirects or retries", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ ok: true }));
    const client = new D1GatewayClient({ credentials: () => credentials, fetchImpl });
    const command = { op: "set" as const, key: "test-key", value: "encrypted-value", expiresAt: 123456 };
    await expect(client.request(command)).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe(`${credentials.url}/v1/storage`);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "POST", cache: "no-store", redirect: "error", body: JSON.stringify(command),
      headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json" },
    });
  });

  it("resolves credentials only when an operation is needed", async () => {
    const getCredentials = vi.fn(() => credentials);
    const client = new D1GatewayClient({ credentials: getCredentials, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(json({ ok: true, value: null })) });
    expect(getCredentials).not.toHaveBeenCalled();
    await expect(client.request({ op: "get", key: "missing" })).resolves.toEqual({ ok: true, value: null });
    expect(getCredentials).toHaveBeenCalledOnce();
  });

  it("reads only the dedicated D1 credential pair", () => {
    expect(readD1GatewayCredentials({ SPOTLOG_D1_GATEWAY_URL: credentials.url, SPOTLOG_D1_GATEWAY_TOKEN: credentials.token })).toEqual(credentials);
    expect(() => readD1GatewayCredentials({ SPOTLOG_D1_GATEWAY_URL: credentials.url })).toThrow(D1StorageError);
    expect(() => readD1GatewayCredentials({ SPOTLOG_D1_GATEWAY_TOKEN: credentials.token })).toThrow(D1StorageError);
  });

  it.each([
    "http://test.account.workers.dev", "https://workers.dev", "https://test.workers.dev.attacker.test",
    "https://localhost", "https://test.workers.dev/path", "https://test.workers.dev?token=x",
    "https://test.workers.dev#hash", "https://user:password@test.workers.dev", "https://test.workers.dev:8080",
    "https://existing.upstash.io",
  ])("rejects unsafe destination %s before sending credentials", async url => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new D1GatewayClient({ credentials: () => ({ ...credentials, url }), fetchImpl });
    await expect(client.request({ op: "ping" })).rejects.toMatchObject({ code: "d1_not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "bad\r\nheader", "a".repeat(43)])("rejects missing or noncanonical tokens", token => {
    expect(() => readD1GatewayCredentials({ SPOTLOG_D1_GATEWAY_URL: credentials.url, SPOTLOG_D1_GATEWAY_TOKEN: token })).toThrow("The encrypted sync storage is unavailable.");
  });

  it("hides HTTP, provider, and network errors", async () => {
    for (const fetchImpl of [
      vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive-response", { status: 429 })),
      vi.fn<typeof fetch>().mockResolvedValue(json({ ok: false, error: "private-token" })),
      vi.fn<typeof fetch>().mockRejectedValue(new Error("private-url-and-token")),
    ]) {
      const client = new D1GatewayClient({ credentials: () => credentials, fetchImpl });
      const failure = await client.request({ op: "ping" }).catch(error => error as Error);
      expect(failure).toBeInstanceOf(D1StorageError);
      expect((failure as Error).message).toBe("The encrypted sync storage is unavailable.");
      expect((failure as Error).cause).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it.each(["not JSON", "{}", "[]", '{"ok":true,"error":"private-error"}', '{"ok":true}', '{"ok":true,"value":42}'])("rejects malformed get responses", async body => {
    const client = new D1GatewayClient({ credentials: () => credentials, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)) });
    await expect(client.request({ op: "get", key: "key" })).rejects.toMatchObject({ code: "d1_invalid_response" });
  });

  it("requires a boolean result from compare-and-swap", async () => {
    const client = new D1GatewayClient({ credentials: () => credentials, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(json({ ok: true, applied: 1 })) });
    await expect(client.request({ op: "cas", key: "key", value: "{}", expectedRevision: null, revision: "revision", expiresAt: 1 })).rejects.toMatchObject({ code: "d1_invalid_response" });
  });

  it("bounds response size with and without Content-Length", async () => {
    for (const response of [
      new Response("{}", { headers: { "Content-Length": String(2 * 1024 * 1024 + 1) } }),
      new Response("x".repeat(2 * 1024 * 1024 + 1)),
    ]) {
      const client = new D1GatewayClient({ credentials: () => credentials, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
      await expect(client.request({ op: "ping" })).rejects.toMatchObject({ code: "d1_invalid_response" });
    }
  });

  it("bounds a request even when fetch ignores abort", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    const client = new D1GatewayClient({ credentials: () => credentials, fetchImpl });
    const result = expect(client.request({ op: "ping" })).rejects.toMatchObject({ code: "d1_timeout" });
    await vi.advanceTimersByTimeAsync(8000);
    await result;
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also bounds and cancels a stalled response body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream({ start() {}, cancel });
    const client = new D1GatewayClient({ credentials: () => credentials, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)) });
    const result = expect(client.request({ op: "ping" })).rejects.toMatchObject({ code: "d1_timeout" });
    await vi.advanceTimersByTimeAsync(8000);
    await result;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("shares one eight-second deadline across multiple operations", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(json({ ok: true, value: null })), 4_000)))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const client = new D1GatewayClient({ credentials: () => credentials, fetchImpl, deadlineAt: startedAt + 8_000 });
    const first = client.request({ op: "get", key: "first" });
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(first).resolves.toEqual({ ok: true, value: null });
    const second = expect(client.request({ op: "get", key: "second" })).rejects.toMatchObject({ code: "d1_timeout" });
    await vi.advanceTimersByTimeAsync(4_000);
    await second;
    expect(Date.now() - startedAt).toBe(8_000);
    expect(vi.getTimerCount()).toBe(0);
    await expect(client.request({ op: "get", key: "too-late" })).rejects.toMatchObject({ code: "d1_timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
