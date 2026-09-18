'use client';

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, Minus, Plus, ScanLine } from 'lucide-react';
import { calculate, createRewardSnapshot, isValidDate, type WorkRecord } from '@/lib/core';
import type { AppData } from '@/lib/storage';
import { AREAS, dateLabel, money, newRecordId, Sheet, typeLabel } from './ui';

interface Props { data: AppData; today: string; type: WorkRecord['type']; record?: WorkRecord; onSave: (record: WorkRecord) => Promise<boolean>; }
export default function RecordForm({ data, today, type, record, onSave }: Props) {
  const areaGuideId = useId();
  const [quantity, setQuantity] = useState(String(record?.quantity ?? (type === 'adjustment' ? '' : 1)));
  const [date, setDate] = useState(record?.date ?? today);
  const [area, setArea] = useState(record?.area ?? data.lastArea ?? data.settings.defaultArea);
  const [early, setEarly] = useState(record?.earlyMode === 'manual' ? 'count' : 'auto');
  const [manual, setManual] = useState(String(record?.manualEarly ?? 0));
  const [note, setNote] = useState(record?.note ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [applyConfirm, setApplyConfirm] = useState(false);
  const [applyStock, setApplyStock] = useState(record?.type === 'adjustment' && !!record.applied);
  const [createdAt] = useState(record?.createdAt ?? new Date().toISOString());
  const previousToday = useRef(today);
  const count = Number(quantity);
  const valid = quantity.trim() !== '' && Number.isSafeInteger(count) && count >= (type === 'adjustment' ? 0 : 1) && count <= 99999 && isValidDate(date) && date <= today;
  const existing = useMemo(() => data.records.filter(r => r.id !== record?.id), [data.records, record?.id]);
  const snapshot = useMemo(() => {
    if (record?.type === 'refill' && record.snapshot && date === record.date) {
      return { ...record.snapshot, regionRate: area === record.area ? record.snapshot.regionRate : data.settings.regionRates[area] };
    }
    return createRewardSnapshot(isValidDate(date) ? date : today, area, data.settings, existing);
  }, [record, date, area, data.settings, existing, today]);
  const candidate = useMemo<WorkRecord>(() => {
    const base = { id: record?.id ?? 'input-preview', date, quantity: valid ? count : 0, createdAt, note };
    if (type === 'refill') return { ...base, type, area, earlyMode: early === 'auto' ? 'auto' : 'manual', ...(early === 'auto' ? {} : { manualEarly: early === 'all' ? count : early === 'none' ? 0 : Number(manual) }), snapshot };
    if (type === 'adjustment') return { ...base, type, applied: applyStock, ...(record?.type === 'adjustment' && record.date === date && record.quantity === count && !!record.applied === applyStock ? { expectedStock: record.expectedStock, difference: record.difference } : {}) };
    return { ...base, type };
  }, [record, date, valid, count, createdAt, note, type, area, early, manual, snapshot, applyStock]);
  const preview = useMemo(() => calculate([...existing, candidate], data.settings, snapshot.weekStart, today), [existing, candidate, data.settings, snapshot.weekStart, today]);
  const own = preview.records.find(r => r.id === candidate.id);
  const before = useMemo(() => calculate(existing, data.settings, snapshot.weekStart, today), [existing, data.settings, snapshot.weekStart, today]);
  useEffect(() => { const previous = previousToday.current; if (!record) setDate(value => value === previous ? today : value); previousToday.current = today; }, [today, record]);

  async function save(applied: boolean) {
    setError('');
    if (!valid) { setError('日付と本数を確認してください。未来の日付は登録できません。'); return; }
    if (type === 'refill' && early === 'count' && (!manual.trim() || !Number.isSafeInteger(Number(manual)) || Number(manual) < 0 || Number(manual) > count)) { setError('早期対象は0本〜補充本数の範囲で入力してください。'); return; }
    setBusy(true);
    const preserveAudit = record?.type === 'adjustment' && record.date === date && record.quantity === count && record.applied === applied;
    const saved: WorkRecord = type === 'adjustment' ? { ...candidate, type: 'adjustment', applied, expectedStock: preserveAudit ? record.expectedStock ?? count - (own?.discrepancy ?? 0) : count - (own?.discrepancy ?? 0), difference: preserveAudit ? record.difference ?? own?.discrepancy ?? 0 : own?.discrepancy ?? 0 } : candidate;
    const ok = await onSave({ ...saved, id: record?.id ?? newRecordId() });
    setBusy(false);
    if (!ok) setError('保存できませんでした。入力内容はそのまま残っています。');
  }
  function submit(event: FormEvent) { event.preventDefault(); if (type === 'adjustment' && applyStock && valid) setApplyConfirm(true); else void save(false); }

  const Icon = type === 'refill' ? ArrowDownToLine : type === 'pickup' ? ArrowUpFromLine : ScanLine;
  return <form className={`record-form ${type}`} onSubmit={submit}>
    <div className="form-intro"><span className={`round-icon ${type}`}><Icon size={24}/></span><div><h2>{record ? `${typeLabel(type)}の記録を編集` : type === 'adjustment' ? '手元の本数を確認' : `${typeLabel(type)}を記録`}</h2><p>{type === 'refill' ? '本数を入れたら、そのまま保存。' : type === 'pickup' ? '取り出した本数を在庫に追加します。' : '実際に数えた本数を入力してください。'}</p></div></div>
    <label className="field date-field">作業日 <span>{isValidDate(date) && dateLabel(date)}</span><input type="date" value={date} max={today} required onChange={e => setDate(e.target.value)}/></label>
    <label className="quantity-label" htmlFor="record-quantity">{type === 'adjustment' ? '実棚卸数' : `${typeLabel(type)}本数`}</label>
    <div className="quantity-stepper"><button type="button" className="step-button" aria-label="本数を1減らす" disabled={!count || count <= (type === 'adjustment' ? 0 : 1)} onClick={() => setQuantity(String(Math.max(type === 'adjustment' ? 0 : 1, count - 1)))}><Minus/></button><div><input id="record-quantity" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={5} value={quantity} onFocus={e => e.target.select()} onChange={e => setQuantity(e.target.value.replace(/[^0-9]/g, ''))} required aria-label="本数"/><span>本</span></div><button type="button" className="step-button" aria-label="本数を1増やす" disabled={count >= 99999} onClick={() => setQuantity(String(Math.min(99999, count + 1)))}><Plus/></button></div>
    <div className="quick-amounts" aria-label="本数を加算">{[1, 2, 3, 5, 10].map(n => <button type="button" key={n} onClick={() => setQuantity(String(Math.min(99999, count + n)))}>+{n}</button>)}</div>
    {type === 'refill' && <>
      <fieldset className="area-field">
        <legend>補充した地域</legend>
        <div className="area-options">{AREAS.map(id => <button key={id} type="button" aria-pressed={area === id} aria-describedby={`${areaGuideId}-${id}`} className={area === id ? 'selected' : ''} onClick={() => setArea(id)}><strong>{data.settings.regionNames[id]}</strong><span>{data.settings.regionRates[id]}円</span></button>)}</div>
        <div className="area-guide">
          <p className="area-guide-title">地域の目安</p>
          <dl aria-label="地域ごとの説明">{AREAS.map(id => <div key={id} className={area === id ? 'selected' : ''}>
            <dt>{data.settings.regionNames[id]}</dt><dd id={`${areaGuideId}-${id}`}>{data.settings.regionDescriptions[id]}</dd>
          </div>)}</dl>
          <p className="field-hint">補充した場所に合わせて選んでください。「{data.settings.regionNames.omitted}」は地域を指定しないときの単価です。区分・説明・単価は設定で変更できます。</p>
        </div>
      </fieldset>
      <fieldset className="early-field"><legend>早期補充</legend><div className="segmented early-options">{[['auto', '自動判定'], ['all', 'すべて対象'], ['none', '対象外'], ['count', '本数指定']].map(([id, label]) => <button key={id} type="button" aria-pressed={early === id} className={early === id ? 'selected' : ''} onClick={() => setEarly(id)}>{label}</button>)}</div>{early === 'count' && <label className="field">早期対象の本数<input type="number" inputMode="numeric" min="0" max={count} step="1" value={manual} onChange={e => setManual(e.target.value)}/></label>}<p className="field-hint">{early === 'auto' ? `取出日を含む${snapshot.earlyDays}日以内の在庫から自動判定。取出日が不明な分は対象外です。` : `公式の作業条件を確認し、対象本数を指定します。＋${snapshot.earlyRate}円/本。`}</p></fieldset>
    </>}
    {type === 'adjustment' && <div className="stocktake-preview"><div><span>記録上の在庫</span><strong>{valid ? money(count - (own?.discrepancy ?? 0)) : '—'} 本</strong></div><div><span>棚卸差異</span><strong className={own?.discrepancy ? 'warning-text' : ''}>{valid ? `${(own?.discrepancy ?? 0) > 0 ? '+' : ''}${own?.discrepancy ?? 0}` : '—'} 本</strong></div><label className="check-field"><input type="checkbox" checked={applyStock} onChange={e => setApplyStock(e.target.checked)}/>棚卸数を在庫に反映する</label><p className="field-hint">オフなら確認記録だけを保存します。在庫への反映は次の確認画面で確定します。</p></div>}
    <details className="form-details" open={!!record?.note}><summary>メモを追加 <ChevronDown size={18}/></summary><label className="field">メモ（任意）<textarea value={note} maxLength={2000} rows={2} onChange={e => setNote(e.target.value)} placeholder="例：駅前の店舗、在庫確認など"/></label></details>
    {record?.type === 'refill' && record.snapshot && <p className="field-hint">元の適用単価：{record.snapshot.regionRate}円/本。日付・地域を変えない編集では単価を保持します。</p>}
    {valid && own && <div className="entry-estimate"><div><span>{type === 'refill' ? 'この登録による週間報酬の増分' : '登録後の在庫'}</span><strong>{type === 'refill' ? `＋¥${money(preview.total - before.total)}` : `${money(own.stockAfter)} 本`}</strong></div>{type === 'refill' && <small>早期対象 {own.earlyCount}本 · 到達ボーナス ＋{preview.countRate}円/本</small>}{own.errors.map((message, i) => <p className="warning-text" key={i}>{message}</p>)}</div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <button disabled={busy || !valid} type="submit" className={`button button-primary save-record ${type}`}><Check size={21}/>{busy ? '保存中…' : record ? '変更を保存' : `${valid ? count : '—'}本を${typeLabel(type)}として保存`}</button>
    {applyConfirm && <Sheet title="棚卸数を在庫に反映しますか？" onClose={() => setApplyConfirm(false)}><p>在庫を <strong>{money(count - (own?.discrepancy ?? 0))}本 → {money(count)}本</strong> に修正します。</p><p className="muted">差異 {(own?.discrepancy ?? 0) > 0 ? '+' : ''}{own?.discrepancy ?? 0}本は履歴に残ります。</p><div className="dialog-actions"><button type="button" className="button button-secondary" onClick={() => setApplyConfirm(false)}>戻る</button><button type="button" className="button button-primary adjustment" disabled={busy} onClick={() => { setApplyConfirm(false); void save(true); }}>確認して反映する</button></div></Sheet>}
  </form>;
}
