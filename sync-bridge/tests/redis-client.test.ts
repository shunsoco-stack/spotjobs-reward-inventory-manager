import { afterEach, describe, expect, it, vi } from "vitest";
import { readRedisCredentials, RedisStorageError, UpstashRestClient } from "../src/redis-client.js";

const credentials = { url: "https://example-test.upstash.io", token: "synthetic-test-token" };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

describe("Upstash REST transport", () => {
  afterEach(() => vi.useRealTimers());

  it("uses a single POST body and server-only bearer header without redirects or retries", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ result: "OK" }));
    const client = new UpstashRestClient({ credentials: () => credentials, fetchImpl });
    await expect(client.command(["SET", "test-key", "encrypted-value", "EX", 180])).resolves.toBe("OK");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(credentials.url);
    expect(options).toMatchObject({
      method: "POST", cache: "no-store", redirect: "error",
      headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json" },
      body: '["SET","test-key","encrypted-value","EX",180]',
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("resolves credentials lazily and permits a missing key result", async () => {
    const getCredentials = vi.fn(() => credentials);
    const client = new UpstashRestClient({ credentials: getCredentials, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(json({ result: null })) });
    expect(getCredentials).not.toHaveBeenCalled();
    await expect(client.command(["GET", "missing"])).resolves.toBeNull();
    expect(getCredentials).toHaveBeenCalledOnce();
  });

  it("accepts the primary credential pair or the legacy KV pair without mixing them", () => {
    expect(readRedisCredentials({ UPSTASH_REDIS_REST_URL: credentials.url, UPSTASH_REDIS_REST_TOKEN: credentials.token })).toEqual(credentials);
    expect(readRedisCredentials({ KV_REST_API_URL: `${credentials.url}/`, KV_REST_API_TOKEN: credentials.token })).toEqual(credentials);
    expect(() => readRedisCredentials({ UPSTASH_REDIS_REST_URL: credentials.url, KV_REST_API_TOKEN: credentials.token })).toThrow(RedisStorageError);
    expect(() => readRedisCredentials({ UPSTASH_REDIS_REST_TOKEN: credentials.token, KV_REST_API_URL: credentials.url })).toThrow(RedisStorageError);
  });

  it.each([
    "http://test.upstash.io", "https://upstash.io", "https://test.upstash.io.attacker.test",
    "https://localhost", "https://test.upstash.io/path", "https://test.upstash.io?token=x",
    "https://test.upstash.io#hash", "https://user:password@test.upstash.io", "https://test.upstash.io:8080",
  ])("rejects unsafe configured destination %s before sending credentials", async (url) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new UpstashRestClient({ credentials: () => ({ ...credentials, url }), fetchImpl });
    await expect(client.command(["GET", "key"])).rejects.toMatchObject({ code: "redis_not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "bad\r\nheader", "one two"])("rejects missing or unsafe tokens without exposing their contents", (token) => {
    expect(() => readRedisCredentials({ UPSTASH_REDIS_REST_URL: credentials.url, UPSTASH_REDIS_REST_TOKEN: token })).toThrow("The encrypted sync storage is unavailable.");
  });

  it("hides HTTP, provider, and network error details", async () => {
    for (const fetchImpl of [
      vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive-response", { status: 429 })),
      vi.fn<typeof fetch>().mockResolvedValue(json({ error: "private-key-and-token" })),
      vi.fn<typeof fetch>().mockRejectedValue(new Error("private-url-and-token")),
    ]) {
      const client = new UpstashRestClient({ credentials: () => credentials, fetchImpl });
      const failure = await client.command(["GET", "key"]).catch(error => error as Error);
      expect(failure).toBeInstanceOf(RedisStorageError);
      expect((failure as Error).message).toBe("The encrypted sync storage is unavailable.");
      expect((failure as Error).cause).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it.each(["not JSON", "{}", "[]", '{"result":null,"error":"error"}'])("rejects malformed provider responses", async body => {
    const client = new UpstashRestClient({ credentials: () => credentials, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)) });
    await expect(client.command(["GET", "key"])).rejects.toMatchObject({ code: "redis_invalid_response" });
  });

  it("bounds response size with and without Content-Length", async () => {
    for (const response of [
      new Response("{}", { headers: { "Content-Length": String(2 * 1024 * 1024 + 1) } }),
      new Response("x".repeat(2 * 1024 * 1024 + 1)),
    ]) {
      const client = new UpstashRestClient({ credentials: () => credentials, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
      await expect(client.command(["GET", "key"])).rejects.toMatchObject({ code: "redis_invalid_response" });
    }
  });

  it("bounds stalled requests even when fetch ignores AbortSignal", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    const client = new UpstashRestClient({ credentials: () => credentials, fetchImpl });
    const result = expect(client.command(["GET", "key"])).rejects.toMatchObject({ code: "redis_timeout" });
    await vi.advanceTimersByTimeAsync(8000);
    await result;
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also bounds a stalled response body", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream({ start() {} });
    const client = new UpstashRestClient({ credentials: () => credentials, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)) });
    const result = expect(client.command(["GET", "key"])).rejects.toMatchObject({ code: "redis_timeout" });
    await vi.advanceTimersByTimeAsync(8000);
    await result;
  });

  it("shares one absolute deadline across a delayed first command and stalled second command", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(json({ result: null })), 4_000)))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const client = new UpstashRestClient({ credentials: () => credentials, fetchImpl, deadlineAt: startedAt + 8_000 });
    const first = client.command(["GET", "first"]);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(first).resolves.toBeNull();
    const second = expect(client.command(["GET", "second"])).rejects.toMatchObject({ code: "redis_timeout" });
    await vi.advanceTimersByTimeAsync(4_000);
    await second;
    expect(Date.now() - startedAt).toBe(8_000);
    expect(fetchImpl.mock.calls[1][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a command after the request deadline", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>();
    const getCredentials = vi.fn(() => credentials);
    const client = new UpstashRestClient({ credentials: getCredentials, fetchImpl, deadlineAt: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(client.command(["GET", "too-late"])).rejects.toMatchObject({ code: "redis_timeout" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getCredentials).not.toHaveBeenCalled();
  });
});
