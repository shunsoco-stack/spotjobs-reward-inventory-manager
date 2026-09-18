import { describe, expect, it } from "vitest";
import { createRewardSnapshot, defaultSettings, type WorkRecord } from "./core";
import { parseCsv, previewCsvImport, suggestCsvMapping } from "./csv";
import { exportCsv } from "./storage";

const settings = structuredClone(defaultSettings);
function sampleRecords(): WorkRecord[] {
  return [
    { id: "pickup-1", type: "pickup", date: "2026-09-14", quantity: 8, createdAt: "2026-09-14T00:00:00.000Z", note: "駅前,東口\r\n翌日補充" },
    { id: "=refill-id", type: "refill", date: "2026-09-15", quantity: 5, area: "omitted", earlyMode: "manual", manualEarly: 3, createdAt: "2026-09-15T00:00:00.000Z", note: '=SUM(1,2) "メモ"', snapshot: createRewardSnapshot("2026-09-15", "omitted", settings, []) },
    { id: "stocktake-1", type: "adjustment", date: "2026-09-16", quantity: 2, applied: false, expectedStock: -3, difference: 5, createdAt: "2026-09-16T00:00:00.000Z", note: "'=既存のアポストロフィ" },
  ];
}
describe("CSV parsing", () => {
  it("handles UTF-8 BOM, quoted commas, escaped quotes and multiline cells", () => {
    expect(parseCsv('\uFEFF日付,本数,メモ\r\n2026/9/14,5,"駅前,\"\"東口\"\"\r\n補充済み"\r\n')).toEqual({ headers: ["日付", "本数", "メモ"], rows: [["2026/9/14", "5", '駅前,"東口"\r\n補充済み']] });
  });
  it("supports spreadsheet tab and semicolon delimiters", () => {
    expect(parseCsv("日付\t本数\n2026/9/14\t3").rows[0]).toEqual(["2026/9/14", "3"]);
    expect(parseCsv("date;quantity\n2026-09-14;3").headers).toEqual(["date", "quantity"]);
  });
  it("rejects malformed quoting rather than guessing data boundaries", () => {
    for (const text of ['date,quantity\n"2026-09-14,3', 'date,quantity\n"2026-09-14"abc,3', 'date,quantity\n2026-09-"14,3', ""]) expect(() => parseCsv(text)).toThrow();
  });
  it("suggests Japanese and English column mappings", () => {
    expect(suggestCsvMapping(["メモ", "数量", "記録日", "作業", "早期対象本数", "地域"])).toEqual({ date: 2, quantity: 1, type: 3, area: 5, earlyCount: 4, note: 0 });
    expect(suggestCsvMapping(["something"])).toMatchObject({ date: -1, quantity: -1 });
  });
});
describe("spreadsheet import", () => {
  it("converts aliases, flexible full dates and omitted areas while snapshotting current conditions", () => {
    const text = "日付,作業,本数,エリア,早期対象本数,メモ\n2026/9/14,抜取,8,,,駅前\n2026年9月15日,補充,5,,3,補充済み\n2026-9-16,棚卸,2,,,確認のみ";
    const result = previewCsvImport(text, suggestCsvMapping(parseCsv(text).headers), settings, []);
    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(3);
    expect(result.records[1]).toMatchObject({ type: "refill", area: "omitted", date: "2026-09-15", earlyMode: "manual", manualEarly: 3, snapshot: { regionRate: 55, earlyRate: 10, earlyDays: 3 } });
    expect(result.records[2]).toMatchObject({ type: "adjustment", quantity: 2, applied: false });
  });
  it("uses explicit column mapping for differently named spreadsheet fields", () => {
    const result = previewCsvImport("台数,実施日,補充地域\n\"1,000\",2026/9/14,A", { quantity: 0, date: 1, area: 2 }, settings, []);
    expect(result.errors).toEqual([]);
    expect(result.records[0]).toMatchObject({ type: "refill", quantity: 1000, area: "A" });
  });
  it("uses the configured default area for blank columns but retains an explicitly omitted area", () => {
    const custom = structuredClone(settings); custom.defaultArea = "D";
    const text = "日付,本数,エリア\n2026-09-14,1,\n2026-09-14,1,省略";
    const result = previewCsvImport(text, { date: 0, quantity: 1, area: 2 }, custom, []);
    expect(result.errors).toEqual([]);
    expect(result.records[0]).toMatchObject({ area: "D", snapshot: { regionRate: 70 } });
    expect(result.records[1]).toMatchObject({ area: "omitted", snapshot: { regionRate: 55 } });
  });
  it("reports future dates for both general spreadsheets and full-fidelity app CSV files", () => {
    expect(previewCsvImport("日付,本数\n2999-01-01,1", { date: 0, quantity: 1 }, settings, []).errors[0].message).toContain("未来");
    const record: WorkRecord = { id: "future-pickup", type: "pickup", date: "2999-01-01", quantity: 1, createdAt: "2026-09-18T00:00:00.000Z" };
    const result = previewCsvImport(exportCsv([record], settings), { date: 0, quantity: 2 }, settings, []);
    expect(result.records).toEqual([]);
    expect(result.errors[0].message).toContain("未来");
  });
  it("reports row-specific errors and never turns invalid rows into records", () => {
    const text = "日付,本数,作業,エリア,早期対象本数\n9/14,3,補充,A,0\n2026-02-30,3,補充,A,0\n2026-09-14,-3,補充,A,0\n2026-09-14,3,補充,X,0\n2026-09-14,3,補充,A,4\n2026-09-14,3,unknown,A,0\n2026-09-14,3,補充,A\n2026-09-14,3,補充,A,1";
    const result = previewCsvImport(text, suggestCsvMapping(parseCsv(text).headers), settings, []);
    expect(result.errors.map((error) => error.row)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(result.records).toHaveLength(1);
  });
  it("requires mapped date and quantity columns and enforces merged record limits", () => {
    const text = "日付,本数\n2026-09-14,1";
    expect(previewCsvImport(text, { date: -1, quantity: 1 }, settings, []).errors[0].row).toBe(1);
    expect(previewCsvImport(text, { date: 0, quantity: 1 }, settings, Array.from({ length: 20_000 }, () => sampleRecords()[0])).errors[0].message).toContain("20,000");
  });
});
describe("full-fidelity CSV round trip", () => {
  it("preserves snapshots, stocktake status, IDs, literal apostrophes and notes exactly", () => {
    const records = sampleRecords();
    const csv = exportCsv(records, settings);
    const changedSettings = structuredClone(settings);
    changedSettings.regionRates.omitted = 999;
    changedSettings.thresholds = [{ count: 0, rate: 500 }];
    const result = previewCsvImport(csv, suggestCsvMapping(parseCsv(csv).headers), changedSettings, []);
    expect(result.errors).toEqual([]);
    expect(result.records).toEqual(records);
  });
  it("exports formula-safe readable cells while keeping original text in the JSON column", () => {
    for (const note of ["=SUM(1,2)", "+cmd", "-cmd", "@SUM(A1)", " \t=HYPERLINK(\"x\")", "\r@SUM(A1)"]) {
      const records = sampleRecords(); records[0].note = note;
      const csv = exportCsv(records, settings);
      expect(csv.startsWith("\uFEFF")).toBe(true);
      expect(csv).toContain(`"'${note.replace(/"/g, '""')}"`);
      expect(previewCsvImport(csv, { date: 0, quantity: 2 }, settings, []).records[0].note).toBe(note);
    }
  });
  it("rejects duplicate imported IDs and invalid machine snapshots", () => {
    const records = sampleRecords(), csv = exportCsv(records, settings);
    const duplicated = previewCsvImport(csv, { date: 0, quantity: 2 }, settings, records);
    expect(duplicated.records).toHaveLength(0);
    expect(duplicated.errors).toHaveLength(3);
    const malformed = `記録データ（JSON）\n${JSON.stringify(JSON.stringify({ ...records[1], snapshot: { regionRate: -1 } })).replace(/\\"/g, '""')}`;
    expect(() => parseCsv(malformed)).not.toThrow();
    expect(previewCsvImport(malformed, { date: -1, quantity: -1 }, settings, []).errors).toHaveLength(1);
  });
});
