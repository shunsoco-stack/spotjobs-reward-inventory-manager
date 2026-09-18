import { createRewardSnapshot, todayLocal, type Area, type Settings, type WorkRecord } from "./core";
import { isCalendarDate, MAX_BACKUP_BYTES, MAX_RECORDS, validateRecords, validateSettings } from "./storage";

export interface ParsedCsv { headers: string[]; rows: string[][] }
export interface ColumnMapping { date: number; type?: number; quantity: number; area?: number; earlyCount?: number; note?: number }
export interface CsvImportError { row: number; message: string }
export interface CsvImportPreview { records: WorkRecord[]; errors: CsvImportError[] }

function delimiterFor(text: string): string {
  const counts = new Map([[",", 0], ["\t", 0], [";", 0]]);
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') { if (quoted && text[index + 1] === '"') index++; else quoted = !quoted; }
    if (!quoted && (char === "\r" || char === "\n")) break;
    if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}
export function parseCsv(text: string): ParsedCsv {
  if (typeof text !== "string" || text.length > MAX_BACKUP_BYTES) throw new Error("CSVファイルが大きすぎます。");
  const source = text.replace(/^\uFEFF/, "");
  const delimiter = delimiterFor(source);
  const table: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  const endCell = () => { row.push(cell); cell = ""; closed = false; if (row.length > 128) throw new Error("CSVの列数は128列以内にしてください。"); };
  const endRow = () => { endCell(); if (row.some((value) => value.trim() !== "")) table.push(row); row = []; if (table.length > MAX_RECORDS + 1) throw new Error("CSVの記録は20,000件以内にしてください。"); };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') { if (source[index + 1] === '"') { cell += '"'; index++; } else { quoted = false; closed = true; } }
      else cell += char;
      continue;
    }
    if (char === delimiter) { endCell(); continue; }
    if (char === "\r" || char === "\n") { if (char === "\r" && source[index + 1] === "\n") index++; endRow(); continue; }
    if (closed) { if (char === " " || char === "\t") continue; throw new Error("閉じた引用符の後に区切り文字がありません。"); }
    if (char === '"') { if (cell !== "") throw new Error("CSVの引用符の位置を確認してください。"); quoted = true; }
    else cell += char;
  }
  if (quoted) throw new Error("CSVの引用符が閉じられていません。");
  if (cell !== "" || row.length > 0 || closed) endRow();
  if (!table.length) throw new Error("CSVに見出しと記録がありません。");
  const headers = table.shift()!.map((header) => header.trim());
  if (!headers.some(Boolean)) throw new Error("CSVの見出しを確認してください。");
  return { headers, rows: table };
}
const HEADER_ALIASES: Record<keyof ColumnMapping, string[]> = {
  date: ["日付", "記録日", "作業日", "date"], type: ["作業", "種類", "作業種類", "type"],
  quantity: ["本数", "数量", "quantity", "count"], area: ["エリア", "地域", "area", "region"],
  earlyCount: ["早期対象本数", "早期対象", "早期対象本数（手動）", "早期補充本数", "earlycount", "manualearly"],
  note: ["メモ", "備考", "note", "memo"],
};
export function suggestCsvMapping(headers: string[]): ColumnMapping {
  const mapping: Partial<ColumnMapping> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const index = headers.findIndex((header) => aliases.includes(header.trim().toLowerCase()));
    if (index >= 0) mapping[field as keyof ColumnMapping] = index;
  }
  return { date: mapping.date ?? -1, quantity: mapping.quantity ?? -1, ...mapping };
}
function csvDate(text: string): string {
  const match = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/.exec(text.trim());
  if (!match) throw new Error("日付は年を含む YYYY-MM-DD または YYYY/M/D 形式で入力してください。");
  const value = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  if (!isCalendarDate(value)) throw new Error("存在しない日付です。");
  return value;
}
function quantity(text: string, allowZero: boolean): number {
  const normalized = text.trim().replace(/^(\d{1,3}(?:,\d{3})+)$/, (match) => match.replaceAll(",", ""));
  if (!/^\d+$/.test(normalized)) throw new Error("本数は整数で入力してください。");
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 99_999) throw new Error("本数は補充・取出が1〜99,999本、棚卸しが0〜99,999本です。");
  return value;
}
function recordType(text: string): WorkRecord["type"] {
  const value = text.trim().toLowerCase();
  if (["", "refill", "補充", "補充した"].includes(value)) return "refill";
  if (["pickup", "抜取", "抜き取り", "抜取った", "抜き取った", "回収", "取出", "取り出し"].includes(value)) return "pickup";
  if (["adjustment", "棚卸", "棚卸し", "在庫調整"].includes(value)) return "adjustment";
  throw new Error(`作業の種類「${text}」を判別できません。補充・取出・棚卸しを指定してください。`);
}
function csvArea(text: string, settings: Settings): Area {
  const value = text.trim();
  if (value === "") return settings.defaultArea;
  if (["省略", "未指定", "エリア省略", "omitted"].includes(value)) return "omitted";
  const uppercase = value.toUpperCase();
  if (["A", "B", "C", "D"].includes(uppercase)) return uppercase as Area;
  const match = (Object.entries(settings.regionNames) as [Area, string][]).find(([, name]) => name === value);
  if (match) return match[0];
  throw new Error(`エリア「${text}」を判別できません。設定のエリア名または A・B・C・D を指定してください。`);
}

export function previewCsvImport(text: string, mapping: ColumnMapping, settings: Settings, existingRecords: WorkRecord[]): CsvImportPreview {
  const { headers, rows } = parseCsv(text);
  const safeSettings = validateSettings(settings);
  const machineColumn = headers.indexOf("記録データ（JSON）");
  const errors: CsvImportError[] = [], records: WorkRecord[] = [];
  const usedIds = new Set(existingRecords.map((record) => record.id));
  if (existingRecords.length + rows.length > MAX_RECORDS) return { records, errors: [{ row: 1, message: "取込後の記録が20,000件を超えます。" }] };
  if (machineColumn < 0) {
    if (![mapping.date, mapping.quantity].every((index) => Number.isInteger(index) && index >= 0 && index < headers.length)) return { records, errors: [{ row: 1, message: "日付と本数の列を選択してください。" }] };
    for (const index of Object.values(mapping)) if (index !== undefined && (!Number.isInteger(index) || index < 0 || index >= headers.length)) return { records, errors: [{ row: 1, message: "列の割り当てを確認してください。" }] };
  }
  const now = Date.now();
  rows.forEach((row, index) => {
    try {
      if (row.length !== headers.length) throw new Error(`列数が見出し（${headers.length}列）と一致しません。`);
      let record: WorkRecord;
      if (machineColumn >= 0) {
        let parsed: unknown;
        try { parsed = JSON.parse(row[machineColumn]); } catch { throw new Error("記録データ（JSON）列の形式を確認してください。"); }
        record = validateRecords([parsed])[0];
      } else {
        const read = (field: keyof ColumnMapping) => mapping[field] === undefined ? "" : row[mapping[field]!];
        const date = csvDate(read("date"));
        const type = recordType(read("type"));
        const count = quantity(read("quantity"), type === "adjustment");
        const base = { id: crypto.randomUUID(), date, quantity: count, createdAt: new Date(now + index).toISOString(), ...(read("note") === "" ? {} : { note: read("note") }) };
        if (type === "refill") {
          const area = csvArea(read("area"), safeSettings);
          const early = read("earlyCount").trim();
          record = { ...base, type, area, earlyMode: early === "" ? "auto" : "manual",
            ...(early === "" ? {} : { manualEarly: quantity(early, true) }),
            snapshot: createRewardSnapshot(date, area, safeSettings, [...existingRecords, ...records]),
          };
        } else if (type === "pickup") record = { ...base, type };
        else record = { ...base, type, applied: false };
        record = validateRecords([record])[0];
      }
      if (record.date > todayLocal()) throw new Error("未来の日付は取り込めません。");
      if (usedIds.has(record.id)) throw new Error("記録IDが既存データまたはCSV内で重複しています。");
      usedIds.add(record.id);
      records.push(record);
    } catch (error) { errors.push({ row: index + 2, message: error instanceof Error ? error.message : "この行を読み込めません。" }); }
  });
  return { records, errors };
}
