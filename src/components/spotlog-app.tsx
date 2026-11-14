'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowDownToLine, ArrowLeft, ArrowUpFromLine, Battery, Check, ChevronRight, Download, ExternalLink, History, House, ImagePlus, RotateCcw, ScanLine, Settings2, ShieldCheck, Smartphone, TrendingUp, Trash2, WifiOff, X } from 'lucide-react';
import { addDays, adjacentWeekStart, calculate, createDemoRecords, createRewardSnapshot, defaultSettings, todayLocal, type WorkRecord } from '@/lib/core';
import { exportCsv, inspectBackup, loadData, saveData, serializeBackup, MAX_BACKUP_BYTES, type AppData } from '@/lib/storage';
import SettingsPanel from './settings-panel';
import RecordForm from './record-form';
import CsvImportPanel from './csv-import-panel';
import ScreenshotImportPanel from './screenshot-import-panel';
import SharePanel from './share-panel';
import SyncPanel, { type SyncImportMode } from './sync-panel';
import HomeSyncAction, { type SyncPhase } from './sync-action';
import { parseCsv } from '@/lib/csv';
import { exportTextFile, isNativeRuntime, openExternalUrl } from '@/lib/native-runtime';
import {
  clearSyncPreferences,
  deleteRemoteSpotJobsSnapshot,
  loadSyncPreferences,
  markSyncedRecordReviewed,
  removeRecordWithSyncTombstone,
  requestPcRefresh,
  saveSyncPreferences,
  SYNC_PREFERENCES_KEY,
  syncFromBridge,
  type SyncLocalPreferences,
} from '@/lib/sync';
import { consumeSyncPairingFragment } from '@/lib/sync/pairing-link';
import { dateLabel, KineticGlyphs, Sheet, typeLabel } from './ui';
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
  const [inventoryEditing, setInventoryEditing] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [backup, setBackup] = useState<ReturnType<typeof inspectBackup> | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [screenshotImport, setScreenshotImport] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [entryVersion, setEntryVersion] = useState(0);
  const [online, setOnline] = useState(true);
  const [offlineReady, setOfflineReady] = useState(false);
  const [nativeRuntime, setNativeRuntime] = useState(false);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncPhase, setSyncPhase] = useState<SyncPhase>('pulling');
  const [syncReady, setSyncReady] = useState(false);
  const [syncPreferences, setSyncPreferences] = useState<SyncLocalPreferences>({ enabled: false });
  const [incomingSyncCode, setIncomingSyncCode] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const savingRef = useRef(false);
  const syncingRef = useRef(false);
  const syncAbortRef = useRef<AbortController | null>(null);
  const syncPreferencesRef = useRef<SyncLocalPreferences>({ enabled: false });
  const personalRef = useRef(personal);
  const persistedRef = useRef<AppData | null>(null);
  const data = demo ? sample : personal;
  const currentWeek = useMemo(() => createRewardSnapshot(today, data.settings.defaultArea, data.settings, data.records).weekStart, [today, data]);
  const week = selectedWeek ?? currentWeek;
  const summary = useMemo(() => calculate(data.records, data.settings, week, today), [data, week, today]);
  const currentWeekSummary = useMemo(() => !shareOpen || week === currentWeek ? summary : calculate(data.records, data.settings, currentWeek, today), [shareOpen, week, currentWeek, summary, data, today]);
  const syncReviewCount = useMemo(() => data.sync?.recordSources.filter(source => source.needsReview).length ?? 0, [data.sync]);

  const runSpotJobsSync = useCallback(async (manual = false, refreshPc = false): Promise<boolean> => {
    const preferences = syncPreferencesRef.current;
    if (syncingRef.current || savingRef.current || demo || !preferences.enabled || !preferences.syncCode) return false;
    if (!online) {
      if (manual) setNotice({ text: 'オフラインです。接続後にもう一度同期してください。', error: true });
      return false;
    }
    syncingRef.current = true;
    setSyncing(true);
    setSyncPhase(refreshPc ? 'requesting' : 'pulling');
    const controller = new AbortController();
    syncAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), refreshPc ? 110_000 : 20_000);
    const attemptedAt = new Date().toISOString();
    const preferencesUnchanged = () => {
      const current = loadSyncPreferences();
      return current.enabled && current.syncCode === preferences.syncCode && current.importAfter === preferences.importAfter;
    };
    try {
      const refreshed = refreshPc ? await requestPcRefresh({
        syncCode: preferences.syncCode,
        signal: controller.signal,
        onProgress: setSyncPhase,
      }) : undefined;
      if (!preferencesUnchanged()) return false;
      setSyncPhase(refreshPc ? 'importing' : 'pulling');
      // Re-read after the PC wait so records entered meanwhile are preserved.
      const latest = await loadData();
      const base = latest ?? personalRef.current;
      const result = await syncFromBridge(base, {
        syncCode: preferences.syncCode,
        importAfter: preferences.importAfter,
        signal: controller.signal,
        minimumStoredAt: refreshed?.requestedAt,
      });
      controller.signal.throwIfAborted();
      if (!preferencesUnchanged()) return false;
      await saveData(result.data, { expected: latest });
      personalRef.current = result.data;
      persistedRef.current = result.data;
      setPersonal(result.data);
      setStorageError('');
      setUndo(null);
      channel.current?.postMessage('saved');
      if (!preferencesUnchanged()) return false;
      const reviewCount = result.data.sync?.recordSources.filter(source => source.needsReview).length ?? 0;
      const message = result.imported > 0
        ? `${result.imported}件を自動取り込みしました${reviewCount > 0 ? `（要確認 ${reviewCount}件）` : ''}`
        : refreshPc ? 'PCから最新の履歴を取得し、反映しました（追加0件）' : 'PC取得済みの履歴を確認しました';
      const nextPreferences = saveSyncPreferences({
        ...preferences,
        lastStatus: 'success',
        lastAttemptAt: attemptedAt,
        lastSuccessAt: new Date().toISOString(),
        lastCollectedAt: result.collectedAt,
        lastMessage: message,
      });
      syncPreferencesRef.current = nextPreferences;
      setSyncPreferences(nextPreferences);
      if (manual || result.imported > 0) setNotice({ text: message });
      return true;
    } catch (error) {
      if (!preferencesUnchanged()) return false;
      const message = controller.signal.aborted ? '同期を完了できませんでした。通信状態とPCの起動状態を確認し、もう一度お試しください。' : error instanceof Error ? error.message : '自動同期に失敗しました。';
      try {
        const nextPreferences = saveSyncPreferences({
          ...preferences,
          lastStatus: 'error',
          lastAttemptAt: attemptedAt,
          lastMessage: message,
        });
        syncPreferencesRef.current = nextPreferences;
        setSyncPreferences(nextPreferences);
      } catch { /* Keep the original actionable error if local preferences are unavailable. */ }
      if (manual) setNotice({ text: message, error: true });
      return false;
    } finally {
      clearTimeout(timeout);
      syncAbortRef.current = null;
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [demo, online]);

  useEffect(() => () => syncAbortRef.current?.abort(), []);

  useEffect(() => {
    let active = true;
    const savedSyncPreferences = loadSyncPreferences();
    syncPreferencesRef.current = savedSyncPreferences;
    setSyncPreferences(savedSyncPreferences);
    setSyncReady(true);
    const receivePairingLink = () => {
      const pairing = consumeSyncPairingFragment(window.location, window.history);
      if (pairing.status === 'ready') {
        const currentPreferences = syncPreferencesRef.current;
        setView('settings');
        if (currentPreferences.syncCode === pairing.syncCode) setNotice({ text: 'この端末はすでに自動同期へ接続済みです' });
        else if (currentPreferences.syncCode) setNotice({ text: '別の同期コードへ切り替えるには、現在の同期を解除してください。', error: true });
        else setIncomingSyncCode(pairing.syncCode);
      } else if (pairing.status === 'invalid') {
        setView('settings');
        setNotice({ text: pairing.message, error: true });
      }
    };
    receivePairingLink();
    window.addEventListener('hashchange', receivePairingLink);
    const receiveSyncSettings = (event: StorageEvent) => {
      if (event.key !== SYNC_PREFERENCES_KEY && event.key !== null) return;
      const next = loadSyncPreferences();
      const previous = syncPreferencesRef.current;
      if (next.enabled !== previous.enabled || next.syncCode !== previous.syncCode || next.importAfter !== previous.importAfter) syncAbortRef.current?.abort();
      syncPreferencesRef.current = next;
      setSyncPreferences(next);
    };
    window.addEventListener('storage', receiveSyncSettings);
    const date = todayLocal(); setToday(date); setSample({ ...emptyData(), records: createDemoRecords(date) });
    void loadData().then(stored => { if (active && stored) { setPersonal(stored); personalRef.current = stored; persistedRef.current = stored; } }).catch(error => { if (active) setStorageError(error instanceof Error ? error.message : '保存データを開けませんでした。'); }).finally(() => { if (active) setReady(true); });
    const refreshDate = () => setToday(todayLocal());
    const timer = window.setInterval(refreshDate, 30000);
    const network = () => setOnline(navigator.onLine); network();
    const installPrompt = (event: Event) => { event.preventDefault(); setInstall(event as InstallEvent); };
    const runningNative = isNativeRuntime();
    setNativeRuntime(runningNative);
    document.documentElement.dataset.runtime = runningNative ? 'native' : 'web';
    window.addEventListener('online', network); window.addEventListener('offline', network);
    window.addEventListener('focus', refreshDate);
    if (!runningNative) window.addEventListener('beforeinstallprompt', installPrompt);
    if (runningNative) setOfflineReady(true);
    else if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => { if (active) setOfflineReady(true); }).catch(() => { if (active) setOfflineReady(false); });
    }
    const sync = async () => {
      if (savingRef.current) return;
      try { const stored = await loadData(); if (active && stored && JSON.stringify(stored) !== JSON.stringify(personalRef.current)) { personalRef.current = stored; persistedRef.current = stored; setPersonal(stored); setUndo(null); setNotice({ text: '別の画面で保存された記録を反映しました' }); } } catch { /* The next explicit save/load displays the storage failure. */ }
    };
    if ('BroadcastChannel' in window) { channel.current = new BroadcastChannel('spotjobs-data'); channel.current.onmessage = () => { void sync(); }; }
    window.addEventListener('focus', sync);
    return () => { active = false; clearInterval(timer); channel.current?.close(); window.removeEventListener('storage', receiveSyncSettings); window.removeEventListener('hashchange', receivePairingLink); window.removeEventListener('online', network); window.removeEventListener('offline', network); window.removeEventListener('focus', refreshDate); window.removeEventListener('focus', sync); if (!runningNative) window.removeEventListener('beforeinstallprompt', installPrompt); };
  }, []);
  useEffect(() => {
    if (!ready || !syncReady || demo || !online || !syncPreferences.enabled || !syncPreferences.syncCode) return;
    const run = () => { void runSpotJobsSync(false); };
    const initial = window.setTimeout(run, 900);
    const timer = window.setInterval(run, 15 * 60 * 1000);
    const resume = () => { if (document.visibilityState === 'visible') run(); };
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', resume);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [demo, online, ready, runSpotJobsSync, syncPreferences.enabled, syncPreferences.syncCode, syncReady]);
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
    const message = exists ? '記録を更新しました' : inventoryEditing && record.type === 'adjustment' ? `現在庫を${record.quantity}本に修正しました` : `${record.quantity}本を${typeLabel(record.type)}として登録しました`;
    const changed = { ...data, records, lastArea: record.area ?? data.lastArea };
    const next = exists ? markSyncedRecordReviewed(changed, record.id) : changed;
    const ok = await commit(next, message);
    if (ok) { setEditing(null); setStocktaking(false); setInventoryEditing(false); setEntryVersion(v => v + 1); }
    return ok;
  }
  async function configureSync(syncCode: string, importMode: SyncImportMode) {
    // Existing manual/screenshot history may represent the same official jobs.
    // Let the user explicitly choose between a full backfill and future-only
    // imports when this device already has records.
    const importAfter = data.records.length > 0 && importMode === 'future' ? new Date().toISOString() : undefined;
    const next = saveSyncPreferences({ enabled: true, syncCode, importAfter });
    syncPreferencesRef.current = next;
    setSyncPreferences(next);
    setIncomingSyncCode(undefined);
    if (importAfter) {
      setNotice({ text: '既存記録の二重計上を防ぐため、接続後に完了した履歴から自動取り込みします' });
    }
    if (online) await runSpotJobsSync(true);
  }
  async function backfillSync() {
    const preferences = syncPreferencesRef.current;
    if (!preferences.syncCode) throw new Error('同期コードを確認してください。');
    const next = saveSyncPreferences({ ...preferences, importAfter: undefined });
    syncPreferencesRef.current = next;
    setSyncPreferences(next);
    if (!online) {
      setNotice({ text: 'オンラインに戻ると過去履歴を取り込みます' });
      return;
    }
    await runSpotJobsSync(true);
  }
  async function toggleSync(enabled: boolean) {
    const next = saveSyncPreferences({ ...syncPreferencesRef.current, enabled });
    syncPreferencesRef.current = next;
    setSyncPreferences(next);
    setNotice({ text: enabled ? '自動同期を再開しました' : '自動同期を一時停止しました' });
    if (enabled && online) await runSpotJobsSync(true);
  }
  async function disconnectSync(deleteCloud: boolean) {
    const preferences = syncPreferencesRef.current;
    if (deleteCloud && preferences.syncCode) await deleteRemoteSpotJobsSnapshot({ syncCode: preferences.syncCode });
    clearSyncPreferences();
    const next: SyncLocalPreferences = { enabled: false };
    syncPreferencesRef.current = next;
    setSyncPreferences(next);
    setNotice({ text: deleteCloud ? '暗号化同期データを削除し、この端末の同期を解除しました' : 'この端末の同期を解除しました' });
  }
  function changeView(next: View) { setView(next); window.scrollTo({ top: 0, behavior: 'instant' }); }
  function changeWeek(next: string) { setSelectedWeek(next === currentWeek ? null : next === addDays(week, -7) ? adjacentWeekStart(week, -1, data.records, data.settings) : next === addDays(week, 7) ? adjacentWeekStart(week, 1, data.records, data.settings) : next); }
  function switchDemo(next: boolean) { setDemo(next); setUndo(null); setNotice({ text: next ? 'デモデータを表示しています。自分の記録には影響しません。' : '自分の記録に戻りました' }); setSelectedWeek(null); changeView('home'); }
  async function exportFile(csv = false) {
    try {
      const result = await exportTextFile({
        content: csv ? exportCsv(data.records, data.settings) : serializeBackup(data),
        filename: `spotjobs-${csv ? 'records' : 'backup'}-${today}${demo ? '-demo' : ''}.${csv ? 'csv' : 'json'}`,
        mimeType: csv ? 'text/csv;charset=utf-8' : 'application/json',
        title: csv ? 'SPOTJOBS記録CSV' : 'SPOTJOBSバックアップ',
        dialogTitle: csv ? 'CSVの保存先を選択' : 'バックアップの保存先を選択',
      });
      if (result.method !== 'cancelled') setNotice({ text: result.method === 'native-share' ? 'ファイルを作成しました。選択した保存先を確認してください。' : 'ファイルを作成しました。ダウンロード先を確認してください。' });
    }
    catch (e) { setNotice({ text: e instanceof Error ? e.message : '出力できませんでした。', error: true }); }
  }
  function openOfficialService(event: MouseEvent<HTMLAnchorElement>) {
    if (!isNativeRuntime()) return;
    event.preventDefault();
    void openExternalUrl('https://app.spot.jobs/').catch(error => setNotice({ text: error instanceof Error ? error.message : 'SPOTJOBSを開けませんでした。', error: true }));
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
    <div className="main-shell"><header className="app-header"><div className="mobile-brand"><Brand/></div><span className="desktop-header">SPOTJOBSワーカーのための管理ツール</span><div className="header-actions"><span className={`connection-status ${!online ? 'offline' : ''}`}>{online ? <ShieldCheck size={16}/> : <WifiOff size={16}/>}<span>{!online ? 'オフライン' : syncing ? '同期中' : saving ? '保存中' : '端末に保存'}</span></span><a className="official-service-link" href="https://app.spot.jobs/" target="_blank" rel="noopener noreferrer external" aria-label="SPOTJOBSを開く（外部ブラウザ・別タブ）" title="SPOTJOBSを外部ブラウザで開く" onClick={openOfficialService}><span>SPOTJOBSを開く</span><ExternalLink size={16} aria-hidden="true"/></a></div></header>
      <main id="main-content">
        {demo && <div className="demo-banner"><div><strong>デモデータでお試し中</strong><span>自分の記録には影響しません</span></div><button onClick={() => switchDemo(false)}>終了<X size={17}/></button></div>}
        {storageError && <div className="warning" role="alert"><div><strong>保存データを開けませんでした</strong><p>{storageError}</p><button className="text-button" onClick={() => changeView('settings')}>設定からバックアップを復元</button></div></div>}
        <div key={view} className="view-motion-stage" data-view={view}>
        <div className="page-heading"><div>{['inventory', 'weekly', 'simulator'].includes(view) && <button className="text-button back-link" onClick={() => changeView('home')}><ArrowLeft size={17}/>ホーム</button>}<h1><span className="kinetic-readable">{titles[view]}</span><KineticGlyphs text={titles[view]} startDelay={35} step={42}/></h1></div><span>{dateLabel(today)}</span></div>
        {view === 'home' && <>
          <HomeSyncAction preferences={syncPreferences} online={online} demo={demo} syncing={syncing} saving={saving} phase={syncPhase} onSync={() => { void runSpotJobsSync(true, true); }} onSetup={() => changeView('settings')} />
          <HomeView summary={summary} settings={data.settings} today={today} week={week} currentWeek={currentWeek} onWeek={changeWeek} onView={changeView} onInventoryEdit={() => setInventoryEditing(true)} onShare={() => setShareOpen(true)} onDemo={() => switchDemo(true)} onSyncSetup={() => changeView('settings')} syncConfigured={!!syncPreferences.syncCode} empty={!data.records.length}/><div className="home-tools"><button onClick={() => changeView('inventory')}><ScanLine size={21}/>在庫・棚卸<ChevronRight size={18}/></button><button onClick={() => changeView('simulator')}><TrendingUp size={21}/>報酬シミュレーター<ChevronRight size={18}/></button><button className="screenshot-home-action" onClick={() => setScreenshotImport(true)}><ImagePlus size={21}/>スクショから取り込む<ChevronRight size={18}/></button></div></>}
        {(view === 'refill' || view === 'pickup') && <div className="entry-layout"><section className="panel entry-panel"><button className="button button-secondary screenshot-entry-action" onClick={() => setScreenshotImport(true)}><ImagePlus size={19}/>スクショから取り込む</button><RecordForm key={`${view}-${demo}-${entryVersion}`} data={data} today={today} type={view} onSave={saveRecord}/></section><aside className="entry-side"><div className="panel"><Battery size={26}/><h2>いまの手元在庫</h2><strong key={summary.inventory.total} className="side-number metric-motion">{summary.inventory.total}<small>本</small></strong><p>早期対象の見込み {summary.inventory.eligibleCount}本</p><button className="text-button" onClick={() => changeView('inventory')}>在庫の内訳を見る<ChevronRight size={17}/></button></div><p className="muted">{view === 'refill' ? '取出を先に記録すると、早期補充を自動判定できます。' : '取出時には報酬は発生しません。補充を記録すると報酬が加算されます。'}</p></aside></div>}
        {view === 'weekly' && <WeeklyView summary={summary} settings={data.settings} today={today} week={week} currentWeek={currentWeek} onWeek={changeWeek}/>}
        {view === 'inventory' && <InventoryView summary={summary} settings={data.settings} today={today} onInventoryEdit={() => setInventoryEditing(true)} onStocktake={() => setStocktaking(true)} onEdit={setEditing}/>}
        {view === 'simulator' && <SimulatorView summary={summary} settings={data.settings} today={today}/>}
        {view === 'history' && <><button className="button button-secondary screenshot-entry-action" onClick={() => setScreenshotImport(true)}><ImagePlus size={19}/>スクショから取り込む</button><HistoryView summary={summary} settings={data.settings} today={today} onEdit={setEditing}/></>}
        {view === 'settings' && <><section className="panel pwa-panel"><div className="section-heading"><Smartphone size={23}/><h2>{nativeRuntime ? 'アプリとして利用中' : 'ホーム画面で、すぐ使える'}</h2></div><p>{nativeRuntime ? '必要なアプリ資産は端末に保存済みです。基本機能をオフラインで利用できます。' : offlineReady ? 'オフラインで使う準備ができています。' : '初回はインターネットに接続して開いてください。'}</p>{!nativeRuntime && install && <button className="button button-primary" onClick={async () => { await install.prompt(); await install.userChoice; setInstall(null); }}><Download size={18}/>アプリをインストール</button>}<p className="field-hint">{nativeRuntime ? '自動取り込みを設定すると、PCで取得した履歴をこのアプリにも反映できます。JSONバックアップも引き続き利用できます。' : 'iPhone：Safariの共有 → ホーム画面に追加。Android：Chromeのメニュー → アプリをインストール。オフラインでも入力・履歴・計算を利用できます。'}</p></section><SyncPanel preferences={syncPreferences} online={online} demo={demo} syncing={syncing} syncPhase={syncPhase} reviewCount={syncReviewCount} hasExistingRecords={data.records.length > 0} incomingSyncCode={incomingSyncCode} onConfigure={configureSync} onBackfill={backfillSync} onToggle={toggleSync} onSync={() => runSpotJobsSync(true, true).then(() => undefined)} onDisconnect={disconnectSync} onReview={() => changeView('history')}/><SettingsPanel key={`${demo}-${JSON.stringify(data.settings)}`} settings={data.settings} demo={demo} onSave={async settings => { const ok = await commit({ ...data, settings, lastArea: settings.defaultArea !== data.settings.defaultArea ? settings.defaultArea : data.lastArea }, '設定を保存しました'); if (!ok) throw new Error('設定を保存できませんでした。'); }} onBackup={() => { void exportFile(); }} onImport={() => fileRef.current?.click()} onCsv={() => { void exportFile(true); }} onCsvImport={() => csvRef.current?.click()} onDemo={() => switchDemo(!demo)}/></>}
        </div>
        <footer className="app-footer"><nav aria-label="プライバシーとサポート">{nativeRuntime ? <><a href="/privacy.html">プライバシーポリシー</a><a href="/support.html">サポート</a></> : <><Link href="/privacy" prefetch={false}>プライバシーポリシー</Link><Link href="/support" prefetch={false}>サポート</Link></>}</nav><p>個人制作の非公式管理ツールです。<br className="mobile-only"/>公式サービスとは関係ありません。</p><p>報酬は個人設定に基づく見込みです。確定額・適用条件は公式サービスで確認してください。</p></footer>
      </main>
    </div>
    <nav className="bottom-nav" aria-label="モバイルナビゲーション">{nav.map(n => <button key={n.id} aria-current={view === n.id ? 'page' : undefined} className={`${view === n.id ? 'active' : ''} ${n.id}`} onClick={() => changeView(n.id)}><span><n.icon size={23}/></span>{n.label}</button>)}</nav>
    {(editing || stocktaking || inventoryEditing) && <Sheet title={editing ? '記録を編集' : inventoryEditing ? '現在庫を編集' : '棚卸'} onClose={() => { setEditing(null); setStocktaking(false); setInventoryEditing(false); setDeleteConfirm(false); }}><RecordForm data={data} today={today} type={editing?.type ?? 'adjustment'} record={editing ?? undefined} adjustmentMode={inventoryEditing ? 'inventory-edit' : 'stocktake'} initialQuantity={Math.max(0, summary.inventory.total)} onSave={saveRecord}/>{editing && <div className="delete-section">{deleteConfirm ? <><p>この{typeLabel(editing.type)}記録（{editing.quantity}本）を削除しますか？<br/>在庫・報酬は再計算されます。</p><div className="dialog-actions"><button className="button button-secondary" onClick={() => setDeleteConfirm(false)}>キャンセル</button><button className="button button-danger" disabled={saving} onClick={async () => { const ok = await commit(removeRecordWithSyncTombstone(data, editing.id), '記録を削除しました'); if (ok) { setEditing(null); setDeleteConfirm(false); } }}>削除する</button></div></> : <button className="text-button danger" onClick={() => setDeleteConfirm(true)}><Trash2 size={18}/>この記録を削除</button>}</div>}</Sheet>}
    {backup && <Sheet title="バックアップを復元" onClose={() => setBackup(null)}><p>以下のバックアップを確認してください。</p><dl className="breakdown-list"><div><dt>作成日時</dt><dd>{backup.exportedAt ? new Date(backup.exportedAt).toLocaleString('ja-JP') : '旧形式のため不明'}</dd></div><div><dt>記録数</dt><dd>{backup.recordCount}件</dd></div><div><dt>対象期間</dt><dd>{backup.startDate ? `${backup.startDate} 〜 ${backup.endDate}` : '記録なし'}</dd></div></dl><div className="warning"><div><strong>現在の{demo ? 'デモ' : '端末'}データを上書きします</strong><p>{data.records.length}件の記録と設定が置き換わります。必要な場合は先にバックアップしてください。</p></div></div><button className="button button-secondary" onClick={() => { void exportFile(); }}><Download size={18}/>現在のデータをバックアップ</button><div className="dialog-actions"><button className="button button-secondary" onClick={() => setBackup(null)}>キャンセル</button><button className="button button-primary" disabled={saving} onClick={async () => { const ok = await commit(backup.data, 'バックアップを復元しました', true, true); if (ok) { setBackup(null); setSelectedWeek(null); } }}>確認して上書き復元</button></div></Sheet>}
    {csvText !== null && <Sheet wide title="CSVから記録を取り込む" onClose={() => setCsvText(null)}><CsvImportPanel text={csvText} data={data} onImport={async records => { const ok = await commit({ ...data, records: [...data.records, ...records] }, `${records.length}件を取り込みました`); if (ok) setCsvText(null); return ok; }}/></Sheet>}
    {screenshotImport && <Sheet wide title="スクショから取り込む" onClose={() => { if (!saving) setScreenshotImport(false); }}><ScreenshotImportPanel data={data} today={today} onImport={async records => { const ok = await commit({ ...data, records: [...data.records, ...records] }, `${records.length}件をスクショから登録しました`); if (ok) { setScreenshotImport(false); changeView('history'); } return ok; }}/></Sheet>}
    {shareOpen && <Sheet title="成績をXで共有" onClose={() => setShareOpen(false)}><SharePanel todaySummary={currentWeekSummary} weekSummary={summary} today={today} demo={demo} online={online}/></Sheet>}
    <input ref={fileRef} hidden type="file" accept=".json,application/json" aria-label="JSONバックアップファイル" onChange={e => { void readFile(e.target.files?.[0]); }}/><input ref={csvRef} hidden type="file" accept=".csv,text/csv" aria-label="CSVファイル" onChange={e => { void readFile(e.target.files?.[0], true); }}/>
    {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{!notice.error && <span className="toast-check" aria-hidden="true"><Check size={19}/></span>}<span>{notice.text}</span></span>{undo && !notice.error && <button disabled={saving} onClick={async () => { await commit(undo, '操作を元に戻しました', false); }}><RotateCcw size={16}/>元に戻す</button>}<button className="toast-close" aria-label="通知を閉じる" onClick={() => { setNotice(null); setUndo(null); }}><X size={18}/></button></div>}
  </div>;
}

