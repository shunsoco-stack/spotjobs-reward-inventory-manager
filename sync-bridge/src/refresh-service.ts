import { randomUUID } from "node:crypto";
import { evaluateCors } from "./cors.js";
import { isAuthorizedChannel } from "./security.js";
import type { RateLimiter } from "./storage.js";
import type { SnapshotResponse } from "./service.js";
import { REFRESH_ERROR_CODES, REQUEST_ID_PATTERN, type RefreshCommand, type RefreshErrorCode, type RefreshStore } from "./refresh-store.js";

export type RefreshRequest = {
  method: string;
  channelId: string;
  requestId?: string;
  authorization?: string;
  origin?: string;
  contentLength?: number;
  body?: unknown;
};
export type RefreshDependencies = {
  store: RefreshStore;
  rateLimiter: RateLimiter;
  allowedChannelIds: ReadonlySet<string>;
  additionalOrigins?: ReadonlySet<string>;
  now?: () => Date;
  requestId?: () => string;
};
const TTL_MS = 120_000;
const MAX_BODY_BYTES = 1024;
const HEADERS = { "Cache-Control": "private, no-store, max-age=0", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" };

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function handleRefreshRequest(request: RefreshRequest, dependencies: RefreshDependencies): Promise<SnapshotResponse> {
  const cors = evaluateCors(request.origin, dependencies.additionalOrigins);
  const headers = { ...cors.headers, ...HEADERS };
  const respond = (status: number, body?: unknown): SnapshotResponse => ({ status, headers, ...(body === undefined ? {} : { body }) });
  const error = (status: number, code: string, message: string) => respond(status, { error: { code, message } });

  if (!cors.allowed) return error(403, "origin_not_allowed", "This origin is not allowed.");
  if (request.method === "OPTIONS") return respond(204);
  if (!["GET", "POST", "PUT"].includes(request.method)) {
    return { ...error(405, "method_not_allowed", "Use GET, POST or PUT."), headers: { ...headers, Allow: "GET, POST, PUT, OPTIONS" } };
  }
  if (dependencies.allowedChannelIds.size === 0) return error(503, "bridge_not_configured", "The personal sync bridge is not configured.");
  if (!isAuthorizedChannel(request.channelId, request.authorization)) return error(401, "unauthorized", "The sync credentials are invalid.");
  if (!dependencies.allowedChannelIds.has(request.channelId)) return error(404, "refresh_not_found", "No refresh request is available.");

  const rate = await dependencies.rateLimiter.consume(`refresh:${request.method.toLowerCase()}:${request.channelId}`, request.method === "POST" ? 10 : 120, 60);
  if (!rate.allowed) return { ...error(429, "rate_limited", "Too many sync requests. Please retry shortly."), headers: { ...headers, "Retry-After": String(rate.retryAfterSeconds) } };
  if (request.requestId !== undefined && !REQUEST_ID_PATTERN.test(request.requestId)) return error(400, "invalid_request_id", "The request ID is invalid.");
  if ((request.contentLength ?? 0) > MAX_BODY_BYTES) return error(413, "request_too_large", "The request is too large.");
  try {
    if (Buffer.byteLength(JSON.stringify(request.body ?? {}), "utf8") > MAX_BODY_BYTES) return error(413, "request_too_large", "The request is too large.");
  } catch {
    return error(400, "invalid_request", "The refresh request is invalid.");
  }
  const now = () => (dependencies.now ?? (() => new Date()))();

  if (request.method === "GET") {
    const requestId = request.requestId ?? (await dependencies.store.latest(request.channelId))?.value.requestId;
    const stored = requestId ? await dependencies.store.get(request.channelId, requestId) : null;
    if (!stored || Date.parse(stored.value.expiresAt) <= now().getTime()) return respond(204);
    return respond(200, stored.value);
  }

  if (request.method === "POST") {
    if (request.body !== undefined && (!isObject(request.body) || Object.keys(request.body).length > 0)) return error(400, "invalid_request", "Send an empty object.");
    // A conditional latest-pointer write coalesces simultaneous phone requests.
    // Each command has its own state so old acknowledgements cannot affect a new one.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const latest = await dependencies.store.latest(request.channelId);
      const existing = latest ? await dependencies.store.get(request.channelId, latest.value.requestId) : null;
      const timestamp = now();
      if (existing && Date.parse(existing.value.expiresAt) > timestamp.getTime() && ["pending", "running"].includes(existing.value.status)) return respond(200, existing.value);
      const command: RefreshCommand = {
        requestId: (dependencies.requestId ?? randomUUID)(),
        requestedAt: timestamp.toISOString(),
        expiresAt: new Date(timestamp.getTime() + TTL_MS).toISOString(),
        status: "pending",
      };
      if (!await dependencies.store.put(request.channelId, command, null)) continue;
      if (await dependencies.store.setLatest(request.channelId, command.requestId, latest?.revision ?? null)) return respond(200, command);
      await dependencies.store.delete(request.channelId, command.requestId).catch(() => undefined);
    }
    return error(409, "refresh_conflict", "Another refresh request is being created. Please retry.");
  }

  const body = request.body;
  if (!isObject(body)
    || Object.keys(body).some((key) => !["requestId", "status", "errorCode"].includes(key))
    || typeof body.requestId !== "string"
    || !REQUEST_ID_PATTERN.test(body.requestId)
    || typeof body.status !== "string"
    || !["running", "succeeded", "failed"].includes(body.status)) {
    return error(400, "invalid_request", "The refresh acknowledgement is invalid.");
  }
  if (body.status === "failed" ? body.errorCode !== undefined && !REFRESH_ERROR_CODES.includes(body.errorCode as RefreshErrorCode) : body.errorCode !== undefined) return error(400, "invalid_request", "The failure code is invalid.");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stored = await dependencies.store.get(request.channelId, body.requestId);
    if (!stored) return error(404, "refresh_not_found", "No refresh request is available.");
    const timestamp = now();
    if (Date.parse(stored.value.expiresAt) <= timestamp.getTime()) return error(410, "refresh_expired", "The refresh request has expired.");
    if (stored.value.status === "succeeded" || stored.value.status === "failed" || stored.value.status === body.status) return respond(200, stored.value);
    const command: RefreshCommand = {
      ...stored.value,
      status: body.status as "running" | "succeeded" | "failed",
      ...(body.status !== "running" ? { completedAt: new Date(Math.max(timestamp.getTime(), Date.parse(stored.value.requestedAt))).toISOString() } : {}),
      ...(body.status === "failed" ? { errorCode: (body.errorCode ?? "sync_failed") as RefreshErrorCode } : {}),
    };
    if (await dependencies.store.put(request.channelId, command, stored.revision)) return respond(200, command);
  }
  return error(409, "refresh_conflict", "The refresh status changed. Please retry.");
}
