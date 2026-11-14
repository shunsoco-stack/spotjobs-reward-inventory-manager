'use client';

import { Check, CloudDownload, Monitor, RefreshCw, Smartphone } from 'lucide-react';
import type { SyncLocalPreferences } from '@/lib/sync/preferences';

export type SyncPhase = 'requesting' | 'waiting' | 'fetching' | 'importing' | 'pulling';
const phases: Record<SyncPhase, string> = {
  requesting: 'PCへ取得を依頼しています',
  waiting: 'PCの応答を待っています',
  fetching: 'PCでSPOTJOBSから取得中',
  importing: 'この端末へ反映しています',
  pulling: 'PC取得済みの履歴を取り込み中',
};

export function SyncProgress({ phase }: { phase: SyncPhase }) {
  if (phase === 'pulling') return <div className="sync-progress" aria-live="polite"><strong>{phases.pulling}</strong><p>PCが取得済みの履歴を確認しています。</p></div>;
  const step = phase === 'importing' ? 2 : phase === 'fetching' ? 1 : 0;
  return <div className="sync-progress" aria-live="polite">
    <strong>{phases[phase]}</strong>
    <ol aria-label="同期の進み具合">
      {[['PCへ依頼', Monitor], ['履歴を取得', CloudDownload], ['端末に反映', Smartphone]].map(([label, Icon], index) => {
        const StepIcon = Icon as typeof Monitor;
        return <li key={String(label)} className={index <= step ? 'active' : ''} aria-current={index === step ? 'step' : undefined}>
          {index < step ? <Check size={16} aria-hidden="true" /> : <StepIcon size={16} aria-hidden="true" />}<span>{String(label)}</span>
        </li>;
      })}
    </ol>
    <p>通常は数十秒が目安です。PCの起動・Edgeのジョブ履歴タブが必要です。90秒で応答がなければお知らせします。</p>
  </div>;
}

function lastCollected(value?: string) {
  return value ? new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }).format(new Date(value)) : 'まだ取得していません';
}

export default function HomeSyncAction({ preferences, online, demo, syncing, saving, phase, onSync, onSetup }: {
  preferences: SyncLocalPreferences; online: boolean; demo: boolean; syncing: boolean; saving: boolean;
  phase: SyncPhase; onSync: () => void; onSetup: () => void;
}) {
  const connected = !!preferences.syncCode && preferences.enabled;
  return <section className="home-sync" aria-label="SPOTJOBSの最新履歴を同期">
    <div className="home-sync-main">
      <div><span className="home-sync-caption"><CloudDownload size={17} aria-hidden="true" />SPOTJOBSの最新履歴</span>
        <p>{demo ? '自分の記録に戻ると同期できます' : connected ? `PC取得：${lastCollected(preferences.lastCollectedAt)}` : preferences.syncCode ? '自動同期は一時停止中です' : 'PCとスマホをつないで自動取り込み'}</p>
      </div>
      <button className="button button-primary" type="button" disabled={demo || syncing || saving || (connected && !online)} onClick={connected ? onSync : onSetup}>
        <RefreshCw size={20} className={syncing ? 'spin' : ''} aria-hidden="true" />{syncing ? '同期中…' : '今すぐ同期'}
      </button>
    </div>
    {syncing ? <SyncProgress phase={phase} /> : !online ? <p className="home-sync-message">オフラインです。接続後に同期できます。</p> : preferences.lastMessage && <p className={`home-sync-message ${preferences.lastStatus === 'error' ? 'danger' : ''}`} aria-live="polite">{preferences.lastMessage}</p>}
  </section>;
}
