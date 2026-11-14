'use client';

import { useMemo, useState, type CSSProperties } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpFromLine, Battery, Check, ChevronLeft, ChevronRight, CircleAlert, CloudDownload, History, Pencil, ScanLine, Share2, Target, TrendingUp, Zap } from 'lucide-react';
import { addDays, earningsOverview, goalAdditional, inventoryDays, monthStartFor, simulateAdditional, tierProjections, type Area, type Calculation, type EnrichedRecord, type Settings, type WorkRecord } from '@/lib/core';
import { AREAS, dateLabel, Empty, KineticGlyphs, money, shortDate, typeLabel, weekday, WeekPicker } from './ui';

interface Shared { summary: Calculation; settings: Settings; today: string; }
export type View = 'home' | 'refill' | 'pickup' | 'history' | 'settings' | 'inventory' | 'weekly' | 'simulator';

type InfographicStyle = CSSProperties & { '--infographic-size'?: string; '--infographic-delay'?: string };

function RewardComposition({ base, early, bonus }: { base: number; early: number; bonus: number }) {
  const total = base + early + bonus;
  const segments = [
    { kind: 'base', label: '基本報酬', value: base },
    { kind: 'early', label: '早期補充', value: early },
    { kind: 'bonus', label: '本数ボーナス', value: bonus },
  ];
  const label = total
    ? `報酬内訳。基本報酬${money(base)}円、早期補充${money(early)}円、本数ボーナス${money(bonus)}円`
    : '報酬内訳。まだ報酬はありません';

  return <div key={`${base}-${early}-${bonus}`} className={`reward-composition ${total ? '' : 'empty'}`} role="img" aria-label={label}>
    {total ? segments.map((segment, index) => segment.value > 0 && <span
      key={segment.kind}
      className={`reward-segment ${segment.kind}`}
      data-kind={segment.kind}
      data-value={segment.value}
      title={`${segment.label} ¥${money(segment.value)}`}
      style={{ width: `${segment.value / total * 100}%`, '--infographic-delay': `${100 + index * 90}ms` } as InfographicStyle}
      aria-hidden="true"
    />) : <span className="reward-composition-empty" aria-hidden="true">まだ報酬はありません</span>}
  </div>;
}

function PeriodEarning({ period, label, caption, total }: { period: 'month' | 'year'; label: string; caption: string; total: number }) {
  const value = money(total);
  return <div className="period-earning" data-period={period} data-value={`${value}円`}><span><b>{label}</b><small>{caption}</small></span><strong key={`${period}-${caption}-${value}`}><span className="kinetic-readable">{value}円</span><KineticGlyphs text={`¥${value}`} startDelay={55} step={36}/></strong></div>;
}

function monthCaption(date: string) {
  return `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月`;
}

function BrowsablePeriodEarnings({ summary, today }: { summary: Calculation; today: string }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const selectedMonth = monthStartFor(today, monthOffset);
  const previousMonth = monthStartFor(selectedMonth, -1);
  const nextMonth = monthStartFor(selectedMonth, 1);
  const selected = earningsOverview(summary, selectedMonth);
  const current = earningsOverview(summary, today);
  const isCurrentMonth = monthOffset === 0;
  const selectedCaption = monthCaption(selectedMonth);
  const previousCaption = monthCaption(previousMonth);
  const nextCaption = monthCaption(nextMonth);
  const yearCaption = `${Number(current.year.start.slice(0, 4))}年`;

  return <div className="period-earnings" role="group" aria-label="月次と今年の報酬">
    <div className="period-earnings-heading"><span>期間別の合計</span><small>各週の本数ボーナスを反映</small></div>
    <div className="period-month-picker" role="group" aria-label="月次報酬の表示月">
      <button type="button" className="icon-button" aria-label={`前の月、${previousCaption}を表示`} onClick={() => setMonthOffset(value => value - 1)}><ChevronLeft size={19}/></button>
      <button type="button" className="period-month-label" aria-label={isCurrentMonth ? `${selectedCaption}、今月を表示中` : '今月へ戻る'} disabled={isCurrentMonth} onClick={() => setMonthOffset(0)}><strong>{selectedCaption}</strong><span>{isCurrentMonth ? '今月を表示中' : '今月へ戻る'}</span></button>
      <button type="button" className="icon-button" aria-label={`次の月、${nextCaption}を表示`} disabled={isCurrentMonth} onClick={() => setMonthOffset(value => Math.min(0, value + 1))}><ChevronRight size={19}/></button>
    </div>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{selectedCaption}の月次報酬は{money(selected.month.total)}円、補充{selected.month.refillCount}本です。</p>
    <div className="period-earnings-grid"><PeriodEarning period="month" label={isCurrentMonth ? '今月' : 'この月'} caption={selectedCaption} total={selected.month.total}/><PeriodEarning period="year" label="今年" caption={yearCaption} total={current.year.total}/></div>
  </div>;
}

function AnimatedProgress({ value, max, label, tone = 'green' }: { value: number; max: number; label: string; tone?: 'green' | 'refill' }) {
  const safeMax = Math.max(1, max);
  const current = Math.max(0, Math.min(value, safeMax));
  const percentage = current / safeMax * 100;
  return <div
    key={`${current}-${safeMax}`}
    className={`infographic-progress ${tone} ${current === 0 ? 'empty' : ''}`}
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={max}
    aria-valuenow={Math.min(value, max)}
    data-progress={Math.round(percentage * 10) / 10}
  >
    <span className="infographic-progress-fill" style={{ width: `${percentage}%` }} aria-hidden="true" />
  </div>;
}

export function HomeView({ summary: s, settings, today, week, currentWeek, onWeek, onView, onInventoryEdit, onShare, onDemo, onSyncSetup, syncConfigured, empty }: Shared & { week: string; currentWeek: string; onWeek: (date: string) => void; onView: (view: View) => void; onInventoryEdit: () => void; onShare: () => void; onDemo: () => void; onSyncSetup: () => void; syncConfigured: boolean; empty: boolean; }) {
  const area = settings.defaultArea;
  const next = s.nextTier ? simulateAdditional(s, settings, s.nextTier.remaining, area, true) : null;
  const goal = goalAdditional(s, settings, settings.weeklyGoal, area, true);
  const percent = Math.min(100, s.total / settings.weeklyGoal * 100);
  const percentLabel = String(Math.round(percent * 10) / 10);
  const currentPeriod = week === currentWeek;
  return <div className="home-grid">
    <section className="reward-hero"><div className="hero-top"><div><span className="eyebrow">YOUR WEEK</span><h2>{currentPeriod ? '今週の報酬' : 'この週の報酬'}</h2></div><span className="hero-tag">見込み</span></div><div key={s.total} className="hero-amount" data-value={`${money(s.total)}円`}><span className="kinetic-readable">{money(s.total)}円</span><KineticGlyphs text="¥" className="hero-currency" startDelay={40} step={0}/><KineticGlyphs text={money(s.total)} startDelay={75} step={52}/></div><div className="hero-period">{dateLabel(week)} — {dateLabel(addDays(week, 6))}</div><RewardComposition base={s.base} early={s.earlyBonus} bonus={s.countBonus}/><div className="hero-breakdown"><div><span>基本報酬</span><strong>¥{money(s.base)}</strong></div><div><span>早期補充</span><strong>¥{money(s.earlyBonus)}</strong></div><div><span>本数ボーナス</span><strong>¥{money(s.countBonus)}</strong></div></div><BrowsablePeriodEarnings summary={s} today={today}/><button type="button" className="hero-share-action" aria-label="成績をXで共有" aria-haspopup="dialog" onClick={onShare}><Share2 size={20}/><span>成績をXで共有<small>今日・1週間を選べます</small></span><ChevronRight size={18}/></button><button className="hero-link" onClick={() => onView('weekly')}>日別の報酬を見る<ArrowRight size={18}/></button></section>
    <section className="quick-actions" aria-label="作業を記録"><button className="button refill" onClick={() => onView('refill')}><ArrowDownToLine size={23}/><span>補充を記録<small>在庫から減らす</small></span><ChevronRight size={18}/></button><button className="button pickup" onClick={() => onView('pickup')}><ArrowUpFromLine size={23}/><span>取出を記録<small>在庫に追加する</small></span><ChevronRight size={18}/></button></section>
    <div className="stats-grid"><div className="stat refill-stat"><span><ArrowDownToLine size={16}/>週間補充</span><strong key={s.refillCount} className="metric-motion">{money(s.refillCount)}<small>本</small></strong></div><div className="stat pickup-stat"><span><ArrowUpFromLine size={16}/>週間取出</span><strong key={s.pickupCount} className="metric-motion">{money(s.pickupCount)}<small>本</small></strong></div><button className="stat stock-stat" onClick={() => onView('inventory')}><span><Battery size={16}/>現在庫 <ChevronRight size={14}/></span><strong key={s.inventory.total} className={`metric-motion ${s.inventory.total < 0 ? 'warning-text' : ''}`}>{money(s.inventory.total)}<small>本</small></strong></button><div className="stat"><span><Zap size={16}/>早期補充</span><strong key={s.earlyCount} className="metric-motion">{money(s.earlyCount)}<small>本</small></strong></div></div>
    <section className="panel next-tier"><div className="section-heading"><span className="round-icon green"><TrendingUp size={21}/></span><h2>次の本数ボーナス</h2><span className="pill">現在 ＋{s.countRate}円</span></div>{s.nextTier && next ? <><div key={s.nextTier.remaining} className="next-number" data-value={`あと${money(s.nextTier.remaining)}本`}><span className="kinetic-readable">あと{money(s.nextTier.remaining)}本</span><span className="kinetic-affix kinetic-prefix" aria-hidden="true">あと</span><strong><KineticGlyphs text={money(s.nextTier.remaining)} startDelay={80} step={56}/></strong><span className="kinetic-affix kinetic-suffix" aria-hidden="true">本</span></div><p className="next-caption">{s.nextTier.count}本到達で <strong>＋{s.nextTier.rate}円 / 本</strong></p><AnimatedProgress value={s.refillCount} max={s.nextTier.count} label="次の本数ボーナスまでの進捗" tone="refill"/><div className="progress-labels"><span>現在 {s.refillCount}本</span><span>次は {s.nextTier.count}本</span></div><div className="compare-reward"><div><span>現在</span><strong>¥{money(s.total)}</strong></div><ArrowRight size={20}/><div><span>{s.nextTier.count}本到達時</span><strong>¥{money(next.total)}</strong></div><b>＋¥{money(next.difference)}</b></div><p className="field-hint">追加分：{settings.regionNames[area]}・{settings.regionRates[area]}円/本、すべて早期補充で試算</p></> : <div className="achieved"><Check size={30}/><strong>最高ボーナスに到達</strong><p>今週の全補充に＋{s.countRate}円/本</p></div>}<button className="text-button" onClick={() => onView('simulator')}>追加本数・条件を変えて試算<ChevronRight size={17}/></button></section>
    <section className="panel goal-panel"><div className="section-heading"><Target size={21}/><h2>今週の目標</h2><strong>¥{money(settings.weeklyGoal)}</strong></div><div className="goal-main"><strong key={percentLabel} data-value={`${percentLabel}%`}><span className="kinetic-readable">{percentLabel}%</span><KineticGlyphs text={percentLabel} startDelay={45} step={48}/><small className="kinetic-affix kinetic-suffix" aria-hidden="true">%</small></strong><div>{s.total >= settings.weeklyGoal ? '目標達成！' : <>あと <b>¥{money(settings.weeklyGoal - s.total)}</b></>}</div></div><AnimatedProgress value={Math.min(s.total, settings.weeklyGoal)} max={settings.weeklyGoal} label="週間目標の達成率"/><button className="goal-estimate" onClick={() => onView('simulator')}><span>{goal ? <>あと約 <b>{money(goal.additional)}本</b> で目標</> : '試算条件を見直す'}</span><ChevronRight size={18}/></button><p className="field-hint">地域{settings.regionNames[area]}・追加分すべて早期補充の場合。ボーナスの段階変更を含みます。</p></section>
    <section className="panel weekly-mini"><div className="section-heading"><h2>1週間の補充</h2><WeekPicker week={week} current={currentWeek} onChange={onWeek}/></div><div className="week-chart" role="img" aria-label={s.days.map(d => `${dateLabel(d.date)}補充${d.refillCount}本`).join('、')}>{s.days.map((d, index) => <div key={d.date} className={d.date === today ? 'today' : ''}><span key={`${d.date}-${d.refillCount}`} className="week-chart-value" style={{ '--infographic-delay': `${180 + index * 65}ms` } as InfographicStyle}>{d.refillCount}</span><div className="chart-space"><i key={`${d.date}-${d.refillCount}`} className={d.refillCount ? '' : 'empty'} data-count={d.refillCount} style={{ height: `${Math.max(4, d.refillCount / Math.max(1, ...s.days.map(x => x.refillCount)) * 80)}px`, '--infographic-delay': `${120 + index * 65}ms` } as InfographicStyle}/></div><b>{weekday(d.date)}</b><small>{shortDate(d.date)}</small></div>)}</div><button className="text-button" onClick={() => onView('weekly')}>週次・地域別の集計へ<ChevronRight size={18}/></button></section>
    <section className="panel inventory-preview"><div className="section-heading"><Battery size={21}/><h2>手元のバッテリー</h2><button className="text-button" onClick={() => onView('inventory')}>在庫・棚卸<ChevronRight size={17}/></button></div><div className="inventory-message"><span className="round-icon amber"><Zap size={22}/></span><div><strong>{s.inventory.expiringToday ? `${s.inventory.expiringToday}本が今日までの早期対象` : `早期対象の在庫 ${s.inventory.eligibleCount}本`}</strong><p>古い取出分から先に補充する想定です。</p></div></div><button type="button" className="button button-secondary inventory-edit-shortcut" aria-label="現在庫を編集" onClick={onInventoryEdit}><Pencil size={20}/><span>現在庫を編集<small>実際の保有数に合わせる</small></span><ChevronRight size={18}/></button>{s.records.some(r => r.type === 'adjustment' && r.discrepancy && !r.applied) && <p className="warning"><CircleAlert size={19}/>在庫差異あり。棚卸履歴を確認してください。</p>}{s.inventory.total < 0 && <p className="warning"><CircleAlert size={19}/>在庫がマイナスです。取出の記録漏れを確認してください。</p>}</section>
    {empty && <section className={`panel welcome-panel ${!syncConfigured ? 'sync-welcome' : ''}`}>{!syncConfigured ? <><span className="round-icon sync-icon" aria-hidden="true"><CloudDownload size={23}/></span><h2>PCの履歴をこの端末へ</h2><p>同じURLを開くだけでは端末間同期されません。この端末でも一度だけ接続してください。</p><button className="button button-primary" onClick={onSyncSetup}><CloudDownload size={19}/>PCの履歴を同期する<ArrowRight size={18}/></button><div className="welcome-or"><span>または</span></div></> : <><h2>今日の1本から、はじめよう。</h2><p>取出から記録すると、在庫と早期補充を自動で管理できます。</p></>}<button className="button button-secondary" onClick={onDemo}>デモデータで試す<ArrowRight size={18}/></button><p className="field-hint">デモは自分の記録とは別に保存されます。</p></section>}
  </div>;
}

export function WeeklyView({ summary: s, settings, week, currentWeek, onWeek }: Shared & { week: string; currentWeek: string; onWeek: (date: string) => void }) {
  return <div className="view-stack"><section className="panel"><div className="section-heading"><h2>週次報酬</h2><WeekPicker week={week} current={currentWeek} onChange={onWeek}/></div><div className="reward-total"><span>補充 {s.refillCount}本の合計</span><strong key={s.total} className="metric-motion">¥{money(s.total)}</strong></div><RewardComposition base={s.base} early={s.earlyBonus} bonus={s.countBonus}/><dl className="breakdown-list"><div><dt>基本報酬</dt><dd>¥{money(s.base)}</dd></div><div><dt>早期補充 <small>{s.earlyCount}本</small></dt><dd>¥{money(s.earlyBonus)}</dd></div><div><dt>本数ボーナス <small>＋{s.countRate}円/本</small></dt><dd>¥{money(s.countBonus)}</dd></div></dl><p className="field-hint">本数ボーナスは、この週の補充本数全体に適用します。地域・早期単価は記録時の設定を保持しています。</p></section>
    <section className="panel"><h2>日別の実績</h2><div className="table-wrap"><table className="weekly-table"><thead><tr><th>日付</th><th className="refill-label">補充</th><th className="pickup-label">取出</th><th>早期</th><th>報酬</th></tr></thead><tbody>{s.days.map(d => <tr key={d.date}><th>{dateLabel(d.date)}</th><td>{d.refillCount}</td><td>{d.pickupCount}</td><td>{d.earlyCount}</td><td>¥{money(d.total)}</td></tr>)}</tbody><tfoot><tr><th>合計</th><td>{s.refillCount}</td><td>{s.pickupCount}</td><td>{s.earlyCount}</td><td>¥{money(s.total)}</td></tr></tfoot></table></div><p className="field-hint">本数の単位：本</p></section>
    <section className="panel"><h2>日別・地域別の補充</h2><div className="table-wrap"><table className="area-table"><thead><tr><th>曜日</th><th>合計</th>{AREAS.map(a => <th key={a} title={settings.regionNames[a]}>{a === 'omitted' ? '省略' : a}</th>)}</tr></thead><tbody>{s.days.map(d => <tr key={d.date}><th>{weekday(d.date)}</th><td>{d.refillCount}</td>{AREAS.map(a => <td key={a}>{d.regionCounts[a]}</td>)}</tr>)}</tbody><tfoot><tr><th>合計</th><td>{s.refillCount}</td>{AREAS.map(a => <td key={a}>{s.days.reduce((n, d) => n + d.regionCounts[a], 0)}</td>)}</tr></tfoot></table></div><p className="field-hint">{AREAS.map(a => `${a === 'omitted' ? '省略' : a}：${settings.regionDescriptions[a]}`).join(' / ')}</p></section></div>;
}

export function SimulatorView({ summary: s, settings }: Shared) {
  const [additional, setAdditional] = useState('20');
  const [area, setArea] = useState<Area>(settings.defaultArea);
  const [early, setEarly] = useState(true);
  const amount = Math.min(100000, Math.max(0, Math.floor(Number(additional) || 0)));
  const result = simulateAdditional(s, settings, amount, area, early);
  const goal = goalAdditional(s, settings, settings.weeklyGoal, area, early);
  const tiers = tierProjections(s, settings, area, early);
  return <div className="simulator-grid"><section className="panel simulator-input"><div className="section-heading"><TrendingUp size={23}/><h2>あと何本、やってみる？</h2></div><label className="field">追加する補充本数<div className="simulator-number"><input type="number" inputMode="numeric" min="0" max="100000" step="1" value={additional} onChange={e => setAdditional(e.target.value)} onFocus={e => e.target.select()}/><span>本</span></div></label><div className="quick-amounts">{[1, 5, 10, 20, 50].map(n => <button key={n} onClick={() => setAdditional(String(Math.min(100000, amount + n)))}>+{n}</button>)}</div><label className="field">追加分の地域<select value={area} onChange={e => setArea(e.target.value as Area)}>{AREAS.map(a => <option value={a} key={a}>{settings.regionNames[a]} · {settings.regionRates[a]}円/本</option>)}</select></label><label className="check-field"><input type="checkbox" checked={early} onChange={e => setEarly(e.target.checked)}/>追加分をすべて早期補充として試算</label><p className="field-hint">追加分の基本単価 {settings.regionRates[area]}円 ＋ 早期 {early ? settings.earlyRate : 0}円/本。在庫制限なしの試算です。記録は変更しません。</p></section><section key={`${result.total}-${result.count}-${result.rate}`} className="panel simulation-result result-motion"><span className="eyebrow">SIMULATION</span><h2>追加後の予想報酬</h2><div className="result-amount">¥{money(result.total)}</div><span className="difference-pill">現在より ＋¥{money(result.difference)}</span><dl className="breakdown-list"><div><dt>週間補充</dt><dd>{s.refillCount} → <b>{result.count}本</b></dd></div><div><dt>到達ボーナス</dt><dd>＋{result.rate}円/本</dd></div><div><dt>基本報酬</dt><dd>¥{money(result.base)}</dd></div><div><dt>早期補充</dt><dd>¥{money(result.earlyBonus)}</dd></div><div><dt>本数ボーナス</dt><dd>¥{money(result.countBonus)}</dd></div></dl><p className="field-hint">現在の報酬 ¥{money(s.total)}。新しい段階のボーナスは週全体に適用します。</p></section><section className="panel tier-projections"><h2>各ボーナスまで、あと何本？</h2><div className="tier-list">{tiers.filter(t => t.threshold > 0).map(t => <div key={t.threshold}><div><strong>{t.threshold}本 <small>＋{t.thresholdRate}円/本</small></strong><span>{s.refillCount >= t.threshold ? <span className="green-text"><Check size={15}/>達成済み</span> : `あと${t.additional}本`}</span></div><div><strong>¥{money(t.total)}</strong><span>{s.refillCount >= t.threshold ? '現在の報酬' : `＋¥${money(t.difference)}`}</span></div></div>)}</div></section><section className="panel goal-panel"><div className="section-heading"><Target size={22}/><h2>目標金額まで</h2></div><p>週間目標 <strong>¥{money(settings.weeklyGoal)}</strong></p><div key={goal?.additional ?? 'unreachable'} className="next-number metric-motion">{goal ? <>あと <strong>{money(goal.additional)}</strong> 本</> : <strong>到達できません</strong>}</div><p>{goal ? `到達時の予想報酬 ¥${money(goal.total)}` : '10万本までの試算で目標に届きません。目標・単価を確認してください。'}</p><p className="field-hint">上の地域・早期条件で1本ずつ加算し、ボーナス変化を含めて最初に目標へ届く本数です。</p></section></div>;
}

export function InventoryView({ summary: s, today, onInventoryEdit, onStocktake, onEdit }: Shared & { onInventoryEdit: () => void; onStocktake: () => void; onEdit: (record: WorkRecord) => void }) {
  const days = inventoryDays(s, today);
  const stocktakes = s.records.filter(r => r.type === 'adjustment').slice().reverse();
  return <div className="view-stack"><section className="panel inventory-hero"><div className="section-heading"><Battery size={24}/><h2>現在の手元在庫</h2><span className="pill">{dateLabel(today)}</span></div><div key={s.inventory.total} className={`inventory-count metric-motion ${s.inventory.total < 0 ? 'warning-text' : ''}`}>{money(s.inventory.total)}<small>本</small></div><div className="inventory-numbers"><div><span>早期対象の見込み</span><b>{s.inventory.eligibleCount}本</b></div><div><span>今日までの早期対象</span><b>{s.inventory.expiringToday}本</b></div></div><div className="inventory-actions"><button className="button button-primary adjustment" onClick={onInventoryEdit}><Pencil size={21}/>現在庫を編集</button><p>実際に持っている本数へ合わせます。差分は履歴に残ります。</p><button className="button button-secondary" onClick={onStocktake}><ScanLine size={20}/>棚卸を記録する</button></div></section>
    <section className="panel"><h2>直近3日間の在庫</h2><p className="field-hint">日付は自動で繰り越されます。過去の再入力は不要です。</p><div className="table-wrap"><table className="inventory-table"><thead><tr><th>日付</th><th className="pickup-label">取出</th><th className="refill-label">補充</th><th>在庫</th><th>棚卸</th></tr></thead><tbody>{days.map(d => <tr key={d.date}><th>{d.date === today ? '今日' : d.date === addDays(today, -1) ? '昨日' : '一昨日'}<small>{shortDate(d.date)}</small></th><td>{d.pickupCount}</td><td>{d.refillCount}</td><td><b>{d.closingStock}</b></td><td>{d.stocktake ?? '—'}</td></tr>)}</tbody></table></div><p className="field-hint">在庫＝前日繰越＋取出−補充＋確認済み棚卸調整。</p></section>
    {s.errors.length > 0 && <div className="warning"><CircleAlert size={21}/><div><strong>記録の確認が必要です</strong><p>{s.errors.length}件の記録に在庫不足などがあります。履歴の注意表示から編集できます。</p></div></div>}
    <section className="panel"><div className="section-heading"><ScanLine size={21}/><h2>棚卸・差異の履歴</h2></div>{stocktakes.length ? <div className="stocktake-list">{stocktakes.map(r => <button key={r.id} onClick={() => onEdit(r)}><div><strong>{dateLabel(r.date)} · 実棚卸 {r.quantity}本</strong><span>{r.applied ? '在庫へ反映済み' : '確認記録のみ'} · 差異 {(r.difference ?? r.discrepancy ?? 0) > 0 ? '+' : ''}{r.difference ?? r.discrepancy ?? 0}本</span>{!!r.discrepancy && !r.applied && <span className="warning-text">在庫差異あり</span>}</div><Pencil size={18}/></button>)}</div> : <Empty>棚卸の記録はまだありません。<br/>手元の本数を数えて記録しましょう。</Empty>}</section>
    <section className="panel"><h2>取出日ごとの残り</h2>{s.inventory.batches.length ? <div className="batch-list">{s.inventory.batches.map(b => <div key={b.id}><div><strong>{b.pickupDate ? `${dateLabel(b.pickupDate)} 取出` : '取出日不明'}</strong><span>{b.expiresOn ? `早期対象の目安 ${dateLabel(b.expiresOn)}まで` : '早期判定の対象外'}</span></div><b>{b.remaining}本</b></div>)}</div> : <Empty>手元に記録されたバッテリーはありません。</Empty>}<p className="field-hint">古い取出分から消費する先入先出です。棚卸で増えた分の取出日は不明として扱います。</p></section></div>;
}

export function RecordList({ records, settings, onEdit }: { records: EnrichedRecord[]; settings: Settings; onEdit: (r: WorkRecord) => void }) {
  if (!records.length) return <Empty>記録はまだありません。</Empty>;
  return <div className="record-list">{records.map(r => { const Icon = r.type === 'refill' ? ArrowDownToLine : r.type === 'pickup' ? ArrowUpFromLine : ScanLine; return <button className={`record-row ${r.type}`} key={r.id} onClick={() => onEdit(r)}><span className={`round-icon ${r.type}`}><Icon size={21}/></span><span className="record-description"><strong>{typeLabel(r.type)} <span>{dateLabel(r.date)}</span></strong><small>{r.type === 'refill' ? `${settings.regionNames[r.area]} · 早期 ${r.earlyCount}本` : r.type === 'pickup' ? '在庫に追加' : r.applied ? '在庫へ反映済み' : '確認記録のみ'}</small>{r.note && <small className="record-note">{r.note}</small>}{r.errors.length > 0 && <small className="warning-text">要確認：{r.errors[0]}</small>}</span><span className="record-value"><strong>{r.quantity}<small>本</small></strong><small>{r.type === 'refill' ? `¥${money(r.total)}` : `在庫 ${r.stockAfter}本`}</small></span><Pencil size={16}/></button>; })}</div>;
}
export function HistoryView({ summary, settings, onEdit }: Shared & { onEdit: (r: WorkRecord) => void }) {
  const [type, setType] = useState('all'); const [area, setArea] = useState('all'); const [date, setDate] = useState('');
  const records = useMemo(() => summary.records.filter(r => (type === 'all' || r.type === type) && (area === 'all' || r.area === area) && (!date || r.date === date)).slice().reverse(), [summary.records, type, area, date]);
  return <section className="panel"><div className="section-heading"><History size={22}/><h2>すべての記録</h2><span className="pill">{records.length}件</span></div><div className="segmented history-types">{[['all', 'すべて'], ['refill', '補充'], ['pickup', '取出'], ['adjustment', '棚卸']].map(([id, text]) => <button key={id} className={`${id === type ? 'selected' : ''} ${id}`} aria-pressed={id === type} onClick={() => setType(id)}>{text}</button>)}</div><div className="field-grid history-filters"><label className="field">日付で絞り込み<input type="date" value={date} onChange={e => setDate(e.target.value)}/></label><label className="field">地域で絞り込み<select value={area} onChange={e => setArea(e.target.value)}><option value="all">すべての地域</option>{AREAS.map(a => <option value={a} key={a}>{settings.regionNames[a]}</option>)}</select></label></div>{(date || area !== 'all' || type !== 'all') && <button className="text-button" onClick={() => { setDate(''); setArea('all'); setType('all'); }}>絞り込みを解除</button>}<p className="field-hint">記録をタップすると編集・削除できます。</p><RecordList records={records} settings={settings} onEdit={onEdit}/></section>;
}

