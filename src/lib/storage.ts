import { addDays, createRewardSnapshot, defaultSettings, type Area, type BonusTier, type Settings, type WorkRecord, type RewardSnapshot } from "./core";

export const STORAGE_KEY = "spotlog-data-v1";
export const DATABASE_NAME = "spotlog-worker";
export const MAX_BACKUP_CHARS = 60_000_000;
export const MAX_BACKUP_BYTES = MAX_BACKUP_CHARS * 3;
export const MAX_RECORDS = 20_000;
const STORE = "app";
const DATA_KEY = "current";
const AREAS: Area[] = ["A", "B", "C", "D", "omitted"];

export interface AppData { version: 2; records: WorkRecord[]; settings: Settings; lastArea: Area }
export interface BackupInspection { data: AppData; exportedAt: string | null; recordCount: number; startDate: string | null; endDate: string | null }

function invalid(message: string): never { throw new Error(`データを読み込めません。${message}`); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(`${label}の形式を確認してください。`);
  return value as Record<string, unknown>;
}
function number(value: unknown, label: string, min = 0, max = 10_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid(`${label}の数値を確認してください。`);
  return value;
}
function area(value: unknown): Area {
  if (typeof value !== "string" || !AREAS.includes(value as Area)) return invalid("エリアは A・B・C・D・omitted のいずれかを指定してください。");
  return value as Area;
}
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") return invalid(`${label}が正しくありません。`);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !isCalendarDate(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59) return invalid(`${label}が正しくありません。`);
  if (match[5] !== "Z") {
    const [hours, minutes] = match[5].slice(1).split(":").map(Number);
    if (hours > 23 || minutes > 59) return invalid(`${label}が正しくありません。`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return invalid(`${label}が正しくありません。`);
  const normalized = new Date(time).toISOString();
  if (!isCalendarDate(normalized.split("T")[0])) return invalid(`${label}の範囲を確認してください。`);
  return normalized;
}
function tiers(value: unknown): BonusTier[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) return invalid("本数ボーナスは 1〜10 段階で指定してください。");
  let previous = -1;
  let previousRate = -1;
  return value.map((entry, index) => {
    const tier = object(entry, "本数ボーナス");
    const count = number(tier.count, "開始本数", 0, 99_999);
    const rate = number(tier.rate, "ボーナス単価");
    if (index === 0 && count !== 0) return invalid("本数ボーナスの最初の段階は 0 本から始めてください。");
    if (count <= previous) return invalid("本数ボーナスは重複させず、小さい順に並べてください。");
    if (rate < previousRate) return invalid("本数ボーナスの単価は、前の段階と同じか高い金額にしてください。");
    previous = count;
    previousRate = rate;
    return { count, rate };
  });
}
function textMap(value: unknown, label: string, max: number): Record<Area, string> {
  const values = object(value, label);
  return Object.fromEntries(AREAS.map((key) => {
    const text = values[key];
    if (typeof text !== "string" || !text.trim() || text.length > max) return invalid(`${label}は 1〜${max} 文字で指定してください。`);
    return [key, text];
  })) as Record<Area, string>;
}
export function validateSettings(value: unknown): Settings {
  const settings = object(value, "設定");
  const rates = object(settings.regionRates, "地域単価");
  const regionRates = Object.fromEntries(AREAS.map((key) => [key, number(rates[key], `エリア ${key} の単価`)])) as Record<Area, number>;
  const theme = settings.theme;
  if (theme !== "light" && theme !== "dark" && theme !== "system") return invalid("表示テーマを確認してください。");
  return {
    regionRates,
    regionNames: textMap(settings.regionNames, "エリア名", 100),
    regionDescriptions: textMap(settings.regionDescriptions, "エリアの説明", 500),
    defaultArea: area(settings.defaultArea),
    thresholds: tiers(settings.thresholds),
    earlyDays: number(settings.earlyDays, "早期補充の対象日数", 1, 365),
    earlyRate: number(settings.earlyRate, "早期補充の単価"),
    weeklyGoal: number(settings.weeklyGoal, "週間目標", 1, Number.MAX_SAFE_INTEGER),
    weekStartsOn: number(settings.weekStartsOn, "週の開始曜日", 0, 6) as Settings["weekStartsOn"],
    theme,
  };
}
function snapshot(value: unknown, date: string): RewardSnapshot {
  const saved = object(value, "記録時の報酬条件");
  if (!isCalendarDate(saved.weekStart) || date < saved.weekStart || date > addDays(saved.weekStart, 6)) return invalid("記録時の集計週を確認してください。");
  return {
    regionRate: number(saved.regionRate, "記録時の地域単価"),
    earlyRate: number(saved.earlyRate, "記録時の早期単価"),
    earlyDays: number(saved.earlyDays, "記録時の早期対象日数", 1, 365),
    weekStart: saved.weekStart,
    thresholds: tiers(saved.thresholds),
  };
}
export function validateRecords(value: unknown, legacy = false): WorkRecord[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) return invalid(`作業記録は ${MAX_RECORDS.toLocaleString("ja-JP")} 件以内で指定してください。`);
  const ids = new Set<string>();
  return value.map((entry, index): WorkRecord => {
    const record = object(entry, `${index + 1} 件目の記録`);
    if (typeof record.id !== "string" || !record.id.trim() || record.id.length > 200 || ids.has(record.id)) return invalid(`${index + 1} 件目の記録 ID が未設定、重複、または長すぎます。`);
    ids.add(record.id);
    if (!isCalendarDate(record.date)) return invalid(`${index + 1} 件目の作業日が正しくありません。`);
    if (record.type !== "pickup" && record.type !== "refill" && record.type !== "adjustment") return invalid(`${index + 1} 件目の作業の種類を確認してください。`);
    if (record.note !== undefined && (typeof record.note !== "string" || record.note.length > 2_000)) return invalid(`${index + 1} 件目のメモは 2,000 文字以内で指定してください。`);
    const base = {
      id: record.id, date: record.date,
      quantity: number(record.quantity, `${index + 1} 件目の本数`, record.type === "adjustment" ? 0 : 1, 99_999),
      createdAt: timestamp(record.createdAt, `${index + 1} 件目の登録日時`),
      ...(record.note === undefined ? {} : { note: record.note as string }),
    };
    if (record.type === "refill") {
      if (record.earlyMode !== "auto" && record.earlyMode !== "manual") return invalid(`${index + 1} 件目の早期判定方法を確認してください。`);
      const manualEarly = record.manualEarly === undefined ? undefined : number(record.manualEarly, "早期補充の対象本数", 0, base.quantity);
      return { ...base, type: "refill", area: area(record.area), earlyMode: record.earlyMode,
        ...(manualEarly === undefined ? {} : { manualEarly }),
        ...(legacy ? {} : { snapshot: snapshot(record.snapshot, record.date) }),
      };
    }
    if (record.type === "pickup") return { ...base, type: "pickup" };
    if (!legacy && record.applied !== undefined && typeof record.applied !== "boolean") return invalid("棚卸しの反映状態を確認してください。");
    const expectedStock = record.expectedStock === undefined ? undefined : number(record.expectedStock, "棚卸時の想定在庫", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const difference = record.difference === undefined ? undefined : number(record.difference, "棚卸差分", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (expectedStock !== undefined && difference !== undefined && expectedStock + difference !== base.quantity) return invalid("棚卸しの在庫数と差分が一致しません。");
    return { ...base, type: "adjustment", applied: legacy ? true : record.applied === true,
      ...(expectedStock === undefined ? {} : { expectedStock }), ...(difference === undefined ? {} : { difference }) };
  });
}
function migrateLegacy(data: Record<string, unknown>): AppData {
  const oldSettings = object(data.settings, "設定");
  const oldRates = object(oldSettings.regionRates, "地域単価");
  const settings = validateSettings({ ...defaultSettings, ...oldSettings,
    regionRates: { ...oldRates, omitted: defaultSettings.regionRates.omitted },
    regionNames: { A: "東京23区", B: "東京都下", C: "主要7都市", D: "その他", omitted: "エリア省略" },
    regionDescriptions: { A: "東京都の23区内", B: "東京都の23区外", C: "横浜・川崎・名古屋・京都・大阪・神戸・福岡市", D: "上記以外のエリア", omitted: "エリアを指定しない場合" },
    defaultArea: "omitted", weekStartsOn: 1, theme: "system",
  });
  const records = validateRecords(data.records, true).map((record): WorkRecord => record.type === "refill"
    ? { ...record, snapshot: createRewardSnapshot(record.date, record.area, settings, []) } : record);
  return { version: 2, settings, records, lastArea: area(data.lastArea) };
}
export function validateAppData(value: unknown): AppData {
  const data = object(value, "バックアップ");
  if (data.version === 1) return migrateLegacy(data);
  if (data.version !== 2) return invalid("対応していないバックアップのバージョンです。");
  return { version: 2, records: validateRecords(data.records), settings: validateSettings(data.settings), lastArea: area(data.lastArea) };
}
export function inspectBackup(text: string): BackupInspection {
  if (typeof text !== "string" || text.length > MAX_BACKUP_CHARS) return invalid("ファイルが大きすぎます。");
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { return invalid("JSON 形式のバックアップファイルを選択してください。"); }
  const source = object(parsed, "バックアップ");
  let exportedAt: string | null = null;
  let data: AppData;
  if (Object.hasOwn(source, "format")) {
    if (source.format !== "spotjobs-backup") return invalid("対応していないバックアップ形式です。");
    exportedAt = timestamp(source.exportedAt, "バックアップの作成日時");
    data = validateAppData(source.data);
  } else data = validateAppData(source);
  const dates = data.records.map((record) => record.date).sort();
  return { data, exportedAt, recordCount: data.records.length, startDate: dates[0] ?? null, endDate: dates.at(-1) ?? null };
}
export function parseBackup(text: string): AppData { return inspectBackup(text).data; }
export function serializeBackup(data: AppData): string {
  const text = JSON.stringify({ format: "spotjobs-backup", exportedAt: new Date().toISOString(), data: validateAppData(data) }, null, 2);
  if (text.length > MAX_BACKUP_CHARS) return invalid("ファイルが大きすぎます。");
  return text;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("このブラウザでは IndexedDB を利用できません。ブラウザの保存設定を確認してください。")); return; }
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DATABASE_NAME, 1); } catch (error) { reject(error); return; }
    let rejected = false;
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onerror = () => { rejected = true; reject(request.error ?? new Error("保存領域を開けませんでした。")); };
    request.onblocked = () => { rejected = true; reject(new Error("別のタブが保存領域を使用しています。タブを閉じて再試行してください。")); };
    request.onsuccess = () => { if (rejected) request.result.close(); else resolve(request.result); };
  });
}
async function readDatabase(): Promise<unknown> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, "readonly");
      const request = transaction.objectStore(STORE).get(DATA_KEY);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error("保存データを読み込めませんでした。"));
      transaction.onerror = () => reject(transaction.error ?? new Error("保存データを読み込めませんでした。"));
    });
  } finally { database.close(); }
}
export async function saveData(data: AppData, options?: { expected: AppData | null }): Promise<void> {
  const validated = validateAppData(data);
  const expected = options ? (options.expected === null ? null : validateAppData(options.expected)) : undefined;
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("保存処理が中止されました。"));
      transaction.onerror = () => reject(transaction.error ?? new Error("保存できませんでした。空き容量を確認してください。"));
      const store = transaction.objectStore(STORE);
      if (expected === undefined) store.put(validated, DATA_KEY);
      else {
        const request = store.get(DATA_KEY);
        request.onsuccess = () => {
          try {
            const current = request.result === undefined ? null : validateAppData(request.result);
            if (JSON.stringify(current) !== JSON.stringify(expected)) {
              reject(new Error("別のタブで記録が更新されました。最新の記録を読み込み直してから、もう一度保存してください。入力内容は保持しています。"));
              transaction.abort();
              return;
            }
            store.put(validated, DATA_KEY);
          } catch (error) { reject(error); transaction.abort(); }
        };
      }
    });
  } finally { database.close(); }
}
export async function loadData(): Promise<AppData | null> {
  const stored = await readDatabase();
  if (stored !== undefined) return validateAppData(stored);
  const legacy = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
  if (legacy === null) return null;
  const migrated = parseBackup(legacy);
  // The old localStorage value is intentionally retained as a migration backup.
  await saveData(migrated);
  return migrated;
}

function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function exportCsv(records: WorkRecord[], settings: Settings): string {
  const safeRecords = validateRecords(records);
  validateSettings(settings);
  const labels = { pickup: "抜き取り", refill: "補充", adjustment: "棚卸し" };
  const rows: (string | number)[][] = [["日付", "作業", "本数", "エリア", "早期判定", "早期対象本数", "メモ", "記録ID", "登録日時", "記録時地域単価", "記録時早期単価", "記録時早期日数", "集計週開始日", "記録時本数ボーナス", "棚卸反映", "棚卸時想定在庫", "棚卸差分", "記録データ（JSON）"],
    ...safeRecords.map((record): (string | number)[] => {
      const snap = record.type === "refill" ? record.snapshot : undefined;
      return [record.date, labels[record.type], record.quantity,
        record.type === "refill" ? record.area : "", record.type === "refill" ? record.earlyMode : "",
        record.type === "refill" && record.earlyMode === "manual" ? record.manualEarly ?? 0 : "", record.note ?? "", record.id, record.createdAt,
        snap?.regionRate ?? "", snap?.earlyRate ?? "", snap?.earlyDays ?? "", snap?.weekStart ?? "", snap ? JSON.stringify(snap.thresholds) : "",
        record.type === "adjustment" ? String(record.applied) : "", record.type === "adjustment" ? record.expectedStock ?? "" : "",
        record.type === "adjustment" ? record.difference ?? "" : "", JSON.stringify(record)];
    }),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
