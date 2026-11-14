import { describe, expect, it } from "vitest";
import { calculate, defaultSettings, weekStartFor } from "../core";
import { parseBackup, serializeBackup, type AppData } from "../storage";
import {
  markSyncedRecordReviewed, mergeSpotJobsSnapshot, removeRecordWithSyncTombstone,
  validateSpotJobsSnapshot, type SpotJobsSyncRecord, type SpotJobsSyncSnapshot,
} from "./import";

function emptyData(): AppData {
  return { version: 2, records: [], settings: structuredClone(defaultSettings), lastArea: "omitted" };
}

function snapshot(records: SpotJobsSyncRecord[]): SpotJobsSyncSnapshot {
  return { version: 1, collectedAt: "2026-11-13T03:00:00.000Z", sourceVersion: "spotlog-edge/0.1.0", records };
}

const pickup: SpotJobsSyncRecord = {
  externalId: "pickup-1", workType: "BATTERY_EJECT", completedAt: "2026-11-12T15:10:00.000Z",
  quantity: 5, storeName: "駅前店", estimatedReward: 0, earlyRefill: null,
};
const refill: SpotJobsSyncRecord = {
  externalId: "refill-1", workType: "BATTERY_INSERT", completedAt: "2026-11-12T16:20:00.000Z",
  quantity: 3, storeName: "中央店", estimatedReward: 999, earlyRefill: true,
};

describe("SPOTJOBS snapshot import", () => {
  it.each(["spotlog-edge/0.1.0", "spotlog-edge/0.2.0", "spotlog-edge/0.2.1"] as const)("imports and preserves supported collector version %s", sourceVersion => {
    const incoming = { ...snapshot([pickup, refill]), sourceVersion };
    expect(validateSpotJobsSnapshot(incoming).sourceVersion).toBe(sourceVersion);
    const result = mergeSpotJobsSnapshot(emptyData(), incoming, "2026-11-13T04:00:00.000Z");
    expect(result.imported).toBe(2);
    expect(result.data.records.map(record => record.type)).toEqual(["pickup", "refill"]);
  });

  it("imports oldest-first, uses Tokyo civil dates, and keeps official rewards as metadata", () => {
    const result = mergeSpotJobsSnapshot(emptyData(), snapshot([refill, pickup]), "2026-11-13T04:00:00.000Z");
    expect(result).toMatchObject({ imported: 2, duplicates: 0, ignored: 0, needsReview: 1 });
    expect(result.data.records.map(record => record.id)).toEqual(["spotjobs:pickup-1", "spotjobs:refill-1"]);
    expect(result.data.records[0]).toMatchObject({ type: "pickup", date: "2026-11-13", quantity: 5, note: "自動同期 · 駅前店" });
    expect(result.data.records[1]).toMatchObject({ type: "refill", date: "2026-11-13", quantity: 3, area: "omitted", earlyMode: "manual", manualEarly: 3, note: "自動同期 · 中央店" });
    expect(result.data.sync?.recordSources[1]).toMatchObject({ estimatedReward: 999, storeName: "中央店", needsReview: true });

    const calculation = calculate(result.data.records, result.data.settings, weekStartFor("2026-11-13"), "2026-11-13");
    expect(calculation.base).toBe(3 * 55);
    expect(calculation.earlyBonus).toBe(3 * 10);
    expect(calculation.total).not.toBe(999);
  });

  it("deduplicates official IDs and an existing screenshot completion without reimporting", () => {
    const data = emptyData();
    data.records.push({
      id: "jobshot:2026-11-13T01:20:00:refill", type: "refill", date: "2026-11-13", quantity: 3,
      createdAt: refill.completedAt, area: "A", earlyMode: "manual", manualEarly: 3,
      snapshot: { regionRate: 55, earlyRate: 10, earlyDays: 3, weekStart: "2026-11-09", thresholds: structuredClone(defaultSettings.thresholds) },
    });
    const first = mergeSpotJobsSnapshot(data, snapshot([refill]), "2026-11-13T04:00:00.000Z");
    expect(first).toMatchObject({ imported: 0, duplicates: 1, needsReview: 1 });
    expect(first.data.records).toHaveLength(1);
    expect(first.data.sync?.recordSources[0]).toMatchObject({ externalId: "refill-1", recordId: data.records[0].id });
    const second = mergeSpotJobsSnapshot(first.data, snapshot([refill]), "2026-11-13T05:00:00.000Z");
    expect(second).toMatchObject({ imported: 0, duplicates: 1, needsReview: 0 });
    expect(second.data.sync?.recordSources).toHaveLength(1);
  });

  it("maps at most one official job to one screenshot record", () => {
    const data = emptyData();
    data.records.push({
      id: "jobshot:2026-11-13T01:20:00:refill", type: "refill", date: "2026-11-13", quantity: 3,
      createdAt: refill.completedAt, area: "A", earlyMode: "manual", manualEarly: 3,
      snapshot: { regionRate: 55, earlyRate: 10, earlyDays: 3, weekStart: "2026-11-09", thresholds: structuredClone(defaultSettings.thresholds) },
    });
    const second = { ...refill, externalId: "refill-2", storeName: "別店舗" };
    const result = mergeSpotJobsSnapshot(data, snapshot([refill, second]), "2026-11-13T04:00:00.000Z");
    expect(result).toMatchObject({ imported: 1, duplicates: 1 });
    expect(result.data.records).toHaveLength(2);
    expect(new Set(result.data.sync?.recordSources.map(source => source.recordId)).size).toBe(2);
  });

  it("creates tombstones on delete and lets edits clear the review marker", () => {
    const imported = mergeSpotJobsSnapshot(emptyData(), snapshot([refill]), "2026-11-13T04:00:00.000Z").data;
    const reviewed = markSyncedRecordReviewed(imported, "spotjobs:refill-1");
    expect(reviewed.sync?.recordSources[0].needsReview).toBe(false);
    const removed = removeRecordWithSyncTombstone(reviewed, "spotjobs:refill-1");
    expect(removed.records).toHaveLength(0);
    expect(removed.sync?.recordSources).toHaveLength(0);
    expect(removed.sync?.ignoredExternalIds).toEqual(["refill-1"]);
    const resynced = mergeSpotJobsSnapshot(removed, snapshot([refill]), "2026-11-13T06:00:00.000Z");
    expect(resynced).toMatchObject({ imported: 0, duplicates: 0, ignored: 1 });
    expect(resynced.data.records).toHaveLength(0);
  });

  it("preserves validated source metadata in JSON backups without storing a pairing code", () => {
    const imported = mergeSpotJobsSnapshot(emptyData(), snapshot([pickup, refill]), "2026-11-13T04:00:00.000Z").data;
    const text = serializeBackup(imported);
    expect(text).not.toContain("syncCode");
    expect(parseBackup(text)).toEqual(imported);
  });

  it("strictly rejects unsupported types, missing early state, duplicate IDs, and oversized values", () => {
    expect(() => validateSpotJobsSnapshot({ ...snapshot([pickup]), sourceVersion: "future" })).toThrow("収集ツール");
    expect(() => validateSpotJobsSnapshot({ ...snapshot([pickup]), sourceVersion: "spotlog-edge/0.3.0" })).toThrow("収集ツール");
    expect(() => validateSpotJobsSnapshot(snapshot([{ ...pickup, earlyRefill: undefined } as unknown as SpotJobsSyncRecord]))).toThrow("早期補充");
    expect(() => validateSpotJobsSnapshot(snapshot([pickup, pickup]))).toThrow("重複");
    expect(() => validateSpotJobsSnapshot(snapshot([{ ...pickup, quantity: 100_000 }]))).toThrow("本数");
    expect(() => validateSpotJobsSnapshot(snapshot([{ ...pickup, workType: "OTHER" as SpotJobsSyncRecord["workType"] }]))).toThrow("作業種別");
  });
});
