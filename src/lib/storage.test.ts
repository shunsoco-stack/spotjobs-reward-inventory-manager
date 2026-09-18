import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { createRewardSnapshot, defaultSettings } from "./core";
import { DATABASE_NAME, inspectBackup, loadData, MAX_BACKUP_BYTES, MAX_BACKUP_CHARS, parseBackup, saveData, serializeBackup, STORAGE_KEY, type AppData } from "./storage";

function fixture(): AppData {
  const settings = structuredClone(defaultSettings);
  return { version: 2, lastArea: "omitted", settings, records: [
    { id: "pickup-1", type: "pickup", quantity: 7, date: "2026-09-18", createdAt: "2026-09-18T00:00:00.000Z" },
    { id: "refill-1", type: "refill", quantity: 3, date: "2026-09-18", createdAt: "2026-09-18T01:00:00.000Z", area: "B", earlyMode: "manual", manualEarly: 2, note: "駅前の店舗", snapshot: createRewardSnapshot("2026-09-18", "B", settings, []) },
    { id: "stock-1", type: "adjustment", quantity: 0, date: "2026-09-18", createdAt: "2026-09-18T02:00:00.000Z", applied: false, expectedStock: 4, difference: -4 },
  ] };
}
function legacyFixture() {
  const records = fixture().records.map((entry) => { const { snapshot: _snapshot, applied: _applied, ...record } = entry as unknown as Record<string, unknown>; void _snapshot; void _applied; return record; });
  return { version: 1, lastArea: "B", settings: { regionRates: { A: 55, B: 65, C: 60, D: 70 }, thresholds: structuredClone(defaultSettings.thresholds), earlyDays: 3, earlyRate: 10, weeklyGoal: 10_000 }, records };
}
let memory: Map<string, string>;
beforeEach(() => {
  memory = new Map();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("versioned JSON backup", () => {
  it("exports an envelope with timestamp and restores exact snapshots and stocktakes", () => {
    const data = fixture();
    data.settings.regionRates.B = 900;
    data.settings.earlyDays = 20;
    data.settings.weekStartsOn = 0;
    const text = serializeBackup(data);
    expect(JSON.parse(text).format).toBe("spotjobs-backup");
    const inspected = inspectBackup(text);
    expect(inspected).toMatchObject({ recordCount: 3, startDate: "2026-09-18", endDate: "2026-09-18" });
    expect(inspected.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(inspected.data).toEqual(data);
    expect(parseBackup(`\uFEFF${text}`)).toEqual(data);
  });
  it("reports empty backup dates and accepts the legacy bare-data representation", () => {
    const data = fixture(); data.records = [];
    expect(inspectBackup(JSON.stringify(data))).toMatchObject({ exportedAt: null, recordCount: 0, startDate: null, endDate: null });
  });
  it("strips unknown fields and does not copy prototype properties", () => {
    const data = fixture();
    const raw = JSON.stringify({ ...data, extra: "ignored", settings: { ...data.settings, extra: true }, records: data.records.map((record) => ({ ...record, ignored: "value" })) });
    expect(parseBackup(raw)).toEqual(data);
    expect(parseBackup(raw.replace('"version":2', '"version":2,"__proto__":{"polluted":true}'))).toEqual(data);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
  it("rejects invalid envelopes, versions and missing snapshots", () => {
    for (const text of ["{broken", "null", "[]", "{}", JSON.stringify({ ...fixture(), version: 3 }), JSON.stringify({ format: "unknown", data: fixture() }), JSON.stringify({ format: "spotjobs-backup", exportedAt: "yesterday", data: fixture() })]) expect(() => parseBackup(text)).toThrow();
    const data = fixture();
    if (data.records[1].type === "refill") delete data.records[1].snapshot;
    expect(() => serializeBackup(data)).toThrow("報酬条件");
  });
  it("validates snapshot-specific fields without repricing them", () => {
    for (const change of [{ regionRate: -1 }, { earlyRate: 0.5 }, { earlyDays: 0 }, { weekStart: "2026-09-01" }, { thresholds: [{ count: 1, rate: 0 }, { count: 0, rate: 1 }] }]) {
      const data = fixture();
      if (data.records[1].type === "refill") Object.assign(data.records[1].snapshot!, change);
      expect(() => serializeBackup(data)).toThrow();
    }
  });
  it("rejects invalid calendar dates and timestamps that normalize outside the supported years", () => {
    for (const date of ["2026-02-29", "2024-02-30", "2026-04-31", "0000-01-01", "2026-9-18"]) { const data = fixture(); data.records[0].date = date; expect(() => serializeBackup(data)).toThrow("作業日"); }
    for (const createdAt of ["today", "2026-02-30T00:00:00Z", "2026-09-18T24:00:00Z", "2026-09-18T12:60:00Z", "0001-01-01T00:00:00+23:00", "9999-12-31T23:00:00-23:00"]) { const data = fixture(); data.records[0].createdAt = createdAt; expect(() => serializeBackup(data)).toThrow("登録日時"); }
    const data = fixture(); data.records[0].createdAt = "2026-09-18T09:00:00+09:00";
    expect(parseBackup(serializeBackup(data)).records[0].createdAt).toBe("2026-09-18T00:00:00.000Z");
  });
  it("rejects duplicate IDs and excessive record counts", () => {
    const data = fixture(); data.records[1].id = data.records[0].id;
    expect(() => serializeBackup(data)).toThrow("重複");
    data.records = Array.from({ length: 20_001 }, (_, index) => ({ ...data.records[0], id: `record-${index}` }));
    expect(() => serializeBackup(data)).toThrow("20,000");
  });
  it("checks record quantities, early counts, notes and stocktake consistency", () => {
    for (const change of [{ quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { quantity: 100_000 }, { manualEarly: 4 }, { area: "E" }, { note: "x".repeat(2_001) }]) { const data = fixture(); Object.assign(data.records[1], change); expect(() => serializeBackup(data)).toThrow(); }
    const data = fixture(); Object.assign(data.records[2], { expectedStock: -4, difference: 4 });
    expect(parseBackup(serializeBackup(data)).records[2]).toMatchObject({ expectedStock: -4, difference: 4, applied: false });
    Object.assign(data.records[2], { difference: 3 }); expect(() => serializeBackup(data)).toThrow("差分");
  });
  it("validates all settings, integer yen amounts, display options and goal bounds", () => {
    for (const change of [{ weeklyGoal: 0 }, { weeklyGoal: Number.MIN_VALUE }, { weeklyGoal: 1.5 }, { weeklyGoal: Number.MAX_SAFE_INTEGER + 1 }, { earlyRate: Infinity }, { earlyRate: 0.5 }, { earlyDays: 0 }, { weekStartsOn: 7 }, { theme: "midnight" }, { defaultArea: "unknown" }, { regionNames: {} }, { thresholds: [{ count: 20, rate: 5 }, { count: 20, rate: 10 }] }]) { const data = fixture(); Object.assign(data.settings, change); expect(() => serializeBackup(data)).toThrow(); }
  });
  it("requires zero-based, strictly ordered tiers with nondecreasing rates in all backup versions and snapshots", () => {
    const invalidTiers = [[], [{ count: 20, rate: 5 }], [{ count: 0, rate: 10 }, { count: 20, rate: 5 }]];
    for (const thresholds of invalidTiers) {
      const current = fixture(); current.settings.thresholds = thresholds;
      expect(() => serializeBackup(current)).toThrow("本数ボーナス");
      const legacy = legacyFixture(); legacy.settings.thresholds = thresholds;
      expect(() => parseBackup(JSON.stringify(legacy))).toThrow("本数ボーナス");
      const snapshotData = fixture();
      if (snapshotData.records[1].type === "refill") snapshotData.records[1].snapshot!.thresholds = thresholds;
      expect(() => serializeBackup(snapshotData)).toThrow("本数ボーナス");
    }
    const equalRates = fixture(); equalRates.settings.thresholds = [{ count: 0, rate: 0 }, { count: 20, rate: 0 }];
    expect(parseBackup(serializeBackup(equalRates)).settings.thresholds).toEqual(equalRates.settings.thresholds);
  });
  it("restores Japanese backups larger than the former character and byte limits", () => {
    const data = fixture(), note = "あ".repeat(2_000);
    data.records = Array.from({ length: 15_000 }, (_, index) => ({ ...data.records[0], id: `record-${index}`, note }));
    const text = serializeBackup(data);
    expect(text.length).toBeGreaterThan(30_000_000);
    expect(text.length).toBeLessThanOrEqual(MAX_BACKUP_CHARS);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_BACKUP_BYTES);
    const restored = parseBackup(text);
    expect(restored.records).toHaveLength(15_000);
    expect(restored.records[14_999]).toEqual(data.records[14_999]);
  });
  it("rejects oversized import and export before creating unrestorable backups", () => {
    expect(() => parseBackup(" ".repeat(MAX_BACKUP_CHARS + 1))).toThrow("ファイルが大きすぎます");
    const data = fixture(), note = "\u0000".repeat(2_000);
    data.records = Array.from({ length: 5_000 }, (_, index) => ({ ...data.records[0], id: `record-${index}`, note }));
    expect(() => serializeBackup(data)).toThrow("ファイルが大きすぎます");
  });
});

describe("IndexedDB and v1 migration", () => {
  it("returns null for an empty database and persists a complete asynchronous transaction", async () => {
    expect(await loadData()).toBeNull();
    await saveData(fixture());
    expect(await loadData()).toEqual(fixture());
    expect(memory.size).toBe(0);
  });
  it("migrates legacy settings without swapping B/C or repricing old records", async () => {
    const original = JSON.stringify(legacyFixture()); memory.set(STORAGE_KEY, original);
    const migrated = (await loadData())!;
    expect(migrated.version).toBe(2);
    expect(migrated.settings.regionRates).toEqual({ A: 55, B: 65, C: 60, D: 70, omitted: 55 });
    expect(migrated.records[1]).toMatchObject({ snapshot: { regionRate: 65, earlyRate: 10, earlyDays: 3, weekStart: "2026-09-14" } });
    expect(migrated.records[2]).toMatchObject({ applied: true });
    expect(memory.get(STORAGE_KEY)).toBe(original);
    migrated.settings.regionRates.B = 500;
    await saveData(migrated);
    const reloaded = (await loadData())!;
    expect(reloaded.settings.regionRates.B).toBe(500);
    expect(reloaded.records[1]).toMatchObject({ snapshot: { regionRate: 65 } });
  });
  it("migrates v1 JSON imports through the same safe conversion", () => {
    const migrated = parseBackup(JSON.stringify(legacyFixture()));
    expect(migrated.records[1]).toMatchObject({ snapshot: { regionRate: 65 } });
    expect(migrated.records[2]).toMatchObject({ applied: true });
    expect(parseBackup(serializeBackup(migrated))).toEqual(migrated);
  });
  it("preserves corrupt legacy data and surfaces missing database access", async () => {
    memory.set(STORAGE_KEY, "{corrupted");
    await expect(loadData()).rejects.toThrow("JSON");
    expect(memory.get(STORAGE_KEY)).toBe("{corrupted");
    vi.stubGlobal("indexedDB", undefined);
    await expect(loadData()).rejects.toThrow("IndexedDB");
    await expect(saveData(fixture())).rejects.toThrow("IndexedDB");
  });
  it("does not resolve before commit or fall back to localStorage after a transaction abort", async () => {
    const originalLegacy = JSON.stringify(legacyFixture()); memory.set(STORAGE_KEY, originalLegacy);
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, value, key);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(loadData()).rejects.toThrow();
    expect(memory.get(STORAGE_KEY)).toBe(originalLegacy);
    put.mockRestore();
    expect((await loadData())!.version).toBe(2);
  });
  it("retains the last saved data when a subsequent write aborts", async () => {
    await saveData(fixture());
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, value, key); request.addEventListener("success", () => this.transaction.abort()); return request;
    });
    const changed = fixture(); changed.records = [];
    await expect(saveData(changed)).rejects.toThrow(); put.mockRestore();
    expect(await loadData()).toEqual(fixture());
  });
  it("compares the expected version atomically and never overwrites another tab's update", async () => {
    const original = fixture();
    await saveData(original, { expected: null });
    const first = structuredClone(original), second = structuredClone(original);
    first.settings.weeklyGoal = 15_000;
    second.settings.weeklyGoal = 20_000;
    const results = await Promise.allSettled([saveData(first, { expected: original }), saveData(second, { expected: original })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected");
    expect(failed?.status === "rejected" && String(failed.reason)).toContain("別のタブ");
    const current = (await loadData())!;
    expect([15_000, 20_000]).toContain(current.settings.weeklyGoal);
    await expect(saveData(original, { expected: null })).rejects.toThrow("別のタブ");
    expect(await loadData()).toEqual(current);
    await saveData(original, { expected: current });
    expect(await loadData()).toEqual(original);
  });
  it("surfaces an invalid IndexedDB document rather than resurrecting stale legacy records", async () => {
    await saveData(fixture()); memory.set(STORAGE_KEY, JSON.stringify(legacyFixture()));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result, tx = db.transaction("app", "readwrite"); tx.objectStore("app").put({ version: 999 }, "current"); tx.oncomplete = () => { db.close(); resolve(); }; };
    });
    await expect(loadData()).rejects.toThrow("バージョン");
  });
});
