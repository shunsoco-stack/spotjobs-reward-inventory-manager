import { evaluateCors } from "./cors.js";
import { D1StorageError } from "./d1-client.js";
import type { VercelResponse } from "./vercel-types.js";

const SAFE_STORAGE_CODES = new Set([
  "d1_not_configured",
  "d1_unavailable",
  "d1_timeout",
  "d1_invalid_response",
  "d1_invalid_data",
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
  const code = error instanceof D1StorageError && SAFE_STORAGE_CODES.has(error.code)
    ? error.code
    : "bridge_unavailable";
  console.error("sync_bridge_unavailable", { operation, code });
  response.setHeader("Retry-After", "30");
  return response.status(503).json({
    error: { code: "bridge_unavailable", message: "The sync bridge is temporarily unavailable." },
  });
}
