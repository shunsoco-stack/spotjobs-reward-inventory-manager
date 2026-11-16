import { parseAdditionalOrigins } from "../src/cors.js";
import { respondToBridgeFailure } from "../src/api-failure.js";
import { parseAllowedChannelIds } from "../src/security.js";
import { handleSnapshotRequest } from "../src/service.js";
import { createRedisSnapshotStore } from "../src/redis-storage.js";
import {
  getSnapshotTtlSeconds,
  MemoryRateLimiter,
} from "../src/storage.js";
import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";

// Best-effort per-instance protection complements Vercel Firewall/CDN controls.
// Access is additionally restricted to a server-side personal channel allowlist.
const rateLimiter = new MemoryRateLimiter();

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function firstQuery(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const origin = firstHeader(request.headers.origin);
  let additionalOrigins: ReadonlySet<string> = new Set();
  try {
    additionalOrigins = parseAdditionalOrigins(process.env.SYNC_ALLOWED_ORIGINS);
    // Credentials are checked lazily on the first storage command. Preflight and
    // authorization failures must not depend on a database being available.
    const store = createRedisSnapshotStore();
    const result = await handleSnapshotRequest(
      {
        method: request.method ?? "GET",
        channelId: firstQuery(request.query.channelId),
        authorization: firstHeader(request.headers.authorization),
        origin,
        contentLength: Number(firstHeader(request.headers["content-length"])) || undefined,
        body: request.body,
      },
      {
        store,
        rateLimiter,
        allowedChannelIds: parseAllowedChannelIds(process.env.SYNC_ALLOWED_CHANNEL_IDS),
        additionalOrigins,
        snapshotTtlSeconds: getSnapshotTtlSeconds(),
      },
    );

    for (const [key, value] of Object.entries(result.headers)) {
      response.setHeader(key, value);
    }
    if (result.body === undefined) return response.status(result.status).end();
    return response.status(result.status).json(result.body);
  } catch (error) {
    return respondToBridgeFailure(response, origin, additionalOrigins, "snapshot", error);
  }
}
