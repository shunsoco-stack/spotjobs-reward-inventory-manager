'use client';
import { useMemo, useState } from 'react';
import { parseCsv, previewCsvImport, suggestCsvMapping, type ColumnMapping } from '@/lib/csv';
import type { AppData } from '@/lib/storage';
import type { WorkRecord } from '@/lib/core';
import { dateLabel, typeLabel } from './ui';

export default function CsvImportPanel({ text, data, onImport }: { text: string; data: AppData; onImport: (records: WorkRecord[]) => Promise<boolean> }) {
  const parsed = useMemo(() => parseCsv(text), [text]);
  const [mapping, setMapping] = useState<ColumnMapping>(() => suggestCsvMapping(parsed.headers));
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => previewCsvImport(text, mapping, data.settings, data.records), [text, mapping, data.settings, data.records]);
  const fields: { id: keyof ColumnMapping; label: string; required?: boolean }[] = [{ id: 'date', label: '日付', required: true }, { id: 'type', label: '作業の種類' }, { id: 'quantity', label: '本数', required: true }, { id: 'area', label: '地域' }, { id: 'earlyCount', label: '早期対象本数' }, { id: 'note', label: 'メモ' }];
  return <div className="csv-import"><p>CSVの列を選び、取り込む内容を確認してください。</p><p className="field-hint">UTF-8形式・1行目に見出し。作業の省略は補充、地域の省略は設定値を使用します。通常CSVの報酬条件は現在の設定で保存されます。</p>{parsed.headers.includes('記録データ（JSON）') && <p className="notice">このアプリから出力したCSVです。単価履歴を含む「記録データ（JSON）」列を優先して復元します。他の列を手編集した場合は、元のCSVからJSON列を削除して取り込んでください。</p>}<div className="field-grid">{fields.map(f => <label className="field" key={f.id}>{f.label}{f.required && '（必須）'}<select value={mapping[f.id] ?? -1} onChange={e => setMapping({ ...mapping, [f.id]: Number(e.target.value) < 0 ? (f.required ? -1 : undefined) : Number(e.target.value) })}><option value={-1}>列を選択</option>{parsed.headers.map((h, i) => <option key={i} value={i}>{h || `列${i + 1}`}</option>)}</select></label>)}</div><h3>取り込みプレビュー · {preview.records.length}件</h3>{preview.errors.length > 0 && <div className="warning" role="alert"><div><strong>{preview.errors.length}件のエラーがあります</strong>{preview.errors.slice(0, 8).map((e, i) => <p key={i}>{e.row}行目：{e.message}</p>)}<p>元のCSVまたは列選択を修正してください。</p></div></div>}<div className="import-preview-list">{preview.records.slice(0, 20).map((r, i) => <div key={i}><span>{dateLabel(r.date)} · {typeLabel(r.type)}</span><strong>{r.quantity}本</strong><small>{r.area && data.settings.regionNames[r.area]}</small></div>)}</div>{preview.records.length > 20 && <p className="field-hint">先頭20件を表示しています。</p>}<p className="notice">既存の記録に追加します。上書きはしません。取り込み後の「元に戻す」で取消できます。</p><button className="button button-primary" disabled={busy || !preview.records.length || !!preview.errors.length} onClick={async () => { setBusy(true); await onImport(preview.records); setBusy(false); }}>{busy ? '取り込み中…' : `${preview.records.length}件を取り込む`}</button></div>;
}
