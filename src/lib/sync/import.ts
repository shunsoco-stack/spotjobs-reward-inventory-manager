import { createRewardSnapshot, type WorkRecord } from "../core";
import { MAX_RECORDS, type AppData, type AppSyncMetadata, type SpotJobsRecordSource } from "../storage";

export type SpotJobsWorkType = "BATTERY_INSERT" | "BATTERY_EJECT" | "BL_BATTERY_EJECT";

export interface SpotJobsSyncRecord {
  externalId: string;
  completedAt: string;
  workType: SpotJobsWorkType;
  quantity: number;
  storeName: string;
  estimatedReward?: number;
  earlyRefill: boolean | null;
}

export interface SpotJobsSyncSnapshot {
  version: 1;
  collectedAt: string;
  sourceVersion: "spotlog-edge/0.1.0" | "spotlog-edge/0.2.0" | "spotlog-edge/0.2.1";
  records: SpotJobsSyncRecord[];
}

export interface SyncMergeResult {
  data: AppData;
  imported: number;
  duplicates: number;
  ignored: number;
  needsReview: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}の形式が正しくありません。`);
  return value as Record<string, unknown>;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new Error(`${label}が正しくありません。`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label}が正しくありません。`);
  return new Date(time).toISOString();
}

/** Validates decrypted, untrusted collector data before it reaches IndexedDB. */
export function validateSpotJobsSnapshot(value: unknown): SpotJobsSyncSnapshot {
  const snapshot = object(value, "同期履歴");
  if (snapshot.version !== 1) throw new Error("対応していない同期履歴です。");
  const collectedAt = timestamp(snapshot.collectedAt, "取得日時");
  const sourceVersion = snapshot.sourceVersion;
  if (sourceVersion !== "spotlog-edge/0.1.0" && sourceVersion !== "spotlog-edge/0.2.0" && sourceVersion !== "spotlog-edge/0.2.1") throw new Error("対応していない収集ツールの同期履歴です。");
  if (!Array.isArray(snapshot.records) || snapshot.records.length > MAX_RECORDS) throw new Error(`同期履歴は${MAX_RECORDS.toLocaleString("ja-JP")}件以内にしてください。`);
  const externalIds = new Set<string>();
  const records = snapshot.records.map((entry, index): SpotJobsSyncRecord => {
    const record = object(entry, `${index + 1}件目の同期履歴`);
    if (typeof record.externalId !== "string" || !record.externalId.trim() || record.externalId.length > 190 || externalIds.has(record.externalId)) throw new Error(`${index + 1}件目のジョブIDが未設定、重複、または長すぎます。`);
    externalIds.add(record.externalId);
    if (record.workType !== "BATTERY_INSERT" && record.workType !== "BATTERY_EJECT" && record.workType !== "BL_BATTERY_EJECT") throw new Error(`${index + 1}件目の作業種別が正しくありません。`);
    if (typeof record.quantity !== "number" || !Number.isSafeInteger(record.quantity) || record.quantity < 1 || record.quantity > 99_999) throw new Error(`${index + 1}件目の本数が正しくありません。`);
    if (typeof record.storeName !== "string" || record.storeName.length > 500) throw new Error(`${index + 1}件目の店舗名は500文字以内にしてください。`);
    if (record.estimatedReward !== undefined && (typeof record.estimatedReward !== "number" || !Number.isSafeInteger(record.estimatedReward) || record.estimatedReward < 0 || record.estimatedReward > Number.MAX_SAFE_INTEGER)) throw new Error(`${index + 1}件目の概算報酬が正しくありません。`);
    if (record.earlyRefill !== null && typeof record.earlyRefill !== "boolean") throw new Error(`${index + 1}件目の早期補充情報が正しくありません。`);
    return {
      externalId: record.externalId, workType: record.workType,
      completedAt: timestamp(record.completedAt, `${index + 1}件目の完了日時`),
      quantity: record.quantity, storeName: record.storeName,
      ...(record.estimatedReward === undefined ? {} : { estimatedReward: record.estimatedReward }),
      earlyRefill: record.earlyRefill,
    } as SpotJobsSyncRecord;
  });
  return { version: 1, collectedAt, sourceVersion, records };
}

function japanDate(timestampValue: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(timestampValue));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(entry => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function recordType(workType: SpotJobsWorkType): "pickup" | "refill" {
  return workType === "BATTERY_INSERT" ? "refill" : "pickup";
}

function sameCompletion(record: WorkRecord, incoming: SpotJobsSyncRecord): boolean {
  if (!record.id.startsWith("jobshot:") || record.type === "adjustment" || record.type !== recordType(incoming.workType)) return false;
  return record.quantity === incoming.quantity && Date.parse(record.createdAt) === Date.parse(incoming.completedAt);
}

function metadata(data: AppData): AppSyncMetadata {
  return data.sync ? structuredClone(data.sync) : { recordSources: [], ignoredExternalIds: [] };
}

function sourceFor(recordId: string, incoming: SpotJobsSyncRecord, syncedAt: string, needsReview: boolean): SpotJobsRecordSource {
  return {
    provider: "spotjobs", externalId: incoming.externalId, recordId,
    completedAt: incoming.completedAt, syncedAt, storeName: incoming.storeName,
    needsReview, ...(incoming.estimatedReward === undefined ? {} : { estimatedReward: incoming.estimatedReward }),
  };
}

/**
 * Merges oldest first so inventory FIFO and early-refill calculations stay stable.
 * Official estimated rewards remain metadata; app reward snapshots stay authoritative.
 */
export function mergeSpotJobsSnapshot(data: AppData, snapshotValue: unknown, syncedAt = new Date().toISOString()): SyncMergeResult {
  const snapshot = validateSpotJobsSnapshot(snapshotValue);
  const normalizedSyncedAt = timestamp(syncedAt, "同期日時");
  const sync = metadata(data);
  const records = [...data.records];
  const ignoredIds = new Set(sync.ignoredExternalIds);
  const sourceIds = new Set(sync.recordSources.map(source => source.externalId));
  const mappedRecordIds = new Set(sync.recordSources.map(source => source.recordId));
  const recordIds = new Set(records.map(record => record.id));
  let imported = 0;
  let duplicates = 0;
  let ignored = 0;
  let needsReview = 0;

  const incomingRecords = [...snapshot.records].sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.externalId.localeCompare(b.externalId));
  for (const incoming of incomingRecords) {
    if (ignoredIds.has(incoming.externalId)) { ignored++; continue; }
    if (sourceIds.has(incoming.externalId)) { duplicates++; continue; }
    const type = recordType(incoming.workType);
    const expectedId = `spotjobs:${incoming.externalId}`;
    const existing = records.find(record => !mappedRecordIds.has(record.id) && (record.id === expectedId || sameCompletion(record, incoming)));
    if (existing) {
      const review = type === "refill";
      sync.recordSources.push(sourceFor(existing.id, incoming, normalizedSyncedAt, review));
      sourceIds.add(incoming.externalId);
      mappedRecordIds.add(existing.id);
      duplicates++;
      if (review) needsReview++;
      continue;
    }
    if (records.length >= MAX_RECORDS) throw new Error(`取込後の記録が${MAX_RECORDS.toLocaleString("ja-JP")}件を超えます。`);
    if (recordIds.has(expectedId)) { duplicates++; continue; }
    const date = japanDate(incoming.completedAt);
    const storeName = incoming.storeName.trim();
    const base = {
      id: expectedId, date, quantity: incoming.quantity, createdAt: incoming.completedAt,
      ...(storeName ? { note: `自動同期 · ${storeName}` } : { note: "自動同期" }),
    };
    let record: WorkRecord;
    let review = false;
    if (type === "pickup") record = { ...base, type };
    else {
      review = true;
      const area = data.settings.defaultArea;
      const earlyMode = typeof incoming.earlyRefill === "boolean" ? "manual" as const : "auto" as const;
      record = {
        ...base, type, area, earlyMode,
        ...(earlyMode === "manual" ? { manualEarly: incoming.earlyRefill ? incoming.quantity : 0 } : {}),
        snapshot: createRewardSnapshot(date, area, data.settings, records),
      };
    }
    records.push(record);
    recordIds.add(record.id);
    sync.recordSources.push(sourceFor(record.id, incoming, normalizedSyncedAt, review));
    sourceIds.add(incoming.externalId);
    mappedRecordIds.add(record.id);
    imported++;
    if (review) needsReview++;
  }
  sync.lastSyncedAt = normalizedSyncedAt;
  return { data: { ...data, records, sync }, imported, duplicates, ignored, needsReview };
}

/** Removes a record and remembers every linked official ID so it cannot reappear on the next pull. */
export function removeRecordWithSyncTombstone(data: AppData, recordId: string): AppData {
  const linked = data.sync?.recordSources.filter(source => source.recordId === recordId) ?? [];
  if (!linked.length) return { ...data, records: data.records.filter(record => record.id !== recordId) };
  const ignored = new Set(data.sync?.ignoredExternalIds ?? []);
  for (const source of linked) ignored.add(source.externalId);
  return {
    ...data,
    records: data.records.filter(record => record.id !== recordId),
    sync: {
      recordSources: (data.sync?.recordSources ?? []).filter(source => source.recordId !== recordId),
      ignoredExternalIds: [...ignored],
      ...(data.sync?.lastSyncedAt ? { lastSyncedAt: data.sync.lastSyncedAt } : {}),
    },
  };
}

/** Allows the UI to suppress a known external job before or without creating a local record. */
export function ignoreExternalSpotJobsRecord(data: AppData, externalId: string): AppData {
  if (!externalId.trim() || externalId.length > 190) throw new Error("ジョブIDを確認してください。");
  const sync = metadata(data);
  if (!sync.ignoredExternalIds.includes(externalId)) sync.ignoredExternalIds.push(externalId);
  sync.recordSources = sync.recordSources.filter(source => source.externalId !== externalId);
  return { ...data, sync };
}

/** Clears the review marker after the user confirms region/early-refill values. */
export function markSyncedRecordReviewed(data: AppData, recordId: string): AppData {
  if (!data.sync?.recordSources.some(source => source.recordId === recordId && source.needsReview)) return data;
  return {
    ...data,
    sync: {
      ...data.sync,
      recordSources: data.sync.recordSources.map(source => source.recordId === recordId ? { ...source, needsReview: false } : source),
    },
  };
}
