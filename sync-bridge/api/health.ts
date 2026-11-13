import { evaluateCors, parseAdditionalOrigins } from "../src/cors.js";
import { parseAllowedChannelIds } from "../src/security.js";
import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function handler(request: VercelRequest, response: VercelResponse) {
  let cors;
  let configured = false;
  try {
    cors = evaluateCors(
      firstHeader(request.headers.origin),
      parseAdditionalOrigins(process.env.SYNC_ALLOWED_ORIGINS),
    );
    configured =
      parseAllowedChannelIds(process.env.SYNC_ALLOWED_CHANNEL_IDS).size > 0 &&
      Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
  } catch {
    cors = evaluateCors(firstHeader(request.headers.origin));
  }

  if (!cors.allowed) return response.status(403).json({ ok: false });
  for (const [key, value] of Object.entries(cors.headers)) response.setHeader(key, value);
  response.setHeader("Cache-Control", "private, no-store, max-age=0");

  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET, OPTIONS");
    return response.status(405).json({ ok: false });
  }

  return response.status(configured ? 200 : 503).json({
    ok: configured,
    service: "spotjobs-encrypted-sync-bridge",
    protocolVersion: 1,
  });
}
