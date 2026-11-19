export type RedisErrorCode = "redis_not_configured" | "redis_unavailable" | "redis_timeout"
  | "redis_invalid_response" | "redis_invalid_data";

/** Provider responses may include private keys or credentials; never retain them. */
export class RedisStorageError extends Error {
  constructor(public readonly code: RedisErrorCode) {
    super("The encrypted sync storage is unavailable.");
    this.name = "RedisStorageError";
  }
}

export type RedisCommand = readonly (string | number)[];
export interface RedisExecutor {
  command(args: RedisCommand): Promise<unknown>;
}
export type RedisCredentials = { url: string; token: string };
type RedisEnvironment = Partial<Record<
  "UPSTASH_REDIS_REST_URL" | "UPSTASH_REDIS_REST_TOKEN" | "KV_REST_API_URL" | "KV_REST_API_TOKEN", string
>>;

export function readRedisCredentials(environment: RedisEnvironment = process.env): RedisCredentials {
  // Never combine one provider's URL with another provider's token.
  const primary = environment.UPSTASH_REDIS_REST_URL !== undefined || environment.UPSTASH_REDIS_REST_TOKEN !== undefined;
  const url = primary ? environment.UPSTASH_REDIS_REST_URL : environment.KV_REST_API_URL;
  const token = primary ? environment.UPSTASH_REDIS_REST_TOKEN : environment.KV_REST_API_TOKEN;
  return validateCredentials({ url: url ?? "", token: token ?? "" });
}

function validateCredentials(credentials: RedisCredentials): RedisCredentials {
  try {
    const url = new URL(credentials.url.trim());
    const token = credentials.token.trim();
    if (url.protocol !== "https:" || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.upstash\.io$/i.test(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/"
      || !token || token.length > 8192 || /\s/.test(token)) throw new Error();
    return { url: url.origin, token };
  } catch {
    throw new RedisStorageError("redis_not_configured");
  }
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8_000;

export class UpstashRestClient implements RedisExecutor {
  constructor(private readonly options: {
    credentials?: () => RedisCredentials;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** Shared wall-clock budget for all Redis operations in one HTTP request. */
    deadlineAt?: number;
  } = {}) {}

  async command(args: RedisCommand): Promise<unknown> {
    const configuredTimeout = this.options.timeoutMs ?? TIMEOUT_MS;
    const operationTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(configuredTimeout, TIMEOUT_MS) : TIMEOUT_MS;
    const deadline = this.options.deadlineAt;
    if (deadline !== undefined && !Number.isFinite(deadline)) throw new RedisStorageError("redis_invalid_data");
    const timeoutMs = deadline === undefined ? operationTimeout : Math.min(operationTimeout, deadline - Date.now());
    if (timeoutMs <= 0) throw new RedisStorageError("redis_timeout");
    // Lazy access lets preflight and unauthorized requests work without a store.
    const credentials = validateCredentials((this.options.credentials ?? readRedisCredentials)());
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new RedisStorageError("redis_timeout"));
      }, timeoutMs);
    });
    const execute = async () => {
      const response = await (this.options.fetchImpl ?? fetch)(credentials.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(args),
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) throw new RedisStorageError("redis_unavailable");
      if (Number(response.headers.get("Content-Length")) > MAX_RESPONSE_BYTES || !response.body) {
        throw new RedisStorageError("redis_invalid_response");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new RedisStorageError("redis_invalid_response");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new RedisStorageError("redis_invalid_response"); }
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.hasOwn(body, "error") || !Object.hasOwn(body, "result")) {
        throw new RedisStorageError("redis_invalid_response");
      }
      return (body as { result: unknown }).result;
    };
    try {
      // Also bounds a stalled response body or fetch that ignores AbortSignal.
      return await Promise.race([execute(), timedOut]);
    } catch (error) {
      if (error instanceof RedisStorageError) throw error;
      throw new RedisStorageError(controller.signal.aborted ? "redis_timeout" : "redis_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}
