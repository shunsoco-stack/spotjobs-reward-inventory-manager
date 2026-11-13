import { Buffer } from "node:buffer";
import { evaluateCors } from "./cors.js";
import {
  MAX_REQUEST_BYTES,
  validateEnvelope,
} from "./protocol.js";
import { isAuthorizedChannel } from "./security.js";
import type { RateLimiter, SnapshotStore } from "./storage.js";

export type SnapshotRequest = {
  method: string;
  channelId: string;
  authorization?: string;
  origin?: string;
  contentLength?: number;
  body?: unknown;
};

export type ServiceDependencies = {
  store: SnapshotStore;
  rateLimiter: RateLimiter;
  allowedChannelIds: ReadonlySet<string>;
  additionalOrigins?: ReadonlySet<string>;
  now?: () => Date;
  snapshotTtlSeconds?: number;
};

export type SnapshotResponse = {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
};

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function jsonResponse(
  status: number,
  headers: Record<string, string>,
  body: unknown,
): SnapshotResponse {
  return { status, headers: { ...headers, ...NO_STORE_HEADERS }, body };
}

function errorResponse(
  status: number,
  headers: Record<string, string>,
  code: string,
  message: string,
): SnapshotResponse {
  return jsonResponse(status, headers, { error: { code, message } });
}

export async function handleSnapshotRequest(
  request: SnapshotRequest,
  dependencies: ServiceDependencies,
): Promise<SnapshotResponse> {
  const cors = evaluateCors(request.origin, dependencies.additionalOrigins);
  if (!cors.allowed) {
    return errorResponse(403, cors.headers, "origin_not_allowed", "This origin is not allowed.");
  }

  if (request.method === "OPTIONS") {
    return { status: 204, headers: { ...cors.headers, ...NO_STORE_HEADERS } };
  }

  if (request.method !== "GET" && request.method !== "PUT" && request.method !== "DELETE") {
    return {
      ...errorResponse(405, cors.headers, "method_not_allowed", "Use GET, PUT or DELETE."),
      headers: {
        ...cors.headers,
        ...NO_STORE_HEADERS,
        Allow: "GET, PUT, DELETE, OPTIONS",
      },
    };
  }

  if (dependencies.allowedChannelIds.size === 0) {
    return errorResponse(
      503,
      cors.headers,
      "bridge_not_configured",
      "The personal sync bridge is not configured.",
    );
  }

  if (!isAuthorizedChannel(request.channelId, request.authorization)) {
    return errorResponse(401, cors.headers, "unauthorized", "The sync credentials are invalid.");
  }

  // Return the same response as an empty inbox so a valid credential cannot be
  // used to enumerate another person's configured channels.
  if (!dependencies.allowedChannelIds.has(request.channelId)) {
    return errorResponse(404, cors.headers, "snapshot_not_found", "No snapshot is available.");
  }

  const limit = request.method === "PUT" ? 30 : request.method === "DELETE" ? 10 : 120;
  const rate = await dependencies.rateLimiter.consume(
    `${request.method.toLowerCase()}:${request.channelId}`,
    limit,
    60,
  );
  if (!rate.allowed) {
    const response = errorResponse(
      429,
      cors.headers,
      "rate_limited",
      "Too many sync requests. Please retry shortly.",
    );
    response.headers["Retry-After"] = String(rate.retryAfterSeconds);
    return response;
  }

  if (request.method === "GET") {
    const stored = await dependencies.store.get(request.channelId);
    if (!stored) {
      return errorResponse(404, cors.headers, "snapshot_not_found", "No snapshot is available.");
    }
    return jsonResponse(
      200,
      { ...cors.headers, "X-SPOTJOBS-Manager-Stored-At": stored.storedAt },
      stored,
    );
  }

  if (request.method === "DELETE") {
    await dependencies.store.delete(request.channelId);
    return { status: 204, headers: { ...cors.headers, ...NO_STORE_HEADERS } };
  }

  if (request.contentLength !== undefined && request.contentLength > MAX_REQUEST_BYTES) {
    return errorResponse(413, cors.headers, "snapshot_too_large", "The encrypted snapshot is too large.");
  }

  let serializedSize: number | undefined;
  try {
    serializedSize = Buffer.byteLength(JSON.stringify(request.body), "utf8");
  } catch {
    return errorResponse(400, cors.headers, "invalid_snapshot", "The encrypted snapshot is invalid.");
  }
  const validation = validateEnvelope(request.body, serializedSize);
  if (!validation.ok) {
    return errorResponse(
      validation.tooLarge ? 413 : 400,
      cors.headers,
      validation.tooLarge ? "snapshot_too_large" : "invalid_snapshot",
      validation.reason,
    );
  }

  const storedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const expiresAt = new Date(
    Date.parse(storedAt) + (dependencies.snapshotTtlSeconds ?? 7_776_000) * 1000,
  ).toISOString();
  await dependencies.store.put(request.channelId, {
    envelope: validation.value,
    storedAt,
    expiresAt,
  });
  return jsonResponse(200, cors.headers, { ok: true, storedAt, expiresAt });
}
