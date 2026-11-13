import { createHash, timingSafeEqual } from "node:crypto";
import { decodeCanonicalBase64Url } from "./protocol.js";

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]+)$/;

export function parseBearerToken(authorization: string | undefined): Buffer | null {
  if (!authorization) return null;
  const match = BEARER_PATTERN.exec(authorization);
  if (!match) return null;
  const token = decodeCanonicalBase64Url(match[1]);
  return token?.byteLength === 32 ? token : null;
}

export function decodeChannelId(channelId: string): Buffer | null {
  const decoded = decodeCanonicalBase64Url(channelId);
  return decoded?.byteLength === 32 ? decoded : null;
}

export function isAuthorizedChannel(
  channelId: string,
  authorization: string | undefined,
): boolean {
  const token = parseBearerToken(authorization);
  const suppliedChannel = decodeChannelId(channelId);
  if (!token || !suppliedChannel) return false;

  const expectedChannel = createHash("sha256").update(token).digest();
  return timingSafeEqual(expectedChannel, suppliedChannel);
}

export function parseAllowedChannelIds(raw: string | undefined): ReadonlySet<string> {
  if (!raw?.trim()) return new Set();

  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const allowed = new Set<string>();
  for (const entry of entries) {
    if (!decodeChannelId(entry)) {
      throw new Error("SYNC_ALLOWED_CHANNEL_IDS contains an invalid channel ID.");
    }
    allowed.add(entry);
  }
  return allowed;
}
