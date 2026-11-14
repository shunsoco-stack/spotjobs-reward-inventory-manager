import { BlobPreconditionFailedError, del, get, put } from "@vercel/blob";

export const REFRESH_ERROR_CODES = ["auth_required", "page_required", "disabled", "sync_failed"] as const;
export type RefreshErrorCode = (typeof REFRESH_ERROR_CODES)[number];
export type RefreshStatus = "pending" | "running" | "succeeded" | "failed";
export type RefreshCommand = {
  requestId: string;
  requestedAt: string;
  expiresAt: string;
  status: RefreshStatus;
  completedAt?: string;
  errorCode?: RefreshErrorCode;
};
export type Versioned<T> = { value: T; revision: string };

export interface RefreshStore {
  latest(channelId: string): Promise<Versioned<{ requestId: string }> | null>;
  setLatest(channelId: string, requestId: string, revision: string | null): Promise<boolean>;
  get(channelId: string, requestId: string): Promise<Versioned<RefreshCommand> | null>;
  put(channelId: string, command: RefreshCommand, revision: string | null): Promise<boolean>;
  delete(channelId: string, requestId: string): Promise<void>;
}

export const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCommand(value: unknown): value is RefreshCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const command = value as Partial<RefreshCommand>;
  if (typeof command.requestId !== "string" || !REQUEST_ID_PATTERN.test(command.requestId)) return false;
  if (typeof command.requestedAt !== "string" || !Number.isFinite(Date.parse(command.requestedAt))) return false;
  if (typeof command.expiresAt !== "string" || Date.parse(command.expiresAt) <= Date.parse(command.requestedAt)) return false;
  if (!Number.isFinite(Date.parse(command.expiresAt))) return false;
  if (command.status === "pending" || command.status === "running") {
    return command.completedAt === undefined && command.errorCode === undefined;
  }
  if (command.status !== "succeeded" && command.status !== "failed") return false;
  if (typeof command.completedAt !== "string" || !Number.isFinite(Date.parse(command.completedAt))) return false;
  if (Date.parse(command.completedAt) < Date.parse(command.requestedAt)) return false;
  return command.status === "failed"
    ? REFRESH_ERROR_CODES.includes(command.errorCode as RefreshErrorCode)
    : command.errorCode === undefined;
}

/** Atomic revision checks model Blob's ETag conditional writes. */
export class MemoryRefreshStore implements RefreshStore {
  private readonly values = new Map<string, Versioned<unknown>>();
  private revision = 0;

  private read<T>(key: string): Versioned<T> | null {
    const stored = this.values.get(key);
    return stored ? structuredClone(stored) as Versioned<T> : null;
  }

  private write(key: string, value: unknown, revision: string | null): boolean {
    if ((this.values.get(key)?.revision ?? null) !== revision) return false;
    this.values.set(key, { value: structuredClone(value), revision: String(++this.revision) });
    return true;
  }

  async latest(channelId: string) { return this.read<{ requestId: string }>(`${channelId}/latest`); }
  async setLatest(channelId: string, requestId: string, revision: string | null) {
    return this.write(`${channelId}/latest`, { requestId }, revision);
  }
  async get(channelId: string, requestId: string) { return this.read<RefreshCommand>(`${channelId}/${requestId}`); }
  async put(channelId: string, command: RefreshCommand, revision: string | null) {
    return this.write(`${channelId}/${command.requestId}`, command, revision);
  }
  async delete(channelId: string, requestId: string) { this.values.delete(`${channelId}/${requestId}`); }
}

export class VercelBlobRefreshStore implements RefreshStore {
  constructor(private readonly token?: string) {}

  private credentials(): { token: string } | Record<string, never> {
    return this.token ? { token: this.token } : {};
  }

  private async read(path: string): Promise<Versioned<unknown> | null> {
    // Mutable command/status blobs must never be served from an older CDN copy.
    const result = await get(path, { access: "private", useCache: false, ...this.credentials() });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    try {
      return { value: JSON.parse(await new Response(result.stream).text()) as unknown, revision: result.blob.etag };
    } catch {
      return null;
    }
  }

  private async write(path: string, value: unknown, revision: string | null): Promise<boolean> {
    try {
      await put(path, JSON.stringify(value), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: revision !== null,
        ...(revision !== null ? { ifMatch: revision } : {}),
        contentType: "application/json",
        ttlDays: 1,
        ...this.credentials(),
      });
      return true;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) return false;
      // A concurrent initial create has no previous ETag. Only treat the error
      // as a conflict if the intended path now exists; provider failures propagate.
      if (revision === null && await this.read(path)) return false;
      throw error;
    }
  }

  async latest(channelId: string): Promise<Versioned<{ requestId: string }> | null> {
    const stored = await this.read(`refresh/${channelId}/latest.json`);
    if (!stored || !stored.value || typeof stored.value !== "object") return null;
    const value = stored.value as { requestId?: unknown };
    if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)) return null;
    return { value: { requestId: value.requestId }, revision: stored.revision };
  }

  async setLatest(channelId: string, requestId: string, revision: string | null): Promise<boolean> {
    return this.write(`refresh/${channelId}/latest.json`, { requestId }, revision);
  }

  async get(channelId: string, requestId: string): Promise<Versioned<RefreshCommand> | null> {
    const stored = await this.read(`refresh/${channelId}/${requestId}.json`);
    if (!stored || !isCommand(stored.value) || stored.value.requestId !== requestId) return null;
    return { value: stored.value, revision: stored.revision };
  }

  async put(channelId: string, command: RefreshCommand, revision: string | null): Promise<boolean> {
    return this.write(`refresh/${channelId}/${command.requestId}.json`, command, revision);
  }

  async delete(channelId: string, requestId: string): Promise<void> {
    await del(`refresh/${channelId}/${requestId}.json`, this.credentials());
  }
}

export function createVercelBlobRefreshStore(): RefreshStore {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    throw new Error("Private Vercel Blob is not connected.");
  }
  return new VercelBlobRefreshStore(process.env.BLOB_READ_WRITE_TOKEN);
}
