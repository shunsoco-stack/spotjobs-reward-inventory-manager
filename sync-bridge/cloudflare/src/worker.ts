import type { D1Database, StorageEnvironment } from "./d1-types.ts";
import { CAS_SQL, CLEANUP_BATCH_SIZE, CLEANUP_SQL, DELETE_SQL, GET_SQL, PING_SQL, SET_SQL } from "./sql.ts";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
export const MAX_REFRESH_BYTES = 4096;
export const MAX_HEADER_BYTES = 8192;
export const MAX_CLOCK_SKEW_MS = 5_000;
const BODY_TIMEOUT_MS = 5_000;
const encoder = new TextEncoder();
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANNEL = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const BASE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

type KeyKind = "snapshot" | "latest" | "command";
type KeyInfo = { kind: KeyKind; ttlMs: number; requestId?: string };
type StorageRequest =
  | { op: "ping" }
  | { op: "get"; key: string }
  | { op: "delete"; key: string }
  | { op: "set"; key: string; value: string; expiresAt: number }
  | { op: "cas"; key: string; value: string; expiresAt: number; expectedRevision: string | null; revision: string };

class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super("Storage request failed.");
    this.status = status;
    this.code = code;
  }
}

function response(status: number, value: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...BASE_HEADERS, ...headers } });
}

function errorResponse(status: number, code: string, headers?: Record<string, string>): Response {
  return response(status, { ok: false, error: { code, message: "Storage request failed." } }, headers);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function keyInfo(key: unknown): KeyInfo | null {
  if (typeof key !== "string") return null;
  const parts = key.split(":");
  if (parts[0] !== "spotlog" || parts[1] !== "v1" || !CHANNEL.test(parts[2] ?? "")) return null;
  if (parts.length === 4 && parts[3] === "snapshot") return { kind: "snapshot", ttlMs: 90 * 86400 * 1000 };
  if (parts.length !== 5 || parts[3] !== "refresh") return null;
  if (parts[4] === "latest") return { kind: "latest", ttlMs: 180_000 };
  return UUID_V4.test(parts[4]) ? { kind: "command", ttlMs: 86_400_000, requestId: parts[4] } : null;
}

/** Hash to equal-length bytes, then compare every byte without early exits. */
async function isAuthorized(header: string | null, secret: string): Promise<boolean> {
  if (!CHANNEL.test(secret ?? "")) throw new RequestError(503, "gateway_not_configured");
  const supplied = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "")?.[1];
  if (!supplied || !CHANNEL.test(supplied)) return false;
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const expected = new Uint8Array(expectedHash);
  const actual = new Uint8Array(suppliedHash);
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected[index] ^ actual[index];
  return mismatch === 0;
}

async function readBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) {
    throw new RequestError(415, "unsupported_content_type");
  }
  const length = request.headers.get("Content-Length");
  if (length !== null) {
    if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new RequestError(400, "invalid_length");
    if (Number(length) > MAX_BODY_BYTES) throw new RequestError(413, "request_too_large");
  }
  if (!request.body) throw new RequestError(400, "invalid_request");
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RequestError(408, "request_timeout"));
      void reader.cancel().catch(() => undefined);
    }, BODY_TIMEOUT_MS);
  });
  const read = async () => {
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new RequestError(413, "request_too_large");
      parts.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new RequestError(400, "invalid_json"); }
  };
  try { return await Promise.race([read(), timeout]); }
  finally {
    clearTimeout(timer);
    // A hostile/stalled stream may never settle its cancellation promise.
    void reader.cancel().catch(() => undefined);
  }
}

function validateBody(value: unknown, now: number): StorageRequest {
  if (!isObject(value) || typeof value.op !== "string") throw new RequestError(400, "invalid_request");
  const fields = {
    ping: ["op"], get: ["op", "key"], delete: ["op", "key"],
    set: ["op", "key", "value", "expiresAt"],
    cas: ["op", "key", "value", "expiresAt", "expectedRevision", "revision"],
  }[value.op];
  if (!fields || Object.keys(value).length !== fields.length || Object.keys(value).some(field => !fields.includes(field))) {
    throw new RequestError(400, "invalid_request");
  }
  if (value.op === "ping") return { op: "ping" };
  const info = keyInfo(value.key);
  if (!info) throw new RequestError(400, "invalid_key");
  if (value.op === "get" || value.op === "delete") return { op: value.op, key: value.key as string };
  if ((value.op === "set") !== (info.kind === "snapshot")) throw new RequestError(400, "invalid_operation");
  if (typeof value.value !== "string" || encoder.encode(value.value).byteLength > (info.kind === "snapshot" ? MAX_SNAPSHOT_BYTES : MAX_REFRESH_BYTES)) {
    throw new RequestError(413, "value_too_large");
  }
  if (typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= now || value.expiresAt - now > info.ttlMs + MAX_CLOCK_SKEW_MS) throw new RequestError(400, "invalid_expiry");
  // Independent Vercel/Worker clocks can differ slightly. Permit a small skew
  // but cap actual retention using this server's clock and the key's TTL.
  const expiresAt = Math.min(value.expiresAt, now + info.ttlMs);
  if (value.op === "set") return { ...value, expiresAt } as StorageRequest;
  if (typeof value.revision !== "string" || !UUID_V4.test(value.revision)
    || !(value.expectedRevision === null || typeof value.expectedRevision === "string" && UUID_V4.test(value.expectedRevision))) {
    throw new RequestError(400, "invalid_revision");
  }
  let versioned: unknown;
  try { versioned = JSON.parse(value.value); } catch { throw new RequestError(400, "invalid_value"); }
  if (!isObject(versioned) || versioned.revision !== value.revision || !Object.hasOwn(versioned, "value")
    || Object.keys(versioned).length !== 2 || !isObject(versioned.value)
    || typeof versioned.value.requestId !== "string" || !UUID_V4.test(versioned.value.requestId)
    || info.requestId !== undefined && versioned.value.requestId !== info.requestId) {
    throw new RequestError(400, "invalid_value");
  }
  return { ...value, expiresAt } as StorageRequest;
}

async function execute(operation: StorageRequest, db: D1Database, now: number): Promise<unknown> {
  if (operation.op === "ping") {
    await db.prepare(PING_SQL).first();
    return { ok: true };
  }
  if (operation.op === "get") {
    const row = await db.prepare(GET_SQL).bind(operation.key, now).first<{ value: string }>();
    if (row && (typeof row.value !== "string" || encoder.encode(row.value).byteLength > MAX_SNAPSHOT_BYTES)) throw new Error();
    return { ok: true, value: row?.value ?? null };
  }
  const result = operation.op === "set"
    ? await db.prepare(SET_SQL).bind(operation.key, operation.value, operation.expiresAt).run()
    : operation.op === "delete"
      ? await db.prepare(DELETE_SQL).bind(operation.key).run()
      : await db.prepare(CAS_SQL).bind(operation.key, operation.value, operation.revision, operation.expiresAt, operation.expectedRevision, now).run();
  if (!result.success || !Number.isSafeInteger(result.meta.changes) || result.meta.changes < 0 || result.meta.changes > 1) throw new Error();
  return operation.op === "cas" ? { ok: true, applied: result.meta.changes === 1 } : { ok: true };
}

export async function handleStorageRequest(request: Request, env: StorageEnvironment, now: () => number = Date.now): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/storage" || url.search) return errorResponse(404, "not_found");
    if (request.method !== "POST") return errorResponse(405, "method_not_allowed", { Allow: "POST" });
    let headerSize = 0;
    request.headers.forEach((value, name) => { headerSize += encoder.encode(name).byteLength + encoder.encode(value).byteLength; });
    if (headerSize > MAX_HEADER_BYTES) return errorResponse(431, "headers_too_large");
    if (!await isAuthorized(request.headers.get("Authorization"), env.SPOTLOG_GATEWAY_SECRET)) return errorResponse(401, "unauthorized");
    const operation = validateBody(await readBody(request), now());
    return response(200, await execute(operation, env.DB, now()));
  } catch (error) {
    if (error instanceof RequestError) return errorResponse(error.status, error.code);
    // Never return/log SQL errors, private record keys, payloads or credentials.
    return errorResponse(503, "storage_unavailable");
  }
}

export async function cleanupExpired(db: D1Database, now: number = Date.now()): Promise<number> {
  try {
    const result = await db.prepare(CLEANUP_SQL).bind(now, CLEANUP_BATCH_SIZE).run();
    if (!result.success || !Number.isSafeInteger(result.meta.changes) || result.meta.changes < 0 || result.meta.changes > CLEANUP_BATCH_SIZE) throw new Error();
    return result.meta.changes;
  } catch {
    throw new Error("Scheduled storage cleanup failed.");
  }
}

const worker = {
  fetch(request: Request, env: StorageEnvironment): Promise<Response> { return handleStorageRequest(request, env); },
  async scheduled(_controller: unknown, env: StorageEnvironment): Promise<void> { await cleanupExpired(env.DB); },
};

export default worker;
