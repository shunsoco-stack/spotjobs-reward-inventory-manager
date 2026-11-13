import { Buffer } from "node:buffer";

export const SYNC_PROTOCOL_VERSION = 1 as const;
export const SYNC_SOURCE = "spotjobs-edge" as const;
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_CIPHERTEXT_BYTES = 700 * 1024;
export const MAX_RECORD_COUNT = 10_000;

export type EncryptedSnapshotEnvelope = {
  version: typeof SYNC_PROTOCOL_VERSION;
  iv: string;
  ciphertext: string;
  recordCount: number;
  source: typeof SYNC_SOURCE;
  collectedAt: string;
};

const ENVELOPE_KEYS = [
  "ciphertext",
  "collectedAt",
  "iv",
  "recordCount",
  "source",
  "version",
] as const;

export type EnvelopeValidationResult =
  | { ok: true; value: EncryptedSnapshotEnvelope }
  | { ok: false; reason: string; tooLarge?: boolean };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

export function decodeCanonicalBase64Url(value: unknown): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }

  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

export function validateEnvelope(
  value: unknown,
  serializedSize?: number,
): EnvelopeValidationResult {
  if (serializedSize !== undefined && serializedSize > MAX_REQUEST_BYTES) {
    return { ok: false, reason: "The encrypted snapshot is too large.", tooLarge: true };
  }

  if (!isPlainObject(value)) {
    return { ok: false, reason: "The request body must be a JSON object." };
  }

  const keys = Object.keys(value).sort();
  if (
    keys.length !== ENVELOPE_KEYS.length ||
    keys.some((key, index) => key !== ENVELOPE_KEYS[index])
  ) {
    return { ok: false, reason: "The encrypted snapshot schema is invalid." };
  }

  if (value.version !== SYNC_PROTOCOL_VERSION || value.source !== SYNC_SOURCE) {
    return { ok: false, reason: "The sync protocol version or source is unsupported." };
  }

  const iv = decodeCanonicalBase64Url(value.iv);
  if (!iv || iv.byteLength !== 12) {
    return { ok: false, reason: "The AES-GCM IV must be 12 bytes of base64url data." };
  }

  const ciphertext = decodeCanonicalBase64Url(value.ciphertext);
  if (!ciphertext || ciphertext.byteLength < 16) {
    return { ok: false, reason: "The AES-GCM ciphertext is invalid." };
  }
  if (ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) {
    return { ok: false, reason: "The encrypted snapshot is too large.", tooLarge: true };
  }

  if (
    !Number.isSafeInteger(value.recordCount) ||
    (value.recordCount as number) < 0 ||
    (value.recordCount as number) > MAX_RECORD_COUNT
  ) {
    return { ok: false, reason: "The encrypted snapshot record count is invalid." };
  }

  if (
    typeof value.collectedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.collectedAt) ||
    !Number.isFinite(Date.parse(value.collectedAt))
  ) {
    return { ok: false, reason: "The collection time must be an ISO 8601 UTC timestamp." };
  }

  return { ok: true, value: value as EncryptedSnapshotEnvelope };
}
