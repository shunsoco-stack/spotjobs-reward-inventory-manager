import { parseSyncCode } from "./protocol";

export const DEFAULT_SYNC_BRIDGE_URL = "https://spotjobs-reward-inventory-sync.vercel.app";
export const SYNC_PREFERENCES_KEY = "spotlog-sync-preferences-v1";

export interface SyncLocalPreferences {
  enabled: boolean;
  syncCode?: string;
  /** Existing-data safety cutoff. Records completed before this instant are not auto-imported. */
  importAfter?: string;
  lastStatus?: "success" | "error";
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastCollectedAt?: string;
  lastMessage?: string;
}

const emptyPreferences = (): SyncLocalPreferences => ({ enabled: false });

function iso(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return;
  return new Date(value).toISOString();
}

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}

/**
 * The pairing code intentionally stays out of AppData/JSON backups. It is stored
 * only in this browser/WebView. Native Keychain/Keystore migration is a future hardening step.
 */
export function loadSyncPreferences(): SyncLocalPreferences {
  const target = storage();
  if (!target) return emptyPreferences();
  let value: unknown;
  try {
    const raw = target.getItem(SYNC_PREFERENCES_KEY);
    if (!raw) return emptyPreferences();
    value = JSON.parse(raw);
  } catch { return emptyPreferences(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyPreferences();
  const saved = value as Record<string, unknown>;
  const result: SyncLocalPreferences = { enabled: saved.enabled === true };
  if (typeof saved.syncCode === "string") {
    try { parseSyncCode(saved.syncCode); result.syncCode = saved.syncCode.trim(); }
    catch { /* Ignore a corrupt local pairing code instead of exposing it. */ }
  }
  if (saved.lastStatus === "success" || saved.lastStatus === "error") result.lastStatus = saved.lastStatus;
  const importAfter = iso(saved.importAfter);
  const lastAttemptAt = iso(saved.lastAttemptAt);
  const lastSuccessAt = iso(saved.lastSuccessAt);
  const lastCollectedAt = iso(saved.lastCollectedAt);
  if (importAfter) result.importAfter = importAfter;
  if (lastAttemptAt) result.lastAttemptAt = lastAttemptAt;
  if (lastSuccessAt) result.lastSuccessAt = lastSuccessAt;
  if (lastCollectedAt) result.lastCollectedAt = lastCollectedAt;
  if (typeof saved.lastMessage === "string" && saved.lastMessage.length <= 500) result.lastMessage = saved.lastMessage;
  if (!result.syncCode) result.enabled = false;
  return result;
}

export function saveSyncPreferences(value: SyncLocalPreferences): SyncLocalPreferences {
  const next: SyncLocalPreferences = { enabled: value.enabled === true };
  if (value.syncCode) {
    parseSyncCode(value.syncCode);
    next.syncCode = value.syncCode.trim();
  }
  if (next.enabled && !next.syncCode) throw new Error("自動同期を有効にするには同期コードを設定してください。");
  if (value.lastStatus === "success" || value.lastStatus === "error") next.lastStatus = value.lastStatus;
  const importAfter = iso(value.importAfter);
  const lastAttemptAt = iso(value.lastAttemptAt);
  const lastSuccessAt = iso(value.lastSuccessAt);
  const lastCollectedAt = iso(value.lastCollectedAt);
  if (importAfter) next.importAfter = importAfter;
  if (lastAttemptAt) next.lastAttemptAt = lastAttemptAt;
  if (lastSuccessAt) next.lastSuccessAt = lastSuccessAt;
  if (lastCollectedAt) next.lastCollectedAt = lastCollectedAt;
  if (value.lastMessage !== undefined) {
    if (typeof value.lastMessage !== "string" || value.lastMessage.length > 500) throw new Error("同期状態のメッセージが長すぎます。");
    next.lastMessage = value.lastMessage;
  }
  const target = storage();
  if (!target) throw new Error("この端末では同期設定を保存できません。");
  target.setItem(SYNC_PREFERENCES_KEY, JSON.stringify(next));
  return next;
}

export function updateSyncPreferences(patch: Partial<SyncLocalPreferences>): SyncLocalPreferences {
  return saveSyncPreferences({ ...loadSyncPreferences(), ...patch });
}

export function clearSyncPreferences(): void {
  storage()?.removeItem(SYNC_PREFERENCES_KEY);
}

export function resolveSyncBridgeUrl(localOverride?: string): string {
  if (!localOverride) return DEFAULT_SYNC_BRIDGE_URL;
  let url: URL;
  try { url = new URL(localOverride); }
  catch { throw new Error("同期ブリッジURLが正しくありません。"); }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!local || (url.protocol !== "http:" && url.protocol !== "https:")) throw new Error("同期ブリッジの上書きはローカル開発時だけ利用できます。");
  return url.toString().replace(/\/$/, "");
}
