const DEFAULT_ORIGINS = new Set([
  "https://spotlog-worker.vercel.app",
  "https://spotjobs-reward-inventory-manager.vercel.app",
  "capacitor://localhost",
]);

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

export type CorsDecision =
  | { allowed: true; headers: Record<string, string> }
  | { allowed: false; headers: Record<string, string> };

export function parseAdditionalOrigins(raw: string | undefined): ReadonlySet<string> {
  if (!raw?.trim()) return new Set();
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  for (const value of values) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("SYNC_ALLOWED_ORIGINS contains an invalid origin.");
    }
    if (parsed.origin !== value || parsed.protocol !== "https:") {
      throw new Error("Extra sync origins must be exact HTTPS origins.");
    }
  }
  return new Set(values);
}

export function evaluateCors(
  origin: string | undefined,
  additionalOrigins: ReadonlySet<string> = new Set(),
): CorsDecision {
  const common = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
  };

  // Native clients and same-origin/server requests may omit Origin. Authentication
  // still applies to every data request.
  if (!origin) return { allowed: true, headers: common };

  if (
    DEFAULT_ORIGINS.has(origin) ||
    additionalOrigins.has(origin) ||
    EXTENSION_ORIGIN.test(origin) ||
    LOCAL_ORIGIN.test(origin)
  ) {
    return {
      allowed: true,
      headers: { ...common, "Access-Control-Allow-Origin": origin },
    };
  }

  return { allowed: false, headers: { Vary: "Origin" } };
}
