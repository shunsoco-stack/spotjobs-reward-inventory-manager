import { evaluateCors, parseAdditionalOrigins } from "../src/cors.js";
import { respondToBridgeFailure } from "../src/api-failure.js";
import { RedisStorageError, UpstashRestClient } from "../src/redis-client.js";
import { parseAllowedChannelIds } from "../src/security.js";
import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const origin = firstHeader(request.headers.origin);
  let additionalOrigins: ReadonlySet<string> = new Set();
  try {
    additionalOrigins = parseAdditionalOrigins(process.env.SYNC_ALLOWED_ORIGINS);
    const cors = evaluateCors(origin, additionalOrigins);
    for (const [key, value] of Object.entries(cors.headers)) response.setHeader(key, value);
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (!cors.allowed) return response.status(403).json({ ok: false });

    if (request.method === "OPTIONS") return response.status(204).end();
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET, OPTIONS");
      return response.status(405).json({ ok: false });
    }

    if (parseAllowedChannelIds(process.env.SYNC_ALLOWED_CHANNEL_IDS).size === 0) {
      throw new Error("The personal sync bridge is not configured.");
    }
    // A configured environment is not proof that its storage is reachable.
    // PING does not read user data and is bounded below the function timeout.
    const pong = await new UpstashRestClient({ timeoutMs: 3_000 }).command(["PING"]);
    if (pong !== "PONG") throw new RedisStorageError("redis_invalid_response");

    return response.status(200).json({
      ok: true,
      service: "spotjobs-encrypted-sync-bridge",
      protocolVersion: 1,
      storage: "redis",
    });
  } catch (error) {
    return respondToBridgeFailure(response, origin, additionalOrigins, "health", error);
  }
}
