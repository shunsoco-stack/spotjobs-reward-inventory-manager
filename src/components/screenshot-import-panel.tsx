'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { Check, ImagePlus, ShieldCheck, X } from 'lucide-react';
import { buildJobScreenshotRecords, parseJobScreenshotText, type JobScreenshotCandidate } from '@/lib/job-screenshot';
import { isValidDate, type Area, type WorkRecord } from '@/lib/core';
import type { AppData } from '@/lib/storage';
import { AREAS, dateLabel, money, typeLabel } from './ui';

type Draft = JobScreenshotCandidate & { selected: boolean; sourceName: string };
type SourceImage = { name: string; url: string };
const MAX_IMAGES = 5;
const MAX_CANDIDATES = 100;

export default function ScreenshotImportPanel({ data, today, onImport }: {
  data: AppData; today: string; onImport: (records: WorkRecord[]) => Promise<boolean>;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [sources, setSources] = useState<SourceImage[]>([]);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState({ label: '', value: 0 });
  const [messages, setMessages] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [hasRead, setHasRead] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const imageUrls = useRef<string[]>([]);
  const mounted = useRef(true);
  const selected = useMemo(() => drafts.filter(d => d.selected), [drafts]);
  const preview = useMemo(() => buildJobScreenshotRecords(selected, data.settings, data.records, today), [selected, data.settings, data.records, today]);
  const allPreview = useMemo(() => buildJobScreenshotRecords(drafts, data.settings, data.records, today), [drafts, data.settings, data.records, today]);
  const duplicates = new Set(preview.duplicates);
  const refillCount = preview.records.filter(r => r.type === 'refill').reduce((total, r) => total + r.quantity, 0);
  const pickupCount = preview.records.filter(r => r.type === 'pickup').reduce((total, r) => total + r.quantity, 0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; abort.current?.abort(); imageUrls.current.forEach(url => URL.revokeObjectURL(url)); };
  }, []);
  useEffect(() => { setConfirmed(false); }, [data.settings, data.records]);

  function update(key: string, patch: Partial<Draft>) {
    setConfirmed(false);
    setDrafts(current => current.map(d => d.key === key ? { ...d, ...patch } : d));
  }

  async function readImages(files: File[]) {
    if (!files.length || reading || saving) return;
    if (files.length > MAX_IMAGES) { setMessages([`一度に選べる画像は${MAX_IMAGES}枚までです。`]); return; }
    abort.current?.abort();
    const controller = new AbortController(); abort.current = controller;
    imageUrls.current.forEach(url => URL.revokeObjectURL(url)); imageUrls.current = [];
    setSources([]); setDrafts([]); setMessages([]); setConfirmed(false); setHasRead(false); setReading(true);
    const nextDrafts: Draft[] = [];
    const failures: string[] = [];
    try {
      const { recognizeScreenshot } = await import('@/lib/screenshot-ocr');
      for (let index = 0; index < files.length; index++) {
        if (controller.signal.aborted) break;
        const file = files[index];
        setProgress({ label: `${index + 1} / ${files.length}枚目を読み取り中`, value: index / files.length });
        try {
          const text = await recognizeScreenshot(file, {
            signal: controller.signal,
            onProgress: value => { if (mounted.current && !controller.signal.aborted) setProgress({ label: `${index + 1} / ${files.length}枚目 · ${value.status}`, value: (index + Math.max(0, Math.min(1, value.progress))) / files.length }); },
          });
          if (!mounted.current || controller.signal.aborted) break;
          const url = URL.createObjectURL(file); imageUrls.current.push(url);
          setSources(current => [...current, { name: file.name, url }]);
          const candidates = parseJobScreenshotText(text, `image-${index}`);
          if (!candidates.length) failures.push(`${file.name}：完了した補充・取出が見つかりませんでした。「完了時間」と本数がすべて写る画像を選んでください。`);
          const available = Math.max(0, MAX_CANDIDATES - nextDrafts.length);
          if (candidates.length > available) failures.push(`候補は一度に${MAX_CANDIDATES}件までです。残りは画像を分けて取り込んでください。`);
          nextDrafts.push(...candidates.slice(0, available).map(candidate => ({ ...candidate, area: data.lastArea, earlyMode: 'auto' as const, selected: true, sourceName: file.name })));
          setDrafts([...nextDrafts]);
        } catch (error) {
          if (controller.signal.aborted) break;
          failures.push(`${file.name}：${error instanceof Error ? error.message : '読み取れませんでした。画像を確認してください。'}`);
        }
      }
    } catch { failures.push('読み取り機能を開けませんでした。初回は通信に接続して、もう一度お試しください。'); }
    finally {
      if (mounted.current) {
        setReading(false); setHasRead(true);
        setMessages([...failures, ...(controller.signal.aborted ? ['読み取りを中止しました。読み取り済みの候補だけ確認できます。'] : [])]);
      }
    }
  }

  async function save() {
    if (saving || reading || !confirmed) return;
    const latest = buildJobScreenshotRecords(selected, data.settings, data.records, today);
    if (latest.errors.length || !latest.records.length) return;
    setSaving(true);
    try {
      const ok = await onImport(latest.records);
      if (!ok && mounted.current) setMessages(['保存できませんでした。候補はそのまま残っています。内容を確認して再度保存してください。']);
    } catch { if (mounted.current) setMessages(['保存できませんでした。候補はそのまま残っています。']); }
    finally { if (mounted.current) setSaving(false); }
  }

  return <div className="screenshot-import">
    <div className="screenshot-intro"><span className="round-icon"><ImagePlus size={24}/></span><div><h3>ジョブ履歴を、まとめて記録。</h3><p>スクリーンショットを選び、読み取った内容を確認して保存します。</p></div></div>
    <p className="screenshot-privacy"><ShieldCheck size={17}/>画像はこの端末内で読み取り、外部へ送信・保存しません。</p>
    <input ref={picker} hidden type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" multiple aria-label="ジョブ履歴のスクリーンショット" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void readImages(files); }}/>
    <button type="button" className="button button-secondary screenshot-pick" disabled={reading || saving} onClick={() => picker.current?.click()}><ImagePlus size={20}/>{hasRead ? '画像を選び直す' : 'スクリーンショットを選ぶ'}</button>
    <p className="field-hint">JPEG・PNG・WebP、1枚12MBまで、最大5枚。「完了」タブの日時・種類・本数が切れないように撮影してください。初回の読み取りには通信が必要です。</p>
    {reading && <div className="ocr-progress" role="status"><strong>{progress.label || '読み取りの準備中…'}</strong><progress max="1" value={progress.value}/><p className="field-hint">端末によって数十秒かかります。この画面を開いたままお待ちください。</p><button type="button" className="button button-secondary" onClick={() => abort.current?.abort()}><X size={18}/>読み取りを中止</button></div>}
    {messages.length > 0 && <div className="warning" role="alert"><div>{messages.map((message, i) => <p key={i}>{message}</p>)}</div></div>}
    {sources.length > 0 && <details className="screenshot-sources"><summary>元の画像と見比べる（{sources.length}枚）</summary><div>{sources.map(source => <figure key={source.url}><Image unoptimized src={source.url} alt="選択したジョブ履歴のスクリーンショット" width={600} height={1200}/><figcaption>{source.name}</figcaption></figure>)}</div></details>}
    {drafts.length > 0 && <>
      <div className="screenshot-review-heading"><div><h3>読み取り候補 · {drafts.length}件</h3><p>誤読があれば直接修正してください。</p></div><button type="button" className="text-button" disabled={reading || saving} onClick={() => { setConfirmed(false); setDrafts(current => current.map(d => ({ ...d, selected: !current.every(row => row.selected) }))); }}>{drafts.every(d => d.selected) ? 'すべて外す' : 'すべて選択'}</button></div>
      <div className="notice"><strong>地域・早期対象は確認が必要です</strong><p>画像の案内文や概算報酬からは判定しません。地域は前回の選択、早期対象は取出記録による自動判定が初期値です。報酬はアプリの現在の設定で計算します。</p></div>
      <div className="screenshot-candidates">{drafts.map((draft, index) => {
        const rowErrors = allPreview.errors.filter(error => error.key === draft.key);
        const rowWarnings = draft.selected ? preview.warnings.filter(warning => warning.key === draft.key) : [];
        const duplicate = duplicates.has(draft.key);
        const area = draft.area ?? data.settings.defaultArea;
        return <article key={draft.key} className={`screenshot-candidate ${draft.type ?? 'unknown'} ${duplicate ? 'duplicate' : ''}`} aria-label={`候補${index + 1}`}>
          <div className="candidate-heading"><label className="check-field"><input type="checkbox" checked={draft.selected} disabled={reading || saving} onChange={event => update(draft.key, { selected: event.target.checked })}/>{index + 1} · {draft.type ? typeLabel(draft.type) : '種類を確認'}</label>{duplicate && <span className="pill">重複のため除外</span>}</div>
          <fieldset disabled={reading || saving} className="candidate-fields">
            <div className="candidate-grid candidate-datetime"><label className="field">作業日<input type="date" max={today} value={draft.date} onChange={event => update(draft.key, { date: event.target.value })}/><span className="field-hint">{isValidDate(draft.date) ? dateLabel(draft.date) : '日付を確認してください'}</span></label><label className="field">完了時刻（時:分:秒）<input type="text" inputMode="numeric" autoComplete="off" maxLength={8} placeholder="例：10:20:30" value={draft.time} onFocus={event => event.target.select()} onChange={event => { const digits = event.target.value.replace(/[^0-9]/g, '').slice(0, 6); update(draft.key, { time: [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)].filter(Boolean).join(':') }); }}/><span className="field-hint">修正するときは、時・分・秒を6桁で入力</span></label></div>
            <div className="candidate-grid"><label className="field">作業の種類<select value={draft.type ?? ''} onChange={event => update(draft.key, { type: event.target.value as 'refill' | 'pickup' })}><option value="" disabled>選択してください</option><option value="refill">補充</option><option value="pickup">取出</option></select></label><label className="field">本数<input type="text" inputMode="numeric" pattern="[0-9]*" maxLength={5} value={draft.quantity ?? ''} onChange={event => { const value = event.target.value.replace(/[^0-9]/g, ''); update(draft.key, { quantity: value ? Number(value) : null }); }}/></label></div>
            <label className="field">店舗名<input type="text" maxLength={200} value={draft.storeName} onChange={event => update(draft.key, { storeName: event.target.value })}/><span className="field-hint">店舗名は記録のメモに保存します。</span></label>
            {draft.type === 'refill' && <><label className="field">補充した地域<select value={area} onChange={event => update(draft.key, { area: event.target.value as Area })}>{AREAS.map(id => <option value={id} key={id}>{data.settings.regionNames[id]} · {money(data.settings.regionRates[id])}円/本</option>)}</select><span className="field-hint">{data.settings.regionDescriptions[area]}</span></label><label className="field">早期補充<select value={draft.earlyMode === 'manual' ? 'manual' : 'auto'} onChange={event => update(draft.key, { earlyMode: event.target.value as 'auto' | 'manual', manualEarly: draft.manualEarly ?? 0 })}><option value="auto">取出記録から自動判定</option><option value="manual">対象本数を指定（対象外は0本）</option></select></label>{draft.earlyMode === 'manual' && <label className="field">早期対象の本数<input type="number" inputMode="numeric" min="0" max={draft.quantity ?? 0} step="1" value={draft.manualEarly ?? ''} onChange={event => update(draft.key, { manualEarly: event.target.value === '' ? undefined : Number(event.target.value) })}/></label>}</>}
          </fieldset>
          {duplicate && <p className="field-hint">同じ完了日時・種類の記録が保存済み、または今回の候補にあります。二重登録を防ぐため保存しません。</p>}
          {rowErrors.map((error, i) => <p key={i} className="form-error">{error.message}</p>)}
          {rowWarnings.map((warning, i) => <p key={i} className="warning-text">{warning.message}</p>)}
          <details className="candidate-raw"><summary>読み取った文字を確認</summary>{draft.warnings.map((warning, i) => <p key={i} className="warning-text">{warning}</p>)}<pre>{draft.rawText}</pre><small>{draft.sourceName}</small></details>
        </article>;
      })}</div>
      <div className="screenshot-save-summary"><strong>登録する記録 {preview.records.length}件</strong><span>補充 {refillCount}本 · 取出 {pickupCount}本</span>{preview.duplicates.length > 0 && <p>{preview.duplicates.length}件の重複は除外します。</p>}{preview.errors.length > 0 && <p className="form-error" role="alert">選択した候補のエラーを修正するか、その候補のチェックを外してください。</p>}<label className="check-field"><input type="checkbox" disabled={reading || saving || !preview.records.length || preview.errors.length > 0} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>日時・種類・本数・地域・早期対象と、重複の有無を確認しました</label><button type="button" className="button button-primary" disabled={reading || saving || !confirmed || !preview.records.length || preview.errors.length > 0} onClick={() => void save()}><Check size={20}/>{saving ? '保存中…' : `確認した${preview.records.length}件を保存`}</button><p className="field-hint">画像は保存せず、確認した記録だけを追加します。登録後は履歴で編集・削除できます。</p></div>
    </>}
  </div>;
}
