import { randomUUID } from "node:crypto";
import { isCommand, REQUEST_ID_PATTERN, type RefreshCommand, type RefreshStore, type Versioned } from "./refresh-store.js";
import { decodeChannelId } from "./security.js";
import { isStoredSnapshot, type SnapshotStore, type StoredSnapshot } from "./storage.js";
import { RedisStorageError, UpstashRestClient, type RedisExecutor } from "./redis-client.js";

export const REDIS_LATEST_TTL_SECONDS = 180;
export const REDIS_COMMAND_TTL_SECONDS = 86_400;

/** A single EVAL keeps revision comparison and replacement indivisible. */
export const REDIS_CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '' then
  if current then return 0 end
else
  if not current then return 0 end
  local ok, decoded = pcall(cjson.decode, current)
  if not ok or type(decoded) ~= 'table' or decoded.revision ~= ARGV[1] then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

function channelKey(channelId: string): string {
  if (!decodeChannelId(channelId)) throw new RedisStorageError("redis_invalid_data");
  return `spotlog:v1:${channelId}`;
}

function requestKey(channelId: string, requestId: string): string {
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new RedisStorageError("redis_invalid_data");
  return `${channelKey(channelId)}:refresh:${requestId}`;
}

function parseStoredJson(raw: unknown): unknown {
  if (typeof raw !== "string") throw new RedisStorageError("redis_invalid_data");
  try { return JSON.parse(raw) as unknown; }
  catch { throw new RedisStorageError("redis_invalid_data"); }
}

function isVersioned(value: unknown): value is Versioned<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<Versioned<unknown>>;
  return typeof candidate.revision === "string" && REQUEST_ID_PATTERN.test(candidate.revision)
    && Object.hasOwn(candidate, "value");
}

export class RedisSnapshotStore implements SnapshotStore {
  constructor(private readonly redis: RedisExecutor = new UpstashRestClient(), private readonly now: () => number = Date.now) {}

  async get(channelId: string): Promise<StoredSnapshot | null> {
    const raw = await this.redis.command(["GET", `${channelKey(channelId)}:snapshot`]);
    if (raw === null) return null;
    const stored = parseStoredJson(raw);
    // Corruption must not masquerade as an empty inbox and lose merge history.
    if (!isStoredSnapshot(stored)) throw new RedisStorageError("redis_invalid_data");
    return Date.parse(stored.expiresAt) <= this.now() ? null : stored;
  }

  async put(channelId: string, snapshot: StoredSnapshot): Promise<void> {
    if (!isStoredSnapshot(snapshot)) throw new RedisStorageError("redis_invalid_data");
    const ttl = Math.ceil((Date.parse(snapshot.expiresAt) - this.now()) / 1000);
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new RedisStorageError("redis_invalid_data");
    const result = await this.redis.command(["SET", `${channelKey(channelId)}:snapshot`, JSON.stringify(snapshot), "EX", ttl]);
    if (result !== "OK") throw new RedisStorageError("redis_invalid_response");
  }

  async delete(channelId: string): Promise<void> {
    const result = await this.redis.command(["DEL", `${channelKey(channelId)}:snapshot`]);
    if (result !== 0 && result !== 1) throw new RedisStorageError("redis_invalid_response");
  }
}

export class RedisRefreshStore implements RefreshStore {
  constructor(private readonly redis: RedisExecutor = new UpstashRestClient()) {}

  private async read(key: string): Promise<Versioned<unknown> | null> {
    const raw = await this.redis.command(["GET", key]);
    if (raw === null) return null;
    const value = parseStoredJson(raw);
    if (!isVersioned(value)) throw new RedisStorageError("redis_invalid_data");
    return value;
  }

  private async write(key: string, value: unknown, revision: string | null, ttl: number): Promise<boolean> {
    if (revision !== null && !REQUEST_ID_PATTERN.test(revision)) throw new RedisStorageError("redis_invalid_data");
    const stored: Versioned<unknown> = { value, revision: randomUUID() };
    const result = await this.redis.command(["EVAL", REDIS_CAS_SCRIPT, 1, key, revision ?? "", JSON.stringify(stored), ttl]);
    if (result !== 0 && result !== 1) throw new RedisStorageError("redis_invalid_response");
    return result === 1;
  }

  async latest(channelId: string): Promise<Versioned<{ requestId: string }> | null> {
    const stored = await this.read(`${channelKey(channelId)}:refresh:latest`);
    if (!stored) return null;
    const value = stored.value as { requestId?: unknown } | null;
    if (!value || typeof value !== "object" || typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)) {
      throw new RedisStorageError("redis_invalid_data");
    }
    return { value: { requestId: value.requestId }, revision: stored.revision };
  }

  async setLatest(channelId: string, requestId: string, revision: string | null): Promise<boolean> {
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new RedisStorageError("redis_invalid_data");
    return this.write(`${channelKey(channelId)}:refresh:latest`, { requestId }, revision, REDIS_LATEST_TTL_SECONDS);
  }

  async get(channelId: string, requestId: string): Promise<Versioned<RefreshCommand> | null> {
    const stored = await this.read(requestKey(channelId, requestId));
    if (!stored) return null;
    if (!isCommand(stored.value) || stored.value.requestId !== requestId) throw new RedisStorageError("redis_invalid_data");
    return { value: stored.value, revision: stored.revision };
  }

  async put(channelId: string, command: RefreshCommand, revision: string | null): Promise<boolean> {
    if (!isCommand(command)) throw new RedisStorageError("redis_invalid_data");
    return this.write(requestKey(channelId, command.requestId), command, revision, REDIS_COMMAND_TTL_SECONDS);
  }

  async delete(channelId: string, requestId: string): Promise<void> {
    const result = await this.redis.command(["DEL", requestKey(channelId, requestId)]);
    if (result !== 0 && result !== 1) throw new RedisStorageError("redis_invalid_response");
  }
}

// Leave time for the API handler to return a CORS-readable error before Vercel's
// 10-second function deadline, including requests needing several Redis calls.
export function createRedisSnapshotStore(): SnapshotStore {
  return new RedisSnapshotStore(new UpstashRestClient({ deadlineAt: Date.now() + 8_000 }));
}
export function createRedisRefreshStore(): RefreshStore {
  return new RedisRefreshStore(new UpstashRestClient({ deadlineAt: Date.now() + 8_000 }));
}
