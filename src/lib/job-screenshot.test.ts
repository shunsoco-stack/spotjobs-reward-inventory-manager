import { describe, expect, it } from 'vitest';
import { calculate, createRewardSnapshot, defaultSettings, type Settings, type WorkRecord } from './core';
import { buildJobScreenshotRecords, parseJobScreenshotText, validateJobScreenshotCandidate, type JobScreenshotCandidate } from './job-screenshot';
import { validateRecords } from './storage';

// All dates, stores and OCR text below are synthetic fixtures, not a user's images.
const today = '2026-08-21';
const date = '2026-08-20';
function candidate(overrides: Partial<JobScreenshotCandidate> = {}): JobScreenshotCandidate {
  return { key: 'image:0', date, time: '10:20:30', type: 'pickup', quantity: 2,
    storeName: '架空ストア 北口店', rawText: '', warnings: [], ...overrides };
}
const fixture = `ジョブ履歴\n未完了 完了\n完了時間: 2026-08-20 22:31:42\n架空マート 雲の丘店\n取出:1本\n取出したバッテリーを3日以内に補充すると+10円\n完了時間: 2026-08-20 22:28:16\n架空マート 雲の丘店\n取出:1本\n完了時間: 2026-08-20 09:24:18\n架空ストア 星の橋店\n補充:3本`;

describe('conservative screenshot text extraction', () => {
  it('extracts completion timestamps, synthetic stores, operation types and quantities from separate cards', () => {
    const rows = parseJobScreenshotText(fixture, 'photo-1');
    expect(rows).toHaveLength(3);
    expect(rows.map(row => [row.date, row.time, row.storeName, row.type, row.quantity])).toEqual([
      [date, '22:31:42', '架空マート 雲の丘店', 'pickup', 1],
      [date, '22:28:16', '架空マート 雲の丘店', 'pickup', 1],
      [date, '09:24:18', '架空ストア 星の橋店', 'refill', 3],
    ]);
    expect(rows.map(row => row.key)).toEqual(['photo-1:0', 'photo-1:1', 'photo-1:2']);
    expect(rows.every(row => row.area === undefined && row.earlyMode === undefined && row.manualEarly === undefined)).toBe(true);
    expect(rows[0].rawText).toContain('3日以内に補充すると+10円');
    expect(rows.every(row => row.warnings.length === 0)).toBe(true);
  });

  it('normalizes full-width digits and Japanese date/time spacing while preserving the original OCR text', () => {
    const input = '完 了 時 間：２０２６ 年 ８ 月 ２０ 日 ９ 時 ４ 分 ７ 秒\n店舗名：架空ストア 丘の上店\n取 出：２ 本';
    const [row] = parseJobScreenshotText(input);
    expect(row).toMatchObject({ date, time: '09:04:07', type: 'pickup', quantity: 2, storeName: '架空ストア 丘の上店', rawText: input });
  });

  it('accepts slash dates, weekday markers and wrapped time and operation counts', () => {
    const [row] = parseJobScreenshotText('完了日時: 2026 / 8 / 20 (木)\n09 : 04 : 07\n架空マート\n草原店\n補 充:\n4 本');
    expect(row).toMatchObject({ date, time: '09:04:07', type: 'refill', quantity: 4, storeName: '架空マート 草原店' });
  });

  it.each(['© 取出:1本 報酬 (概算) : YO', '& 取出: 1 本 報酬 (概算) :\\0', '取出:1本概算70円'])('reads a structured count before a same-line reward display: %s', operation => {
    const [row] = parseJobScreenshotText(`完了時間: ${date} 10:20:30\n架空ストア 海辺店 >\n${operation}`);
    expect(row).toMatchObject({ type: 'pickup', quantity: 1, storeName: '架空ストア 海辺店', sourceId: `jobshot:${date}T10:20:30:pickup` });
    expect(row.warnings).toEqual([]);
  });

  it('reads a refill count with an icon and reward while ignoring early-bonus promotional prose', () => {
    const [row] = parseJobScreenshotText(`完了時間: ${date} 11:20:30\n架空ストア 海辺店\n取出しから3日以内の補充で単価+10円 !\n© 補充: 3 本 報酬 (概算) : \\180`);
    expect(row).toMatchObject({ type: 'refill', quantity: 3 });
    expect(row.earlyMode).toBeUndefined();
    expect(row.manualEarly).toBeUndefined();
    expect(row.area).toBeUndefined();
    const [prose] = parseJobScreenshotText(`完了時間: ${date} 11:20:30\n架空店\n取出 3本を補充すると報酬がもらえます`);
    expect(prose.quantity).toBeNull();
  });

  it.each(['めQ)', '[口', 'ま7', '(9)', 'o0'])('handles a short synthetic OCR icon fragment before an explicit operation and reward column: %s', prefix => {
    const [row] = parseJobScreenshotText(`完了時間: ${date} 08:15:29\n架空ストア 森の店\n${prefix} 補充: 4 本 報酬 (概算): 260円`);
    expect(row).toMatchObject({ type: 'refill', quantity: 4, sourceId: `jobshot:${date}T08:15:29:refill` });
    expect(row.warnings).toEqual([]);
    expect(row.earlyMode).toBeUndefined();
  });

  it.each([
    'めQ) 補充 4 本 報酬 260円',
    'めQ) 補充: 4 本を運ぶと報酬がもらえます',
    '取出した補充: 4 本 報酬 260円',
    'めQ) 補充: 本 報酬 260円',
    'めQ) 補充: 4 本',
    '説明文が長く続いた補充: 4 本 報酬 260円',
  ])('does not relax noisy-prefix parsing for prose or incomplete rows: %s', operation => {
    const [row] = parseJobScreenshotText(`完了時間: ${date} 08:15:29\n架空ストア 森の店\n${operation}`);
    expect(row.quantity).toBeNull();
    expect(row.warnings.length).toBeGreaterThan(0);
  });

  it('keeps a card with multiple noisy structured operation rows ambiguous', () => {
    const [row] = parseJobScreenshotText(`完了時間: ${date} 08:15:29\n架空ストア 森の店\nめQ) 取出: 1 本 報酬 0円\n[口 補充: 4 本 報酬 260円`);
    expect(row.type).toBeNull();
    expect(row.quantity).toBeNull();
  });

  it('does not use marketing prose to infer operation or eligibility', () => {
    const [row] = parseJobScreenshotText(`完了時間: ${date} 10:20:30\n架空マート 風の店\n取出した電池を補充すると3日以内で+10円\n報酬70円`);
    expect(row.type).toBeNull();
    expect(row.quantity).toBeNull();
    expect(row.area).toBeUndefined();
    expect(row.earlyMode).toBeUndefined();
    expect(row.warnings.length).toBeGreaterThan(0);
    expect(parseJobScreenshotText('取出したバッテリーを補充すると+10円')).toEqual([]);
  });

  it('ignores an 未完了 tab but never treats an 未完了時間 field as a completion date', () => {
    expect(parseJobScreenshotText(`未完了 完了\n完了時間: ${date} 10:20:30\n架空ストア 中央店\n取出:2本`)[0].date).toBe(date);
    const [pending] = parseJobScreenshotText(`未 完了 時間: ${date} 10:20:30\n架空ストア 中央店\n取出:2本`);
    expect(pending.date).toBe('');
    expect(pending.time).toBe('');
    expect(buildJobScreenshotRecords([pending], defaultSettings, [], today).records).toHaveLength(0);
  });

  it('does not invent the year or missing seconds', () => {
    const [yearMissing] = parseJobScreenshotText('完了時間: 8/20 10:20:30\n架空店\n取出:1本');
    const [secondsMissing] = parseJobScreenshotText(`完了時間: ${date} 10:20\n架空店\n補充:1本`);
    expect(yearMissing.date).toBe('');
    expect(secondsMissing.time).toBe('10:20');
    expect(yearMissing.sourceId).toBeUndefined();
    expect(secondsMissing.sourceId).toBeUndefined();
    expect(validateJobScreenshotCandidate(yearMissing, today).length).toBeGreaterThan(0);
    expect(validateJobScreenshotCandidate(secondsMissing, today)).toContain('完了時刻は秒を含む HH:mm:ss 形式で入力してください。');
  });

  it('retains cropped or ambiguous cards as candidates requiring correction', () => {
    const rows = parseJobScreenshotText(`完了時間: ${date} 10:20:30\n架空店\n取出:2本\n完了時間: ${date} 10:19:30\n別の架空店\n補充:`);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ type: 'refill', quantity: null });
    const [ambiguous] = parseJobScreenshotText(`完了時間: ${date} 10:20:30\n架空店\n取出:1本\n補充:2本`);
    expect(ambiguous.type).toBeNull();
    expect(ambiguous.quantity).toBeNull();
  });

  it('does not convert ambiguous O/l OCR characters into numeric values', () => {
    const [row] = parseJobScreenshotText('完了時問: 2026-08-2O 1O:20:30\n架空店\n取出:l本');
    expect(row.quantity).toBeNull();
    expect(validateJobScreenshotCandidate(row, today).length).toBeGreaterThan(0);
    expect(row.warnings).toContain('完了時間の見出しに読み取り誤りの可能性があります。');
  });

  it('returns no candidates for an empty image or unrelated text and bounds excessive OCR output', () => {
    expect(parseJobScreenshotText('')).toEqual([]);
    expect(parseJobScreenshotText('営業時間のお知らせ')).toEqual([]);
    expect(() => parseJobScreenshotText('x'.repeat(200001))).toThrow('文字数');
  });
});

describe('building reviewed screenshot records', () => {
  it('sorts by completion time and uses JST timestamps and deterministic IDs', () => {
    const result = buildJobScreenshotRecords(parseJobScreenshotText(fixture), defaultSettings, [], today);
    expect(result.errors).toEqual([]);
    expect(result.records.map(record => record.createdAt)).toEqual(['2026-08-20T00:24:18.000Z', '2026-08-20T13:28:16.000Z', '2026-08-20T13:31:42.000Z']);
    expect(result.records[0].id).toBe('jobshot:2026-08-20T09:24:18:refill');
    expect(result.records[0]).toMatchObject({ area: 'omitted', earlyMode: 'auto', note: '架空ストア 星の橋店' });
    expect(validateRecords(result.records)).toEqual(result.records);
  });

  it('excludes existing and same-batch duplicate completion seconds of the same operation', () => {
    const first = buildJobScreenshotRecords([candidate()], defaultSettings, [], today).records;
    const repeated = buildJobScreenshotRecords([candidate({ key: 'second-image:0', quantity: 9, storeName: '別の架空店' })], defaultSettings, first, today);
    expect(repeated.records).toEqual([]);
    expect(repeated.duplicates).toEqual(['second-image:0']);
    const batch = buildJobScreenshotRecords([candidate(), candidate({ key: 'image:1' })], defaultSettings, [], today);
    expect(batch.records).toHaveLength(1);
    expect(batch.duplicates).toEqual(['image:1']);
    expect(batch.warnings[0].message).toContain('重複候補');
  });

  it('permits different operation types or seconds without merging their quantities', () => {
    const rows = [candidate(), candidate({ key: 'refill', type: 'refill', quantity: 1 }), candidate({ key: 'next-second', time: '10:20:31', quantity: 3 })];
    const result = buildJobScreenshotRecords(rows, defaultSettings, [], today);
    expect(result.records).toHaveLength(3);
    expect(new Set(result.records.map(record => record.id)).size).toBe(3);
    expect(result.records.map(record => record.quantity)).toEqual([2, 1, 3]);
  });

  it('retains the original identity after date, time and operation corrections and excludes either image version', () => {
    const [original] = parseJobScreenshotText(`完了時間: ${date} 10:20:30\n架空ストア 北口店\n取出:2本`);
    const corrected = { ...original, date: '2026-08-19', time: '12:21:31', type: 'refill' as const };
    const saved = buildJobScreenshotRecords([corrected], defaultSettings, [], today).records;
    expect(saved[0]).toMatchObject({ id: `jobshot:${date}T10:20:30:pickup`, date: '2026-08-19', createdAt: '2026-08-19T03:21:31.000Z', type: 'refill' });
    const rereadOriginal = buildJobScreenshotRecords([original], defaultSettings, saved, today);
    expect(rereadOriginal.duplicates).toEqual([original.key]);
    const [newImage] = parseJobScreenshotText('完了時間: 2026-08-19 12:21:31\n架空ストア 北口店\n補充:2本', 'corrected-image');
    const rereadCorrected = buildJobScreenshotRecords([newImage], defaultSettings, saved, today);
    expect(rereadCorrected.duplicates).toEqual([newImage.key]);
    expect(rereadCorrected.records).toEqual([]);
  });

  it('detects original and corrected identity aliases within a single import batch', () => {
    const sourceId = `jobshot:${date}T10:20:30:pickup`;
    const corrected = candidate({ key: 'corrected', sourceId, time: '09:00:00', type: 'refill' });
    const original = candidate({ key: 'original', sourceId });
    const anotherImage = candidate({ key: 'new-image', time: '09:00:00', type: 'refill' });
    const result = buildJobScreenshotRecords([corrected, original, anotherImage], defaultSettings, [], today);
    expect(result.records).toHaveLength(1);
    expect(result.duplicates).toEqual(['new-image', 'original']);
  });

  it('uses the edited business date with the stored JST completion clock when detecting history edits', () => {
    const saved = buildJobScreenshotRecords([candidate({ time: '00:00:01' })], defaultSettings, [], today).records;
    const edited = { ...saved[0], date: '2026-08-19' };
    const result = buildJobScreenshotRecords([candidate({ key: 'edited-image', date: '2026-08-19', time: '00:00:01' })], defaultSettings, [edited], today);
    expect(result.duplicates).toEqual(['edited-image']);
  });

  it('generates identity from corrected values when the original timestamp was incomplete', () => {
    const [incomplete] = parseJobScreenshotText(`完了時間: ${date} 10:20\n架空店\n取出:1本`);
    const corrected = { ...incomplete, time: '10:20:31' };
    const result = buildJobScreenshotRecords([corrected], defaultSettings, [], today);
    expect(result.records[0].id).toBe(`jobshot:${date}T10:20:31:pickup`);
  });

  it('keeps completion dates independent from their previous UTC calendar dates', () => {
    const result = buildJobScreenshotRecords([candidate({ time: '00:00:01' })], defaultSettings, [], today);
    expect(result.records[0]).toMatchObject({ date, createdAt: '2026-08-19T15:00:01.000Z' });
  });

  it('uses edited area, early count and note without inferring them from source text', () => {
    const row = candidate({ type: 'refill', area: 'D', quantity: 4, earlyMode: 'manual', manualEarly: 2, note: '確認済みの合成メモ', rawText: '3日以内で+10円' });
    const result = buildJobScreenshotRecords([row], defaultSettings, [], today);
    expect(result.records[0]).toMatchObject({ area: 'D', earlyMode: 'manual', manualEarly: 2, note: '確認済みの合成メモ', snapshot: { regionRate: 70 } });
    const emptyNote = buildJobScreenshotRecords([candidate({ note: '' })], defaultSettings, [], today);
    expect(emptyNote.records[0].note).toBeUndefined();
  });

  it('retains the existing frozen week and tiers while applying current region and early settings', () => {
    const existing: WorkRecord = { id: 'earlier-import', type: 'refill', date: '2026-08-17', quantity: 1, area: 'A', earlyMode: 'manual', manualEarly: 0,
      createdAt: '2026-08-17T00:00:00Z', snapshot: createRewardSnapshot('2026-08-17', 'A', defaultSettings, []) };
    const changed: Settings = { ...defaultSettings, defaultArea: 'B', regionRates: { ...defaultSettings.regionRates, B: 90 }, earlyRate: 20,
      weekStartsOn: 0, thresholds: [{ count: 0, rate: 0 }, { count: 1, rate: 999 }] };
    const result = buildJobScreenshotRecords([candidate({ type: 'refill' })], changed, [existing], today);
    const record = result.records[0];
    expect(record.type).toBe('refill');
    if (record.type !== 'refill') throw new Error('Expected refill');
    expect(record.snapshot).toMatchObject({ weekStart: '2026-08-17', regionRate: 90, earlyRate: 20, thresholds: defaultSettings.thresholds });
    expect(validateRecords(result.records)).toEqual(result.records);
  });

  it('replays pickup before refill chronologically and preserves real inventory and automatic early counts', () => {
    const rows = [candidate({ key: 'later', type: 'refill', time: '12:30:01', quantity: 3 }), candidate({ key: 'earlier', time: '11:30:01', quantity: 5 })];
    const built = buildJobScreenshotRecords(rows, defaultSettings, [], today);
    const calculation = calculate(built.records, defaultSettings, '2026-08-17', today);
    expect(calculation.inventory.total).toBe(2);
    expect(calculation.earlyCount).toBe(3);
    expect(calculation.total).toBe(195);
    expect(calculation.errors).toEqual([]);
  });

  it('warns about possible same-day manual duplicates without deleting manually entered records', () => {
    const existing: WorkRecord[] = [{ id: 'manual-1', type: 'pickup', date, quantity: 2, createdAt: '2026-08-20T05:00:00Z' }];
    const before = JSON.stringify(existing);
    const result = buildJobScreenshotRecords([candidate()], defaultSettings, existing, today);
    expect(result.records).toHaveLength(1);
    expect(result.duplicates).toEqual([]);
    expect(result.warnings.some(issue => issue.message.includes('手入力'))).toBe(true);
    expect(JSON.stringify(existing)).toBe(before);
  });

  it('accepts corrected current values while keeping OCR warnings advisory', () => {
    const [uncertain] = parseJobScreenshotText('完了時間: 8/20 10:20\n架空店\n取出:l本');
    const corrected = { ...uncertain, date, time: '10:20:30', type: 'pickup' as const, quantity: 1 };
    const result = buildJobScreenshotRecords([corrected], defaultSettings, [], today);
    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it.each([
    { date: '2026-02-30' }, { date: '2026-08-22' }, { date: '0000-01-01' },
    { time: '24:00:00' }, { time: '23:60:00' }, { time: '23:59:60' }, { time: '12:30' },
    { quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { quantity: 100000 }, { quantity: null },
    { type: null }, { note: 'a'.repeat(2001) },
    { sourceId: 'manual-id' }, { sourceId: 'jobshot:2026-02-30T10:20:30:pickup' },
    { sourceId: 'jobshot:2026-08-20T24:00:00:pickup' }, { sourceId: 'jobshot:2026-08-20T10:20:30:adjustment' },
    { type: 'refill' as const, earlyMode: 'manual' as const, manualEarly: 3 },
  ])('rejects invalid reviewed values: %j', (patch) => {
    const result = buildJobScreenshotRecords([candidate(patch)], defaultSettings, [], today);
    expect(result.records).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('does not mutate candidate order, settings or earlier records during building', () => {
    const rows = [candidate({ key: 'late', time: '18:00:00' }), candidate({ key: 'early', type: 'refill', time: '09:00:00' })];
    const settings = structuredClone(defaultSettings);
    const before = JSON.stringify({ rows, settings });
    buildJobScreenshotRecords(rows, settings, [], today);
    expect(JSON.stringify({ rows, settings })).toBe(before);
  });
});
