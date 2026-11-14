import { del, get, put } from "@vercel/blob";
import { validateEnvelope } from "./protocol.js";
import type { EncryptedSnapshotEnvelope } from "./protocol.js";

export type StoredSnapshot = {
  envelope: EncryptedSnapshotEnvelope;
  storedAt: string;
  expiresAt: string;
};

export interface SnapshotStore {
  get(channelId: string): Promise<StoredSnapshot | null>;
  put(channelId: string, snapshot: StoredSnapshot): Promise<void>;
  delete(channelId: string): Promise<void>;
}

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision>;
}

export class MemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, StoredSnapshot>();

  async get(channelId: string): Promise<StoredSnapshot | null> {
    return this.snapshots.get(channelId) ?? null;
  }

  async put(channelId: string, snapshot: StoredSnapshot): Promise<void> {
    this.snapshots.set(channelId, structuredClone(snapshot));
  }

  async delete(channelId: string): Promise<void> {
    this.snapshots.delete(channelId);
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetsAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
    const now = this.now();
    const current = this.buckets.get(key);
    const bucket =
      !current || current.resetsAt <= now
        ? { count: 0, resetsAt: now + windowSeconds * 1000 }
        : current;
    bucket.count += 1;
    this.buckets.set(key, bucket);

    return {
      allowed: bucket.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetsAt - now) / 1000)),
    };
  }
}

function blobPath(channelId: string): string {
  return `snapshots/${channelId}.json`;
}

function isStoredSnapshot(value: unknown): value is StoredSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredSnapshot>;
  return (
    validateEnvelope(candidate.envelope).ok &&
    typeof candidate.storedAt === "string" &&
    Number.isFinite(Date.parse(candidate.storedAt)) &&
    typeof candidate.expiresAt === "string" &&
    Number.isFinite(Date.parse(candidate.expiresAt))
  );
}

export class VercelBlobSnapshotStore implements SnapshotStore {
  constructor(
    private readonly token?: string,
    private readonly now: () => number = Date.now,
  ) {}

  private credentials(): { token: string } | Record<string, never> {
    return this.token ? { token: this.token } : {};
  }

  async get(channelId: string): Promise<StoredSnapshot | null> {
    const path = blobPath(channelId);
    const result = await get(path, { access: "private", useCache: false, ...this.credentials() });
    if (!result || result.statusCode !== 200 || !result.stream) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await new Response(result.stream).text()) as unknown;
    } catch {
      return null;
    }
    if (!isStoredSnapshot(parsed)) return null;

    if (Date.parse(parsed.expiresAt) <= this.now()) {
      await del(path, this.credentials()).catch(() => undefined);
      return null;
    }
    return parsed;
  }

  async put(channelId: string, snapshot: StoredSnapshot): Promise<void> {
    await put(blobPath(channelId), JSON.stringify(snapshot), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      ...this.credentials(),
    });
  }

  async delete(channelId: string): Promise<void> {
    await del(blobPath(channelId), this.credentials());
  }
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("SYNC_SNAPSHOT_TTL_SECONDS must be a positive integer.");
  }
  return parsed;
}

export function getSnapshotTtlSeconds(): number {
  return readPositiveInteger(process.env.SYNC_SNAPSHOT_TTL_SECONDS, 7_776_000);
}

export function createVercelBlobStore(): SnapshotStore {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  // New Vercel connections use short-lived OIDC credentials selected by
  // BLOB_STORE_ID. A static token remains an explicit local/legacy fallback.
  if (!token && !process.env.BLOB_STORE_ID) {
    throw new Error("Private Vercel Blob is not connected.");
  }
  return new VercelBlobSnapshotStore(token);
}
