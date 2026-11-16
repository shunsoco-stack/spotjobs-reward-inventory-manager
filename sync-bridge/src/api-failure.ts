import { evaluateCors } from "./cors.js";
import { RedisStorageError } from "./redis-client.js";
import type { VercelResponse } from "./vercel-types.js";

const SAFE_STORAGE_CODES = new Set([
  "redis_not_configured",
  "redis_unavailable",
  "redis_timeout",
  "redis_invalid_response",
  "redis_invalid_data",
]);

/** Keep failures readable by trusted clients without disclosing provider details. */
export function respondToBridgeFailure(
  response: VercelResponse,
  origin: string | undefined,
  additionalOrigins: ReadonlySet<string>,
  operation: "snapshot" | "refresh" | "health",
  error: unknown,
): unknown {
  const cors = evaluateCors(origin, additionalOrigins);
  for (const [key, value] of Object.entries(cors.headers)) response.setHeader(key, value);
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (!cors.allowed) {
    return response.status(403).json({
      error: { code: "origin_not_allowed", message: "This origin is not allowed." },
    });
  }

  // Never log the original error, stack, URL, credentials, channel or request body.
  const code = error instanceof RedisStorageError && SAFE_STORAGE_CODES.has(error.code)
    ? error.code
    : "bridge_unavailable";
  console.error("sync_bridge_unavailable", { operation, code });
  response.setHeader("Retry-After", "30");
  return response.status(503).json({
    error: { code: "bridge_unavailable", message: "The sync bridge is temporarily unavailable." },
  });
}
