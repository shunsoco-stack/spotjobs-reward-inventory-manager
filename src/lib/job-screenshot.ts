import { createRewardSnapshot, isValidDate, todayLocal, type Area, type Settings, type WorkRecord } from './core';

export interface JobScreenshotCandidate {
  key: string;
  date: string;
  time: string;
  type: 'pickup' | 'refill' | null;
  quantity: number | null;
  storeName: string;
  rawText: string;
  warnings: string[];
  /** Original readable completion identity, retained when reviewed values are corrected. */
  sourceId?: string;
  area?: Area;
  earlyMode?: 'auto' | 'manual';
  manualEarly?: number;
  note?: string;
}
export interface JobScreenshotIssue { key: string; message: string }
export interface JobScreenshotBuildResult {
  records: WorkRecord[];
  errors: JobScreenshotIssue[];
  /** Candidate keys excluded because their completion second and operation already exist. */
  duplicates: string[];
  warnings: JobScreenshotIssue[];
}

const AREAS: Area[] = ['A', 'B', 'C', 'D', 'omitted'];
const MAX_RECORDS = 20_000;
const MAX_QUANTITY = 99_999;
const MAX_TEXT_LENGTH = 200_000;
const TYPE_LABEL = '(?:取\\s*出(?:\\s*し)?|取\\s*り\\s*出\\s*し|抜\\s*取|抜\\s*き\\s*取\\s*り|補\\s*充)';
const OPERATION_PREFIX = '(?:^|[\\n|])[^\\S\\n]*(?:[©®&●○◉◎◯▪•]\\s*)?';
const COMPLETION_LABEL = /(?:未\s*)?完\s*了\s*(?:時\s*間|日\s*時|時\s*刻|時\s*問)\s*[:：]?/g;

function normalize(text: string): string {
  return text.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[‐‑‒–−]/g, '-');
}
function cleanDate(date: string): boolean {
  return isValidDate(date) && Number(date.slice(0, 4)) >= 1;
}
function cleanTime(time: string): boolean {
  return /^\d{2}:\d{2}:\d{2}$/.test(time) && Number(time.slice(0, 2)) < 24
    && Number(time.slice(3, 5)) < 60 && Number(time.slice(6, 8)) < 60;
}
function identity(date: string, time: string, type: 'pickup' | 'refill'): string {
  return `jobshot:${date}T${time}:${type}`;
}
function validSourceId(id: string): boolean {
  const parts = /^jobshot:(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}):(pickup|refill)$/.exec(id);
  return !!parts && cleanDate(parts[1]) && cleanTime(parts[2]);
}
function currentRecordIdentity(record: WorkRecord): string | undefined {
  if (!record.id.startsWith('jobshot:') || (record.type !== 'pickup' && record.type !== 'refill') || !cleanDate(record.date)) return;
  const timestamp = Date.parse(record.createdAt);
  if (!Number.isFinite(timestamp)) return;
  const time = new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(11, 19);
  return identity(record.date, time, record.type);
}
function operationType(label: string): 'pickup' | 'refill' {
  return label.replace(/\s/g, '') === '補充' ? 'refill' : 'pickup';
}
function operationRows(text: string): string {
  // Tiny operation icons can become arbitrary kana, digits or punctuation in OCR.
  // Strip a short fragment only before an explicit label:count本 + reward column;
  // never apply this relaxation to narrative text or an incomplete operation row.
  const summary = new RegExp(`^([^\\n|]{1,6}?)(${TYPE_LABEL})[^\\S\\n]*[:：][^\\S\\n]*\\d+[^\\S\\n]*本[^\\S\\n]*(?:報[^\\S\\n]*酬|概[^\\S\\n]*算|金[^\\S\\n]*額)`);
  return text.split('\n').map(line => {
    const row = line.trimStart();
    const match = summary.exec(row);
    if (!match || /した|する|して|から|以内|場合|例えば|未完了/.test(match[1])) return line;
    return row.slice(match[1].length);
  }).join('\n');
}
function operations(text: string) {
  // A record must have an operation label and a unit count, not prose containing the same verb.
  const expression = new RegExp(`${OPERATION_PREFIX}(${TYPE_LABEL})\\s*[:：]?\\s*(\\d+)\\s*本(?=[^\\S\\n]*(?:$|[\\n|（(]|報酬|概算|目安|見込み|参考|金額|[+]?¥|[+]?\\d[\\d,]*円))`, 'gm');
  return [...operationRows(text).matchAll(expression)].map(match => ({ type: operationType(match[1]), quantity: Number(match[2]), index: match.index ?? 0 }));
}
function operationLabels(text: string) {
  const expression = new RegExp(`${OPERATION_PREFIX}(${TYPE_LABEL})(?=[^\\S\\n]*(?:[:：]|$|\\d))`, 'gm');
  return [...operationRows(text).matchAll(expression)].map(match => operationType(match[1]));
}

function storeNameFrom(text: string): string {
  const lines = text.split('\n').map(line => line.trim().replace(/\s*[>›»→]+\s*$/, '').trim()).filter(Boolean);
  const explicit = lines.map(line => /^(?:店舗名|店舗|施設名)\s*[:：]\s*(.+)$/.exec(line)).find(Boolean);
  if (explicit) return explicit[1].trim();
  const candidates = lines.filter(line => !/完\s*了|\d{4}\s*[-/.年]|\d\s*:\s*\d|^\d+$/.test(line)
    && !new RegExp(`^${TYPE_LABEL}(?:\\s*[:：]|\\s*\\d|$)`).test(line)
    && !/ジョブ履歴|ボーナス|[+＋]\s*\d|\d\s*円|以内|報酬|バッテリー|対象|キャンペーン|タップ|(?:取出|補充)(?:した|する|して)/.test(line));
  const markedIndex = candidates.findIndex(line => /(?:店|駅|ホテル|センター|ビル|ショップ)(?:\s|$)/.test(line));
  if (markedIndex < 0) return '';
  // OCR can wrap a short brand line above the branch name. Do not join arbitrary prose.
  const previous = candidates[markedIndex - 1];
  if (previous && /(?:マート|ストア|ショップ|コンビニ|ホテル)$/.test(previous) && previous.length <= 40) {
    return `${previous} ${candidates[markedIndex]}`;
  }
  return candidates[markedIndex];
}

function parseBlock(rawText: string, key: string, label: string | null): JobScreenshotCandidate {
  const candidate: JobScreenshotCandidate = { key, date: '', time: '', type: null, quantity: null, storeName: '', rawText, warnings: [] };
  let body = normalize(rawText);
  if (label !== null) {
    body = body.slice(normalize(label).length).trimStart();
    const date = /^(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})(?:\s*日)?/.exec(body);
    if (date) {
      candidate.date = `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`;
      if (!cleanDate(candidate.date)) candidate.warnings.push('完了日が存在する日付か確認してください。');
      const afterDate = body.slice(date[0].length).replace(/^\s*[（(][日月火水木金土](?:曜(?:日)?)?[）)]/, '').trimStart();
      const time = /^(\d{1,2})\s*(?::|時)\s*(\d{1,2})\s*(?::|分)\s*(\d{1,2})(?:\s*秒)?(?=\s|$)/.exec(afterDate);
      if (time) {
        candidate.time = `${time[1].padStart(2, '0')}:${time[2].padStart(2, '0')}:${time[3].padStart(2, '0')}`;
        if (!cleanTime(candidate.time)) candidate.warnings.push('完了時刻を確認してください。');
      } else {
        const partial = /^(\d{1,2})\s*:\s*(\d{1,2})(?!\d)/.exec(afterDate);
        if (partial) candidate.time = `${partial[1].padStart(2, '0')}:${partial[2].padStart(2, '0')}`;
        candidate.warnings.push('完了時刻の秒まで読み取れませんでした。画像で確認・修正してください。');
      }
    } else candidate.warnings.push('年を含む完了日を読み取れませんでした。画像で確認・修正してください。');
    if (/時\s*問/.test(label)) candidate.warnings.push('完了時間の見出しに読み取り誤りの可能性があります。');
  } else candidate.warnings.push('完了時間の行を確認できませんでした。未完了の作業を登録しないでください。');

  const found = operations(body);
  const labels = operationLabels(body);
  if (found.length === 1 && labels.length <= 1) {
    candidate.type = found[0].type;
    candidate.quantity = found[0].quantity;
    if (candidate.quantity < 1 || candidate.quantity > MAX_QUANTITY) candidate.warnings.push('本数は1〜99,999本の範囲で確認してください。');
  } else if (found.length > 1 || labels.length > 1) {
    candidate.warnings.push('1つの完了行に複数の作業が見つかりました。種類と本数を画像で確認してください。');
  } else {
    if (labels.length === 1) candidate.type = labels[0];
    candidate.warnings.push('取出・補充の種類と本数を読み取れませんでした。切れている行は確認・修正してください。');
  }
  candidate.storeName = storeNameFrom(body);
  if (!candidate.storeName) candidate.warnings.push('店舗名を読み取れませんでした。必要に応じて入力してください。');
  if (cleanDate(candidate.date) && cleanTime(candidate.time) && candidate.type) candidate.sourceId = identity(candidate.date, candidate.time, candidate.type);
  return candidate;
}

/** Conservative text parsing only. This does not infer region or early-bonus eligibility. */
export function parseJobScreenshotText(text: string, sourceKey = 'image'): JobScreenshotCandidate[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  if (text.length > MAX_TEXT_LENGTH) throw new Error('読み取った文字数が多すぎます。画像を分けてください。');
  const source = text;
  const anchors = [...source.matchAll(COMPLETION_LABEL)].filter(match => !/^未/.test(match[0]));
  if (!anchors.length) {
    const normalized = normalize(source);
    return operations(normalized).length || operationLabels(normalized).length ? [parseBlock(source.trim(), `${sourceKey}:0`, null)] : [];
  }
  return anchors.map((anchor, index) => {
    const start = anchor.index ?? 0;
    const end = anchors[index + 1]?.index ?? source.length;
    return parseBlock(source.slice(start, end).trim(), `${sourceKey}:${index}`, anchor[0]);
  });
}

/** Validate the edited values; original OCR warnings remain advisory after correction. */
export function validateJobScreenshotCandidate(candidate: JobScreenshotCandidate, today = todayLocal()): string[] {
  const errors: string[] = [];
  if (!cleanDate(candidate.date)) errors.push('完了日は YYYY-MM-DD 形式の正しい日付で入力してください。');
  else if (candidate.date > today) errors.push('未来の完了日は登録できません。');
  if (!cleanTime(candidate.time)) errors.push('完了時刻は秒を含む HH:mm:ss 形式で入力してください。');
  if (candidate.type !== 'pickup' && candidate.type !== 'refill') errors.push('作業の種類を取出・補充から選択してください。');
  if (candidate.quantity === null || !Number.isSafeInteger(candidate.quantity) || candidate.quantity < 1 || candidate.quantity > MAX_QUANTITY) errors.push('本数は1〜99,999の整数で入力してください。');
  if (candidate.area !== undefined && !AREAS.includes(candidate.area)) errors.push('補充エリアを選択してください。');
  if (candidate.earlyMode !== undefined && candidate.earlyMode !== 'auto' && candidate.earlyMode !== 'manual') errors.push('早期補充の計算方法を選択してください。');
  if (candidate.sourceId !== undefined && !validSourceId(candidate.sourceId)) errors.push('画像の元の完了識別情報が不正です。画像を読み取り直してください。');
  if (candidate.type === 'refill' && candidate.earlyMode === 'manual' && (candidate.manualEarly === undefined
    || !Number.isSafeInteger(candidate.manualEarly) || candidate.manualEarly < 0 || candidate.manualEarly > (candidate.quantity ?? 0))) errors.push('早期対象の本数を0から補充本数の範囲で入力してください。');
  const note = candidate.note ?? candidate.storeName;
  if (note.length > 2000) errors.push('店舗名・メモは2,000文字以内で入力してください。');
  return errors;
}

/**
 * Build only valid, unique records. The caller must show errors, duplicate exclusions
 * and warnings before confirming an import. Existing records are never mutated.
 */
export function buildJobScreenshotRecords(candidates: JobScreenshotCandidate[], settings: Settings, existingRecords: WorkRecord[], today = todayLocal()): JobScreenshotBuildResult {
  const result: JobScreenshotBuildResult = { records: [], errors: [], duplicates: [], warnings: [] };
  const usedIds = new Set(existingRecords.map(record => record.id));
  for (const record of existingRecords) {
    const currentIdentity = currentRecordIdentity(record);
    if (currentIdentity) usedIds.add(currentIdentity);
  }
  const manualDays = new Set(existingRecords.filter(record => !record.id.startsWith('jobshot:') && (record.type === 'pickup' || record.type === 'refill')).map(record => `${record.date}:${record.type}`));
  const ordered = [...candidates].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  for (const candidate of ordered) {
    for (const message of candidate.warnings) result.warnings.push({ key: candidate.key, message });
    const errors = validateJobScreenshotCandidate(candidate, today);
    if (errors.length) { result.errors.push(...errors.map(message => ({ key: candidate.key, message }))); continue; }
    const type = candidate.type as 'pickup' | 'refill';
    const currentIdentity = identity(candidate.date, candidate.time, type);
    const id = candidate.sourceId ?? currentIdentity;
    if (usedIds.has(id) || usedIds.has(currentIdentity)) {
      result.duplicates.push(candidate.key);
      result.warnings.push({ key: candidate.key, message: '同じ完了日時・種類の記録があるため、重複候補として除外しました。' });
      continue;
    }
    if (existingRecords.length + result.records.length >= MAX_RECORDS) {
      result.errors.push({ key: candidate.key, message: '取込後の記録が20,000件を超えます。' });
      continue;
    }
    const createdAt = new Date(`${candidate.date}T${candidate.time}+09:00`).toISOString();
    if (!cleanDate(createdAt.slice(0, 10))) {
      result.errors.push({ key: candidate.key, message: '完了日時が保存可能な範囲外です。' });
      continue;
    }
    const note = (candidate.note ?? candidate.storeName).trim();
    const base = { id, date: candidate.date, quantity: candidate.quantity as number, createdAt, ...(note ? { note } : {}) };
    let record: WorkRecord;
    if (type === 'pickup') record = { ...base, type };
    else {
      const area = candidate.area ?? settings.defaultArea;
      const earlyMode = candidate.earlyMode ?? 'auto';
      record = { ...base, type, area, earlyMode,
        ...(earlyMode === 'manual' ? { manualEarly: candidate.manualEarly } : {}),
        snapshot: createRewardSnapshot(candidate.date, area, settings, [...existingRecords, ...result.records]),
      };
    }
    if (manualDays.has(`${candidate.date}:${type}`)) result.warnings.push({ key: candidate.key, message: '同じ日・種類の手入力などの記録があります。今回の作業と重複していないか確認してください。' });
    usedIds.add(id);
    usedIds.add(currentIdentity);
    result.records.push(record);
  }
  return result;
}
