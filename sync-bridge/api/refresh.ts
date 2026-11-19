import { parseAdditionalOrigins } from "../src/cors.js";
import { respondToBridgeFailure } from "../src/api-failure.js";
import { parseAllowedChannelIds } from "../src/security.js";
import { handleRefreshRequest } from "../src/refresh-service.js";
import { createD1RefreshStore } from "../src/d1-storage.js";
import { MemoryRateLimiter } from "../src/storage.js";
import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";

const rateLimiter = new MemoryRateLimiter();
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const origin = first(request.headers.origin);
  let additionalOrigins: ReadonlySet<string> = new Set();
  try {
    additionalOrigins = parseAdditionalOrigins(process.env.SYNC_ALLOWED_ORIGINS);
    const result = await handleRefreshRequest({
      method: request.method ?? "GET",
      channelId: first(request.query.channelId) ?? "",
      requestId: first(request.query.requestId),
      authorization: first(request.headers.authorization),
      origin,
      contentLength: Number(first(request.headers["content-length"])) || undefined,
      body: request.body,
    }, {
      store: createD1RefreshStore(),
      rateLimiter,
      allowedChannelIds: parseAllowedChannelIds(process.env.SYNC_ALLOWED_CHANNEL_IDS),
      additionalOrigins,
    });
    for (const [key, value] of Object.entries(result.headers)) response.setHeader(key, value);
    if (result.body === undefined) return response.status(result.status).end();
    return response.status(result.status).json(result.body);
  } catch (error) {
    return respondToBridgeFailure(response, origin, additionalOrigins, "refresh", error);
  }
}
