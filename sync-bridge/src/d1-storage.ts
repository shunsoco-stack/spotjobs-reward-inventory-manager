import { randomUUID } from "node:crypto";
import { D1GatewayClient, D1StorageError, type D1GatewayExecutor } from "./d1-client.js";
import { isCommand, REQUEST_ID_PATTERN, type RefreshCommand, type RefreshStore, type Versioned } from "./refresh-store.js";
import { decodeChannelId } from "./security.js";
import { isStoredSnapshot, type SnapshotStore, type StoredSnapshot } from "./storage.js";

export const D1_LATEST_TTL_SECONDS = 180;
export const D1_COMMAND_TTL_SECONDS = 86_400;

function channelKey(channelId: string): string {
  if (!decodeChannelId(channelId)) throw new D1StorageError("d1_invalid_data");
  return `spotlog:v1:${channelId}`;
}

function requestKey(channelId: string, requestId: string): string {
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new D1StorageError("d1_invalid_data");
  return `${channelKey(channelId)}:refresh:${requestId}`;
}

function parseStoredJson(raw: unknown): unknown {
  if (typeof raw !== "string") throw new D1StorageError("d1_invalid_data");
  try { return JSON.parse(raw) as unknown; }
  catch { throw new D1StorageError("d1_invalid_data"); }
}

function isVersioned(value: unknown): value is Versioned<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<Versioned<unknown>>;
  return typeof candidate.revision === "string" && REQUEST_ID_PATTERN.test(candidate.revision)
    && Object.hasOwn(candidate, "value");
}

export class D1SnapshotStore implements SnapshotStore {
  constructor(private readonly gateway: D1GatewayExecutor = new D1GatewayClient(), private readonly now: () => number = Date.now) {}

  async get(channelId: string): Promise<StoredSnapshot | null> {
    const result = await this.gateway.request({ op: "get", key: `${channelKey(channelId)}:snapshot` });
    if (result.value === null) return null;
    const stored = parseStoredJson(result.value);
    // Corruption must not masquerade as an empty inbox and discard merge history.
    if (!isStoredSnapshot(stored)) throw new D1StorageError("d1_invalid_data");
    return Date.parse(stored.expiresAt) <= this.now() ? null : stored;
  }

  async put(channelId: string, snapshot: StoredSnapshot): Promise<void> {
    if (!isStoredSnapshot(snapshot)) throw new D1StorageError("d1_invalid_data");
    const expiresAt = Date.parse(snapshot.expiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) throw new D1StorageError("d1_invalid_data");
    await this.gateway.request({ op: "set", key: `${channelKey(channelId)}:snapshot`, value: JSON.stringify(snapshot), expiresAt });
  }

  async delete(channelId: string): Promise<void> {
    await this.gateway.request({ op: "delete", key: `${channelKey(channelId)}:snapshot` });
  }
}

export class D1RefreshStore implements RefreshStore {
  constructor(private readonly gateway: D1GatewayExecutor = new D1GatewayClient(), private readonly now: () => number = Date.now) {}

  private async read(key: string): Promise<Versioned<unknown> | null> {
    const result = await this.gateway.request({ op: "get", key });
    if (result.value === null) return null;
    const stored = parseStoredJson(result.value);
    if (!isVersioned(stored)) throw new D1StorageError("d1_invalid_data");
    return stored;
  }

  private async write(key: string, value: unknown, revision: string | null, ttl: number): Promise<boolean> {
    if (revision !== null && !REQUEST_ID_PATTERN.test(revision)) throw new D1StorageError("d1_invalid_data");
    const stored: Versioned<unknown> = { value, revision: randomUUID() };
    // The Worker applies the expected revision and replacement in one D1 write.
    const result = await this.gateway.request({
      op: "cas", key, value: JSON.stringify(stored), expectedRevision: revision,
      revision: stored.revision, expiresAt: this.now() + ttl * 1000,
    });
    if (typeof result.applied !== "boolean") throw new D1StorageError("d1_invalid_response");
    return result.applied;
  }

  async latest(channelId: string): Promise<Versioned<{ requestId: string }> | null> {
    const stored = await this.read(`${channelKey(channelId)}:refresh:latest`);
    if (!stored) return null;
    const value = stored.value as { requestId?: unknown } | null;
    if (!value || typeof value !== "object" || typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)) {
      throw new D1StorageError("d1_invalid_data");
    }
    return { value: { requestId: value.requestId }, revision: stored.revision };
  }

  async setLatest(channelId: string, requestId: string, revision: string | null): Promise<boolean> {
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new D1StorageError("d1_invalid_data");
    return this.write(`${channelKey(channelId)}:refresh:latest`, { requestId }, revision, D1_LATEST_TTL_SECONDS);
  }

  async get(channelId: string, requestId: string): Promise<Versioned<RefreshCommand> | null> {
    const stored = await this.read(requestKey(channelId, requestId));
    if (!stored) return null;
    if (!isCommand(stored.value) || stored.value.requestId !== requestId) throw new D1StorageError("d1_invalid_data");
    return { value: stored.value, revision: stored.revision };
  }

  async put(channelId: string, command: RefreshCommand, revision: string | null): Promise<boolean> {
    if (!isCommand(command)) throw new D1StorageError("d1_invalid_data");
    return this.write(requestKey(channelId, command.requestId), command, revision, D1_COMMAND_TTL_SECONDS);
  }

  async delete(channelId: string, requestId: string): Promise<void> {
    await this.gateway.request({ op: "delete", key: requestKey(channelId, requestId) });
  }
}

// All gateway calls within one API request share a single eight-second budget.
export function createD1SnapshotStore(): SnapshotStore {
  return new D1SnapshotStore(new D1GatewayClient({ deadlineAt: Date.now() + 8_000 }));
}
export function createD1RefreshStore(): RefreshStore {
  return new D1RefreshStore(new D1GatewayClient({ deadlineAt: Date.now() + 8_000 }));
}
