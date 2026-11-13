import { parseAdditionalOrigins } from "../src/cors.js";
import { parseAllowedChannelIds } from "../src/security.js";
import { handleSnapshotRequest } from "../src/service.js";
import {
  createVercelBlobStore,
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
  try {
    const store = createVercelBlobStore();
    const result = await handleSnapshotRequest(
      {
        method: request.method ?? "GET",
        channelId: firstQuery(request.query.channelId),
        authorization: firstHeader(request.headers.authorization),
        origin: firstHeader(request.headers.origin),
        contentLength: Number(firstHeader(request.headers["content-length"])) || undefined,
        body: request.body,
      },
      {
        store,
        rateLimiter,
        allowedChannelIds: parseAllowedChannelIds(process.env.SYNC_ALLOWED_CHANNEL_IDS),
        additionalOrigins: parseAdditionalOrigins(process.env.SYNC_ALLOWED_ORIGINS),
        snapshotTtlSeconds: getSnapshotTtlSeconds(),
      },
    );

    for (const [key, value] of Object.entries(result.headers)) {
      response.setHeader(key, value);
    }
    if (result.body === undefined) return response.status(result.status).end();
    return response.status(result.status).json(result.body);
  } catch {
    // Configuration/storage failures are deliberately generic so credentials and
    // provider details never leak through the public endpoint.
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    return response.status(503).json({
      error: {
        code: "bridge_unavailable",
        message: "The encrypted sync bridge is temporarily unavailable.",
      },
    });
  }
}
