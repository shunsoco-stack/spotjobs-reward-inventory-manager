'use client';

import { useMemo, useState } from 'react';
import { ExternalLink, Share2, ShieldCheck, WifiOff } from 'lucide-react';
import type { Calculation } from '@/lib/core';
import { buildPerformanceShareText, CANONICAL_APP_URL, createXShareUrl, type PerformanceShareScope } from '@/lib/share';

export default function SharePanel({ todaySummary, weekSummary, today, demo, online }: { todaySummary: Calculation; weekSummary: Calculation; today: string; demo: boolean; online: boolean }) {
  const [scope, setScope] = useState<PerformanceShareScope>('today');
  const summary = scope === 'today' ? todaySummary : weekSummary;
  const text = useMemo(() => buildPerformanceShareText({ scope, summary, today, demo }), [scope, summary, today, demo]);
  const shareUrl = useMemo(() => createXShareUrl(text), [text]);

  return <div className="share-panel">
    <div className="segmented share-period" role="group" aria-label="共有する期間">
      <button type="button" className={scope === 'today' ? 'selected' : ''} aria-pressed={scope === 'today'} onClick={() => setScope('today')}>今日</button>
      <button type="button" className={scope === 'week' ? 'selected' : ''} aria-pressed={scope === 'week'} onClick={() => setScope('week')}>1週間</button>
    </div>

    <div className="share-preview" aria-live="polite" aria-atomic="true">
      <span>投稿内容のプレビュー</span>
      <p data-testid="share-preview">{text}{'\n'}{CANONICAL_APP_URL}</p>
    </div>

    <div className="share-privacy">
      <ShieldCheck size={20} aria-hidden="true"/>
      <p>Xに渡すのは上記の集計だけです。店舗名・メモ・個別履歴は含みません。</p>
    </div>

    {online
      ? <a className="button x-share-button" data-testid="x-share-link" href={shareUrl} target="_blank" rel="noopener noreferrer external" aria-label="Xの共有画面を別画面で開く"><Share2 size={19} aria-hidden="true"/>Xで共有画面を開く<ExternalLink size={17} aria-hidden="true"/></a>
      : <button className="button share-offline-button" type="button" disabled><WifiOff size={19} aria-hidden="true"/>Xへの共有には通信が必要です</button>}
    <p className="field-hint">投稿内容はXの画面で確認・編集してから送信できます。このアプリから自動投稿はしません。</p>
  </div>;
}
