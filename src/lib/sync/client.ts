import type { AppData } from "../storage";
import { mergeSpotJobsSnapshot, validateSpotJobsSnapshot, type SpotJobsSyncSnapshot, type SyncMergeResult } from "./import";
import { decryptSyncSnapshot, deriveSyncCredentials, validateEncryptedEnvelope } from "./protocol";
import { resolveSyncBridgeUrl } from "./preferences";

export interface PullSyncOptions {
  syncCode: string;
  /** Imports only jobs completed at or after this instant. Used to protect existing manual history. */
  importAfter?: string;
  bridgeUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Server request time: reject a snapshot uploaded before a requested PC refresh. */
  minimumStoredAt?: string;
}

export interface PulledSpotJobsSnapshot {
  snapshot: SpotJobsSyncSnapshot;
  channelId: string;
  storedAt: string;
  expiresAt: string;
}

export type DeleteSyncOptions = PullSyncOptions;

export interface SyncFromBridgeResult extends SyncMergeResult {
  channelId: string;
  collectedAt: string;
  storedAt: string;
  expiresAt: string;
}

export class SyncBridgeError extends Error {
  constructor(message: string, public readonly code: "not-found" | "unauthorized" | "rate-limited" | "unavailable" | "invalid-response") {
    super(message);
    this.name = "SyncBridgeError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyncBridgeError("同期ブリッジから不正な応答が返されました。", "invalid-response");
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new SyncBridgeError("同期ブリッジの日時情報が正しくありません。", "invalid-response");
  return new Date(value).toISOString();
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 1_500_000) throw new SyncBridgeError("同期ブリッジの応答が大きすぎます。", "invalid-response");
  try { return JSON.parse(text); }
  catch { throw new SyncBridgeError("同期ブリッジの応答を読み取れません。", "invalid-response"); }
}

export async function pullSpotJobsSnapshot(options: PullSyncOptions): Promise<PulledSpotJobsSnapshot> {
  const credentials = await deriveSyncCredentials(options.syncCode);
  const bridgeUrl = resolveSyncBridgeUrl(options.bridgeUrl);
  const request = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await request(`${bridgeUrl}/api/v1/snapshot/${encodeURIComponent(credentials.channelId)}`, {
      method: "GET", cache: "no-store", signal: options.signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${credentials.bearerToken}` },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new SyncBridgeError("同期ブリッジへ接続できません。通信状態を確認してください。", "unavailable");
  }
  if (response.status === 404) throw new SyncBridgeError("PCから同期された履歴がまだありません。Edge拡張機能で「今すぐ同期」を実行してください。", "not-found");
  if (response.status === 401 || response.status === 403) throw new SyncBridgeError("同期コードを確認してください。", "unauthorized");
  if (response.status === 429) throw new SyncBridgeError("同期回数が多いため、少し待ってから再試行してください。", "rate-limited");
  if (!response.ok) throw new SyncBridgeError("同期ブリッジで一時的な問題が発生しました。", "unavailable");

  const wrapper = object(await responseJson(response));
  const envelope = validateEncryptedEnvelope(wrapper.envelope);
  const storedAt = timestamp(wrapper.storedAt);
  if (options.minimumStoredAt && (!Number.isFinite(Date.parse(options.minimumStoredAt)) || Date.parse(storedAt) < Date.parse(options.minimumStoredAt))) {
    throw new SyncBridgeError("PCが取得した最新履歴がまだ届いていません。少し待ってもう一度同期してください。", "unavailable");
  }
  const expiresAt = timestamp(wrapper.expiresAt);
  const snapshot = validateSpotJobsSnapshot(await decryptSyncSnapshot(envelope, credentials));
  if (snapshot.records.length !== envelope.recordCount || snapshot.collectedAt !== envelope.collectedAt) {
    throw new SyncBridgeError("同期履歴の件数または取得日時が一致しません。", "invalid-response");
  }
  return { snapshot, channelId: credentials.channelId, storedAt, expiresAt };
}

export async function syncFromBridge(data: AppData, options: PullSyncOptions): Promise<SyncFromBridgeResult> {
  const pulled = await pullSpotJobsSnapshot(options);
  let snapshot = pulled.snapshot;
  if (options.importAfter) {
    const cutoff = Date.parse(options.importAfter);
    if (!Number.isFinite(cutoff)) throw new Error("自動取り込みの開始日時が正しくありません。");
    snapshot = {
      ...snapshot,
      records: snapshot.records.filter(record => Date.parse(record.completedAt) >= cutoff),
    };
  }
  const merged = mergeSpotJobsSnapshot(data, snapshot);
  return { ...merged, channelId: pulled.channelId, collectedAt: pulled.snapshot.collectedAt, storedAt: pulled.storedAt, expiresAt: pulled.expiresAt };
}

/** Deletes only the encrypted cloud snapshot. Local IndexedDB history is untouched. */
export async function deleteRemoteSpotJobsSnapshot(options: DeleteSyncOptions): Promise<void> {
  const credentials = await deriveSyncCredentials(options.syncCode);
  const bridgeUrl = resolveSyncBridgeUrl(options.bridgeUrl);
  const request = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await request(`${bridgeUrl}/api/v1/snapshot/${encodeURIComponent(credentials.channelId)}`, {
      method: "DELETE", cache: "no-store", signal: options.signal,
      headers: { Authorization: `Bearer ${credentials.bearerToken}` },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new SyncBridgeError("同期ブリッジへ接続できません。通信状態を確認してください。", "unavailable");
  }
  if (response.status === 404) return;
  if (response.status === 401 || response.status === 403) throw new SyncBridgeError("同期コードを確認してください。", "unauthorized");
  if (response.status === 429) throw new SyncBridgeError("同期回数が多いため、少し待ってから再試行してください。", "rate-limited");
  if (!response.ok) throw new SyncBridgeError("暗号化同期データを削除できませんでした。", "unavailable");
}
