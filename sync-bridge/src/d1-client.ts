export type D1ErrorCode = "d1_not_configured" | "d1_unavailable" | "d1_timeout"
  | "d1_invalid_response" | "d1_invalid_data";

/** Errors must never retain a provider URL, key, response body, token or cause. */
export class D1StorageError extends Error {
  constructor(public readonly code: D1ErrorCode) {
    super("The encrypted sync storage is unavailable.");
    this.name = "D1StorageError";
  }
}

export type D1GatewayRequest =
  | { op: "get"; key: string }
  | { op: "set"; key: string; value: string; expiresAt: number }
  | { op: "cas"; key: string; value: string; expectedRevision: string | null; revision: string; expiresAt: number }
  | { op: "delete"; key: string }
  | { op: "ping" };
export type D1GatewayResult = { ok: true; value?: string | null; applied?: boolean };
export interface D1GatewayExecutor {
  request(command: D1GatewayRequest): Promise<D1GatewayResult>;
}
export type D1GatewayCredentials = { url: string; token: string };
type D1Environment = Partial<Record<"SPOTLOG_D1_GATEWAY_URL" | "SPOTLOG_D1_GATEWAY_TOKEN", string>>;

export function readD1GatewayCredentials(environment: D1Environment = process.env): D1GatewayCredentials {
  return validateCredentials({
    url: environment.SPOTLOG_D1_GATEWAY_URL ?? "",
    token: environment.SPOTLOG_D1_GATEWAY_TOKEN ?? "",
  });
}

function validateCredentials(credentials: D1GatewayCredentials): D1GatewayCredentials {
  try {
    const url = new URL(credentials.url.trim());
    const token = credentials.token.trim();
    if (url.protocol !== "https:" || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev$/i.test(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/"
      || !/^[A-Za-z0-9_-]{43}$/.test(token)
      || Buffer.from(token, "base64url").toString("base64url") !== token) throw new Error();
    return { url: url.origin, token };
  } catch {
    throw new D1StorageError("d1_not_configured");
  }
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8_000;

/** The bridge uses a dedicated Worker token, never a Cloudflare account API token. */
export class D1GatewayClient implements D1GatewayExecutor {
  constructor(private readonly options: {
    credentials?: () => D1GatewayCredentials;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** Shared wall-clock budget across every gateway operation for one API call. */
    deadlineAt?: number;
  } = {}) {}

  async request(command: D1GatewayRequest): Promise<D1GatewayResult> {
    const configuredTimeout = this.options.timeoutMs ?? TIMEOUT_MS;
    const operationTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(configuredTimeout, TIMEOUT_MS) : TIMEOUT_MS;
    const deadline = this.options.deadlineAt;
    if (deadline !== undefined && !Number.isFinite(deadline)) throw new D1StorageError("d1_invalid_data");
    const timeoutMs = deadline === undefined ? operationTimeout : Math.min(operationTimeout, deadline - Date.now());
    if (timeoutMs <= 0) throw new D1StorageError("d1_timeout");
    // Lazy access preserves preflight and authorization responses without storage.
    const credentials = validateCredentials((this.options.credentials ?? readD1GatewayCredentials)());
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelRead = () => { void reader?.cancel().catch(() => undefined); };
    controller.signal.addEventListener("abort", cancelRead, { once: true });
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new D1StorageError("d1_timeout"));
      }, timeoutMs);
    });
    const execute = async (): Promise<D1GatewayResult> => {
      const response = await (this.options.fetchImpl ?? fetch)(`${credentials.url}/v1/storage`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(command),
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) throw new D1StorageError("d1_unavailable");
      if (Number(response.headers.get("Content-Length")) > MAX_RESPONSE_BYTES || !response.body) {
        throw new D1StorageError("d1_invalid_response");
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new D1StorageError("d1_invalid_response");
          chunks.push(chunk.value);
        }
      } finally {
        cancelRead();
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new D1StorageError("d1_invalid_response"); }
      if (!body || typeof body !== "object" || Array.isArray(body)
        || (body as { ok?: unknown }).ok !== true || Object.hasOwn(body, "error")) {
        throw new D1StorageError("d1_invalid_response");
      }
      const result = body as D1GatewayResult;
      if (command.op === "get" && (result.value !== null && typeof result.value !== "string")) {
        throw new D1StorageError("d1_invalid_response");
      }
      if (command.op === "cas" && typeof result.applied !== "boolean") throw new D1StorageError("d1_invalid_response");
      return result;
    };
    try {
      // Bounds response streaming and even a fetch implementation ignoring abort.
      return await Promise.race([execute(), timedOut]);
    } catch (error) {
      if (controller.signal.aborted) throw new D1StorageError("d1_timeout");
      if (error instanceof D1StorageError) throw error;
      throw new D1StorageError("d1_unavailable");
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancelRead);
    }
  }
}
