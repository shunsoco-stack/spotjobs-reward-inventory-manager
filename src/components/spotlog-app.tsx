'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { ArrowDownToLine, ArrowLeft, ArrowUpFromLine, Battery, Check, ChevronRight, Download, ExternalLink, History, House, ImagePlus, RotateCcw, ScanLine, Settings2, Share2, ShieldCheck, Smartphone, TrendingUp, Trash2, WifiOff, X } from 'lucide-react';
import { addDays, adjacentWeekStart, calculate, createDemoRecords, createRewardSnapshot, defaultSettings, todayLocal, type WorkRecord } from '@/lib/core';
import { exportCsv, inspectBackup, loadData, saveData, serializeBackup, MAX_BACKUP_BYTES, type AppData } from '@/lib/storage';
import SettingsPanel from './settings-panel';
import RecordForm from './record-form';
import CsvImportPanel from './csv-import-panel';
import ScreenshotImportPanel from './screenshot-import-panel';
import SharePanel from './share-panel';
import { parseCsv } from '@/lib/csv';
import { dateLabel, Sheet, typeLabel } from './ui';
import { HistoryView, HomeView, InventoryView, SimulatorView, WeeklyView, type View } from './work-views';

const emptyData = (): AppData => ({ version: 2, records: [], settings: structuredClone(defaultSettings), lastArea: defaultSettings.defaultArea });
type Notice = { text: string; error?: boolean } | null;
interface InstallEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
const titles: Record<View, string> = { home: 'ホーム', refill: '補充入力', pickup: '取出入力', history: '履歴', settings: '設定', inventory: '在庫・棚卸', weekly: '週次報酬', simulator: '報酬シミュレーター' };
const nav = [{ id: 'home', label: 'ホーム', icon: House }, { id: 'refill', label: '補充', icon: ArrowDownToLine }, { id: 'pickup', label: '取出', icon: ArrowUpFromLine }, { id: 'history', label: '履歴', icon: History }, { id: 'settings', label: '設定', icon: Settings2 }] as const;

function Brand() { return <div className="brand"><span className="app-mark" aria-hidden="true"><Image src="/icon.svg" width={42} height={42} alt="" priority/></span><span>SPOTJOBS<small>報酬・在庫管理アプリ</small></span></div>; }

export default function SpotlogApp() {
  const [personal, setPersonal] = useState<AppData>(emptyData);
  const [sample, setSample] = useState<AppData>(emptyData);
  const [demo, setDemo] = useState(false);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [today, setToday] = useState('2026-01-01');
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);
  const [view, setView] = useState<View>('home');
  const [notice, setNotice] = useState<Notice>(null);
  const [undo, setUndo] = useState<AppData | null>(null);
  const [editing, setEditing] = useState<WorkRecord | null>(null);
  const [stocktaking, setStocktaking] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [backup, setBackup] = useState<ReturnType<typeof inspectBackup> | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [screenshotImport, setScreenshotImport] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [entryVersion, setEntryVersion] = useState(0);
  const [online, setOnline] = useState(true);
  const [offlineReady, setOfflineReady] = useState(false);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const savingRef = useRef(false);
  const personalRef = useRef(personal);
  const persistedRef = useRef<AppData | null>(null);
  const data = demo ? sample : personal;
  const currentWeek = useMemo(() => createRewardSnapshot(today, data.settings.defaultArea, data.settings, data.records).weekStart, [today, data]);
  const week = selectedWeek ?? currentWeek;
  const summary = useMemo(() => calculate(data.records, data.settings, week, today), [data, week, today]);
  const currentWeekSummary = useMemo(() => !shareOpen || week === currentWeek ? summary : calculate(data.records, data.settings, currentWeek, today), [shareOpen, week, currentWeek, summary, data, today]);

  useEffect(() => {
    let active = true;
    const date = todayLocal(); setToday(date); setSample({ ...emptyData(), records: createDemoRecords(date) });
    void loadData().then(stored => { if (active && stored) { setPersonal(stored); personalRef.current = stored; persistedRef.current = stored; } }).catch(error => { if (active) setStorageError(error instanceof Error ? error.message : '保存データを開けませんでした。'); }).finally(() => { if (active) setReady(true); });
    const refreshDate = () => setToday(todayLocal());
    const timer = window.setInterval(refreshDate, 30000);
    const network = () => setOnline(navigator.onLine); network();
    const installPrompt = (event: Event) => { event.preventDefault(); setInstall(event as InstallEvent); };
    window.addEventListener('online', network); window.addEventListener('offline', network);
    window.addEventListener('focus', refreshDate); window.addEventListener('beforeinstallprompt', installPrompt);
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => { if (active) setOfflineReady(true); }).catch(() => { if (active) setOfflineReady(false); });
    }
    const sync = async () => {
      if (savingRef.current) return;
      try { const stored = await loadData(); if (active && stored && JSON.stringify(stored) !== JSON.stringify(personalRef.current)) { personalRef.current = stored; persistedRef.current = stored; setPersonal(stored); setUndo(null); setNotice({ text: '別の画面で保存された記録を反映しました' }); } } catch { /* The next explicit save/load displays the storage failure. */ }
    };
    if ('BroadcastChannel' in window) { channel.current = new BroadcastChannel('spotjobs-data'); channel.current.onmessage = () => { void sync(); }; }
    window.addEventListener('focus', sync);
    return () => { active = false; clearInterval(timer); channel.current?.close(); window.removeEventListener('online', network); window.removeEventListener('offline', network); window.removeEventListener('focus', refreshDate); window.removeEventListener('focus', sync); window.removeEventListener('beforeinstallprompt', installPrompt); };
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = data.settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : data.settings.theme; };
    apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [data.settings.theme]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => { setNotice(null); setUndo(null); }, 8000); return () => clearTimeout(timer); }, [notice]);

  async function commit(next: AppData, message: string, keepUndo = true, restore = false): Promise<boolean> {
    if (savingRef.current) return false;
    if (!demo && storageError && !restore) { setNotice({ text: '保存データを開けないため、設定からバックアップを復元してください。', error: true }); return false; }
    savingRef.current = true; setSaving(true);
    try {
      if (demo) setSample(next);
      else {
        await saveData(next, restore && storageError ? undefined : { expected: persistedRef.current });
        personalRef.current = next; persistedRef.current = next; setPersonal(next); setStorageError('');
        channel.current?.postMessage('saved');
      }
      setUndo(keepUndo ? data : null); setNotice({ text: `${message}${demo ? '（デモ）' : ''}` }); return true;
    } catch (error) {
      if (!demo) { try { const latest = await loadData(); if (latest) { personalRef.current = latest; persistedRef.current = latest; setPersonal(latest); } } catch { /* Preserve the original failure and draft. */ } }
      setNotice({ text: error instanceof Error ? error.message : '保存できませんでした。空き容量とブラウザの設定を確認してください。', error: true }); return false;
    }
    finally { savingRef.current = false; setSaving(false); }
  }
  async function saveRecord(record: WorkRecord) {
    const exists = data.records.some(r => r.id === record.id);
    const records = exists ? data.records.map(r => r.id === record.id ? record : r) : [...data.records, record];
    const ok = await commit({ ...data, records, lastArea: record.area ?? data.lastArea }, exists ? '記録を更新しました' : `${record.quantity}本を${typeLabel(record.type)}として登録しました`);
    if (ok) { setEditing(null); setStocktaking(false); setEntryVersion(v => v + 1); }
    return ok;
  }
  function changeView(next: View) { setView(next); window.scrollTo({ top: 0, behavior: 'instant' }); }
  function changeWeek(next: string) { setSelectedWeek(next === currentWeek ? null : next === addDays(week, -7) ? adjacentWeekStart(week, -1, data.records, data.settings) : next === addDays(week, 7) ? adjacentWeekStart(week, 1, data.records, data.settings) : next); }
  function switchDemo(next: boolean) { setDemo(next); setUndo(null); setNotice({ text: next ? 'デモデータを表示しています。自分の記録には影響しません。' : '自分の記録に戻りました' }); setSelectedWeek(null); changeView('home'); }
  function download(content: string, filename: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.hidden = true; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    setNotice({ text: 'ファイルを作成しました。ダウンロード先を確認してください。' });
  }
  function exportFile(csv = false) {
    try { download(csv ? exportCsv(data.records, data.settings) : serializeBackup(data), `spotjobs-${csv ? 'records' : 'backup'}-${today}${demo ? '-demo' : ''}.${csv ? 'csv' : 'json'}`, csv ? 'text/csv;charset=utf-8' : 'application/json'); }
    catch (e) { setNotice({ text: e instanceof Error ? e.message : '出力できませんでした。', error: true }); }
  }
  async function readFile(file: File | undefined, csv = false) {
    if (!file) return;
    try { if (file.size > MAX_BACKUP_BYTES) throw new Error('ファイルサイズが上限を超えています。'); const text = await file.text(); if (csv) { parseCsv(text); setCsvText(text); } else setBackup(inspectBackup(text)); }
    catch (e) { setNotice({ text: e instanceof Error ? e.message : 'ファイルを読み込めません。', error: true }); }
    if (fileRef.current) fileRef.current.value = ''; if (csvRef.current) csvRef.current.value = '';
  }

  if (!ready) return <div className="loading-screen"><Brand/><p>記録を開いています…</p></div>;
  return <div className="app-shell">
    <aside className="desktop-sidebar"><Brand/><p className="sidebar-caption">日々の活動を、手のひらで。</p><nav aria-label="メインナビゲーション">{nav.map(n => <button key={n.id} aria-current={view === n.id ? 'page' : undefined} className={`${view === n.id ? 'active' : ''} ${n.id}`} onClick={() => changeView(n.id)}><n.icon size={21}/>{n.label}</button>)}<div className="nav-divider"/>{[{ id: 'inventory' as const, label: '在庫・棚卸', icon: Battery }, { id: 'weekly' as const, label: '週次報酬', icon: History }, { id: 'simulator' as const, label: 'シミュレーター', icon: TrendingUp }].map(n => <button key={n.id} className={`${view === n.id ? 'active' : ''} ${n.id}`} onClick={() => changeView(n.id)}><n.icon size={21}/>{n.label}</button>)}</nav><div className="sidebar-bottom"><ShieldCheck size={23}/><strong>記録はこの端末に。</strong><p>ログイン不要。<br/>電波がなくても、いつも通り。</p><span className="pill">個人制作・非公式ツール</span></div></aside>
    <div className="main-shell"><header className="app-header"><div className="mobile-brand"><Brand/></div><span className="desktop-header">SPOTJOBSワーカーのための管理ツール</span><div className="header-actions"><span className={`connection-status ${!online ? 'offline' : ''}`}>{online ? <ShieldCheck size={16}/> : <WifiOff size={16}/>}<span>{!online ? 'オフライン' : saving ? '保存中' : '端末に保存'}</span></span><a className="official-service-link" href="https://app.spot.jobs/" target="_blank" rel="noopener noreferrer external" aria-label="SPOTJOBSを開く（外部ブラウザ・別タブ）" title="SPOTJOBSを外部ブラウザで開く"><span>SPOTJOBSを開く</span><ExternalLink size={16} aria-hidden="true"/></a></div></header>
      <main id="main-content">
        {demo && <div className="demo-banner"><div><strong>デモデータでお試し中</strong><span>自分の記録には影響しません</span></div><button onClick={() => switchDemo(false)}>終了<X size={17}/></button></div>}
        {storageError && <div className="warning" role="alert"><div><strong>保存データを開けませんでした</strong><p>{storageError}</p><button className="text-button" onClick={() => changeView('settings')}>設定からバックアップを復元</button></div></div>}
        <div className="page-heading"><div>{['inventory', 'weekly', 'simulator'].includes(view) && <button className="text-button back-link" onClick={() => changeView('home')}><ArrowLeft size={17}/>ホーム</button>}<h1>{titles[view]}</h1></div><span>{dateLabel(today)}</span></div>
        {view === 'home' && <><HomeView summary={summary} settings={data.settings} today={today} week={week} currentWeek={currentWeek} onWeek={changeWeek} onView={changeView} onDemo={() => switchDemo(true)} empty={!data.records.length}/><div className="home-tools"><button onClick={() => changeView('inventory')}><ScanLine size={21}/>在庫・棚卸<ChevronRight size={18}/></button><button onClick={() => changeView('simulator')}><TrendingUp size={21}/>報酬シミュレーター<ChevronRight size={18}/></button><button className="screenshot-home-action" onClick={() => setScreenshotImport(true)}><ImagePlus size={21}/>スクショから取り込む<ChevronRight size={18}/></button><button className="share-home-action" onClick={() => setShareOpen(true)}><Share2 size={21}/>成績をXで共有<ChevronRight size={18}/></button></div></>}
        {(view === 'refill' || view === 'pickup') && <div className="entry-layout"><section className="panel entry-panel"><button className="button button-secondary screenshot-entry-action" onClick={() => setScreenshotImport(true)}><ImagePlus size={19}/>スクショから取り込む</button><RecordForm key={`${view}-${demo}-${entryVersion}`} data={data} today={today} type={view} onSave={saveRecord}/></section><aside className="entry-side"><div className="panel"><Battery size={26}/><h2>いまの手元在庫</h2><strong className="side-number">{summary.inventory.total}<small>本</small></strong><p>早期対象の見込み {summary.inventory.eligibleCount}本</p><button className="text-button" onClick={() => changeView('inventory')}>在庫の内訳を見る<ChevronRight size={17}/></button></div><p className="muted">{view === 'refill' ? '取出を先に記録すると、早期補充を自動判定できます。' : '取出時には報酬は発生しません。補充を記録すると報酬が加算されます。'}</p></aside></div>}
        {view === 'weekly' && <WeeklyView summary={summary} settings={data.settings} today={today} week={week} currentWeek={currentWeek} onWeek={changeWeek}/>}
        {view === 'inventory' && <InventoryView summary={summary} settings={data.settings} today={today} onStocktake={() => setStocktaking(true)} onEdit={setEditing}/>}
        {view === 'simulator' && <SimulatorView summary={summary} settings={data.settings} today={today}/>}
        {view === 'history' && <><button className="button button-secondary screenshot-entry-action" onClick={() => setScreenshotImport(true)}><ImagePlus size={19}/>スクショから取り込む</button><HistoryView summary={summary} settings={data.settings} today={today} onEdit={setEditing}/></>}
        {view === 'settings' && <><section className="panel pwa-panel"><div className="section-heading"><Smartphone size={23}/><h2>ホーム画面で、すぐ使える</h2></div><p>{offlineReady ? 'オフラインで使う準備ができています。' : '初回はインターネットに接続して開いてください。'}</p>{install && <button className="button button-primary" onClick={async () => { await install.prompt(); await install.userChoice; setInstall(null); }}><Download size={18}/>アプリをインストール</button>}<p className="field-hint">iPhone：Safariの共有 → ホーム画面に追加。Android：Chromeのメニュー → アプリをインストール。オフラインでも入力・履歴・計算を利用できます。</p></section><SettingsPanel key={`${demo}-${JSON.stringify(data.settings)}`} settings={data.settings} demo={demo} onSave={async settings => { const ok = await commit({ ...data, settings, lastArea: settings.defaultArea !== data.settings.defaultArea ? settings.defaultArea : data.lastArea }, '設定を保存しました'); if (!ok) throw new Error('設定を保存できませんでした。'); }} onBackup={() => exportFile()} onImport={() => fileRef.current?.click()} onCsv={() => exportFile(true)} onCsvImport={() => csvRef.current?.click()} onDemo={() => switchDemo(!demo)}/></>}
        <footer className="app-footer"><p>個人制作の非公式管理ツールです。<br className="mobile-only"/>公式サービスとは関係ありません。</p><p>報酬は個人設定に基づく見込みです。確定額・適用条件は公式サービスで確認してください。</p></footer>
      </main>
    </div>
    <nav className="bottom-nav" aria-label="モバイルナビゲーション">{nav.map(n => <button key={n.id} aria-current={view === n.id ? 'page' : undefined} className={`${view === n.id ? 'active' : ''} ${n.id}`} onClick={() => changeView(n.id)}><span><n.icon size={23}/></span>{n.label}</button>)}</nav>
    {(editing || stocktaking) && <Sheet title={editing ? '記録を編集' : '棚卸'} onClose={() => { setEditing(null); setStocktaking(false); setDeleteConfirm(false); }}><RecordForm data={data} today={today} type={editing?.type ?? 'adjustment'} record={editing ?? undefined} onSave={saveRecord}/>{editing && <div className="delete-section">{deleteConfirm ? <><p>この{typeLabel(editing.type)}記録（{editing.quantity}本）を削除しますか？<br/>在庫・報酬は再計算されます。</p><div className="dialog-actions"><button className="button button-secondary" onClick={() => setDeleteConfirm(false)}>キャンセル</button><button className="button button-danger" disabled={saving} onClick={async () => { const ok = await commit({ ...data, records: data.records.filter(r => r.id !== editing.id) }, '記録を削除しました'); if (ok) { setEditing(null); setDeleteConfirm(false); } }}>削除する</button></div></> : <button className="text-button danger" onClick={() => setDeleteConfirm(true)}><Trash2 size={18}/>この記録を削除</button>}</div>}</Sheet>}
    {backup && <Sheet title="バックアップを復元" onClose={() => setBackup(null)}><p>以下のバックアップを確認してください。</p><dl className="breakdown-list"><div><dt>作成日時</dt><dd>{backup.exportedAt ? new Date(backup.exportedAt).toLocaleString('ja-JP') : '旧形式のため不明'}</dd></div><div><dt>記録数</dt><dd>{backup.recordCount}件</dd></div><div><dt>対象期間</dt><dd>{backup.startDate ? `${backup.startDate} 〜 ${backup.endDate}` : '記録なし'}</dd></div></dl><div className="warning"><div><strong>現在の{demo ? 'デモ' : '端末'}データを上書きします</strong><p>{data.records.length}件の記録と設定が置き換わります。必要な場合は先にバックアップしてください。</p></div></div><button className="button button-secondary" onClick={() => exportFile()}><Download size={18}/>現在のデータをバックアップ</button><div className="dialog-actions"><button className="button button-secondary" onClick={() => setBackup(null)}>キャンセル</button><button className="button button-primary" disabled={saving} onClick={async () => { const ok = await commit(backup.data, 'バックアップを復元しました', true, true); if (ok) { setBackup(null); setSelectedWeek(null); } }}>確認して上書き復元</button></div></Sheet>}
    {csvText !== null && <Sheet wide title="CSVから記録を取り込む" onClose={() => setCsvText(null)}><CsvImportPanel text={csvText} data={data} onImport={async records => { const ok = await commit({ ...data, records: [...data.records, ...records] }, `${records.length}件を取り込みました`); if (ok) setCsvText(null); return ok; }}/></Sheet>}
    {screenshotImport && <Sheet wide title="スクショから取り込む" onClose={() => { if (!saving) setScreenshotImport(false); }}><ScreenshotImportPanel data={data} today={today} onImport={async records => { const ok = await commit({ ...data, records: [...data.records, ...records] }, `${records.length}件をスクショから登録しました`); if (ok) { setScreenshotImport(false); changeView('history'); } return ok; }}/></Sheet>}
    {shareOpen && <Sheet title="成績をXで共有" onClose={() => setShareOpen(false)}><SharePanel todaySummary={currentWeekSummary} weekSummary={summary} today={today} demo={demo} online={online}/></Sheet>}
    <input ref={fileRef} hidden type="file" accept=".json,application/json" aria-label="JSONバックアップファイル" onChange={e => { void readFile(e.target.files?.[0]); }}/><input ref={csvRef} hidden type="file" accept=".csv,text/csv" aria-label="CSVファイル" onChange={e => { void readFile(e.target.files?.[0], true); }}/>
    {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{!notice.error && <Check size={19}/>}<span>{notice.text}</span></span>{undo && !notice.error && <button disabled={saving} onClick={async () => { await commit(undo, '操作を元に戻しました', false); }}><RotateCcw size={16}/>元に戻す</button>}<button className="toast-close" aria-label="通知を閉じる" onClick={() => { setNotice(null); setUndo(null); }}><X size={18}/></button></div>}
  </div>;
}

