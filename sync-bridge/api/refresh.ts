import { parseAdditionalOrigins } from "../src/cors.js";
import { parseAllowedChannelIds } from "../src/security.js";
import { handleRefreshRequest } from "../src/refresh-service.js";
import { createVercelBlobRefreshStore } from "../src/refresh-store.js";
import { MemoryRateLimiter } from "../src/storage.js";
import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";

const rateLimiter = new MemoryRateLimiter();
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export default async function handler(request: VercelRequest, response: VercelResponse) {
  try {
    const result = await handleRefreshRequest({
      method: request.method ?? "GET",
      channelId: first(request.query.channelId) ?? "",
      requestId: first(request.query.requestId),
      authorization: first(request.headers.authorization),
      origin: first(request.headers.origin),
      contentLength: Number(first(request.headers["content-length"])) || undefined,
      body: request.body,
    }, {
      store: createVercelBlobRefreshStore(),
      rateLimiter,
      allowedChannelIds: parseAllowedChannelIds(process.env.SYNC_ALLOWED_CHANNEL_IDS),
      additionalOrigins: parseAdditionalOrigins(process.env.SYNC_ALLOWED_ORIGINS),
    });
    for (const [key, value] of Object.entries(result.headers)) response.setHeader(key, value);
    if (result.body === undefined) return response.status(result.status).end();
    return response.status(result.status).json(result.body);
  } catch {
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    return response.status(503).json({ error: { code: "bridge_unavailable", message: "The sync bridge is temporarily unavailable." } });
  }
}
