'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from 'react';
import { ArrowRight, CloudDownload } from 'lucide-react';
import type { WorkRecord } from '@/lib/core';
import { loadData, saveData, type AppData } from '@/lib/storage';
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
import SyncPanel, { type SyncImportMode } from './sync-panel';
import HomeSyncAction, { type SyncPhase } from './sync-action';

export type { SyncPhase, SyncImportMode };
export type SyncNotice = { text: string; error?: boolean } | null;

export interface SpotJobsSyncHost {
  demo: boolean;
  online: boolean;
  ready: boolean;
  saving: boolean;
  data: AppData;
  personalRef: MutableRefObject<AppData>;
  persistedRef: MutableRefObject<AppData | null>;
  savingRef: MutableRefObject<boolean>;
  channel: MutableRefObject<BroadcastChannel | null>;
  setPersonal: Dispatch<SetStateAction<AppData>>;
  setStorageError: Dispatch<SetStateAction<string>>;
  setUndo: Dispatch<SetStateAction<AppData | null>>;
  setNotice: Dispatch<SetStateAction<SyncNotice>>;
  setView: (view: 'settings' | string) => void;
}

export interface SpotJobsSyncApi {
  syncing: boolean;
  nativeInstallHint: string;
  connectionBusyLabel: string | null;
  homeWelcomeCta: ReactNode;
  renderHomeAction: (onSetup: () => void) => ReactNode;
  renderSettingsPanel: () => ReactNode;
  prepareSavedData: (next: AppData, record: WorkRecord, existed: boolean) => AppData;
  removeRecord: (data: AppData, recordId: string) => AppData;
}

const NATIVE_INSTALL_HINT = '自動取り込みを設定すると、PCで取得した履歴をこのアプリにも反映できます。JSONバックアップも引き続き利用できます。';

function HomeSyncWelcome({ onSetup }: { onSetup: () => void }) {
  return <>
    <span className="round-icon sync-icon" aria-hidden="true"><CloudDownload size={23}/></span>
    <h2>PCの履歴をこの端末へ</h2>
    <p>同じURLを開くだけでは端末間同期されません。この端末でも一度だけ接続してください。</p>
    <button className="button button-primary" onClick={onSetup}><CloudDownload size={19}/>PCの履歴を同期する<ArrowRight size={18}/></button>
    <div className="welcome-or"><span>または</span></div>
  </>;
}

export function useSpotJobsSync({
  demo,
  online,
  ready,
  saving,
  data,
  personalRef,
  persistedRef,
  savingRef,
  channel,
  setPersonal,
  setStorageError,
  setUndo,
  setNotice,
  setView,
}: SpotJobsSyncHost): SpotJobsSyncApi {
  const [syncing, setSyncing] = useState(false);
  const [syncPhase, setSyncPhase] = useState<SyncPhase>('pulling');
  const [syncReady, setSyncReady] = useState(false);
  const [syncPreferences, setSyncPreferences] = useState<SyncLocalPreferences>({ enabled: false });
  const [incomingSyncCode, setIncomingSyncCode] = useState<string>();
  const syncingRef = useRef(false);
  const syncAbortRef = useRef<AbortController | null>(null);
  const syncPreferencesRef = useRef<SyncLocalPreferences>({ enabled: false });
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
  }, [channel, demo, online, personalRef, persistedRef, savingRef, setNotice, setPersonal, setStorageError, setUndo]);

  useEffect(() => () => syncAbortRef.current?.abort(), []);

  useEffect(() => {
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
    return () => {
      window.removeEventListener('storage', receiveSyncSettings);
      window.removeEventListener('hashchange', receivePairingLink);
    };
  }, [setNotice, setView]);

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

  const configureSync = useCallback(async (syncCode: string, importMode: SyncImportMode) => {
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
  }, [data.records.length, online, runSpotJobsSync, setNotice]);

  const backfillSync = useCallback(async () => {
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
  }, [online, runSpotJobsSync, setNotice]);

  const toggleSync = useCallback(async (enabled: boolean) => {
    const next = saveSyncPreferences({ ...syncPreferencesRef.current, enabled });
    syncPreferencesRef.current = next;
    setSyncPreferences(next);
    setNotice({ text: enabled ? '自動同期を再開しました' : '自動同期を一時停止しました' });
    if (enabled && online) await runSpotJobsSync(true);
  }, [online, runSpotJobsSync, setNotice]);

  const disconnectSync = useCallback(async (deleteCloud: boolean) => {
    const preferences = syncPreferencesRef.current;
    if (deleteCloud && preferences.syncCode) await deleteRemoteSpotJobsSnapshot({ syncCode: preferences.syncCode });
    clearSyncPreferences();
    const next: SyncLocalPreferences = { enabled: false };
    syncPreferencesRef.current = next;
    setSyncPreferences(next);
    setNotice({ text: deleteCloud ? '暗号化同期データを削除し、この端末の同期を解除しました' : 'この端末の同期を解除しました' });
  }, [setNotice]);

  const prepareSavedData = useCallback((next: AppData, record: WorkRecord, existed: boolean) => (
    existed ? markSyncedRecordReviewed(next, record.id) : next
  ), []);

  const removeRecord = useCallback((current: AppData, recordId: string) => (
    removeRecordWithSyncTombstone(current, recordId)
  ), []);

  const renderHomeAction = useCallback((onSetup: () => void) => (
    <HomeSyncAction
      preferences={syncPreferences}
      online={online}
      demo={demo}
      syncing={syncing}
      saving={saving}
      phase={syncPhase}
      onSync={() => { void runSpotJobsSync(true, true); }}
      onSetup={onSetup}
    />
  ), [demo, online, runSpotJobsSync, saving, syncPhase, syncPreferences, syncing]);

  const renderSettingsPanel = useCallback(() => (
    <SyncPanel
      preferences={syncPreferences}
      online={online}
      demo={demo}
      syncing={syncing}
      syncPhase={syncPhase}
      reviewCount={syncReviewCount}
      hasExistingRecords={data.records.length > 0}
      incomingSyncCode={incomingSyncCode}
      onConfigure={configureSync}
      onBackfill={backfillSync}
      onToggle={toggleSync}
      onSync={() => runSpotJobsSync(true, true).then(() => undefined)}
      onDisconnect={disconnectSync}
      onReview={() => setView('history')}
    />
  ), [backfillSync, configureSync, data.records.length, demo, disconnectSync, incomingSyncCode, online, runSpotJobsSync, setView, syncPhase, syncPreferences, syncReviewCount, syncing, toggleSync]);

  const homeWelcomeCta = useMemo(() => (
    syncPreferences.syncCode ? null : <HomeSyncWelcome onSetup={() => setView('settings')} />
  ), [setView, syncPreferences.syncCode]);

  return {
    syncing,
    nativeInstallHint: NATIVE_INSTALL_HINT,
    connectionBusyLabel: syncing ? '同期中' : null,
    homeWelcomeCta,
    renderHomeAction,
    renderSettingsPanel,
    prepareSavedData,
    removeRecord,
  };
}
