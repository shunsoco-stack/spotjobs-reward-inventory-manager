"use client";

import { useRef, useState, type FormEvent } from "react";
import { Check, Download, FileSpreadsheet, Moon, Plus, Smartphone, Sun, Trash2, Upload } from "lucide-react";
import type { Area, Settings } from "../lib/core";

interface SettingsPanelProps {
  settings: Settings;
  onSave: (settings: Settings) => void | Promise<void>;
  onBackup: () => void;
  onImport: () => void;
  onCsv: () => void;
  onCsvImport: () => void;
  onDemo: () => void;
  demo: boolean;
}

const areas: Area[] = ["omitted", "A", "B", "C", "D"];
const weekdays = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];
const themes: { value: Settings["theme"]; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "ライト", icon: Sun },
  { value: "dark", label: "ダーク", icon: Moon },
  { value: "system", label: "端末に合わせる", icon: Smartphone },
];
type TierDraft = { id: number; count: string; rate: string };

function readInteger(data: FormData, name: string, label: string, min: number, max: number): number {
  const value = data.get(name);
  const number = typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label}は ${min.toLocaleString("ja-JP")}〜${max.toLocaleString("ja-JP")} の整数で入力してください。`);
  }
  return number;
}

function readText(data: FormData, name: string, label: string, max: number): string {
  const value = data.get(name);
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) throw new Error(`${label}を${max}文字以内で入力してください。`);
  return text;
}

function validateTiers(tiers: TierDraft[]): string {
  if (!tiers.length || tiers.length > 10) return "本数ボーナスは1〜10段階で設定してください。";
  let previousCount = -1;
  let previousRate = -1;
  for (const [index, tier] of tiers.entries()) {
    const count = tier.count.trim() ? Number(tier.count) : NaN;
    const rate = tier.rate.trim() ? Number(tier.rate) : NaN;
    if (!Number.isSafeInteger(count) || count < 0 || count > 99_999) return `${index + 1}段階目の開始本数は0〜99,999の整数で入力してください。`;
    if (!Number.isSafeInteger(rate) || rate < 0 || rate > 10_000) return `${index + 1}段階目の追加単価は0〜10,000の整数で入力してください。`;
    if (index === 0 && count !== 0) return "最初の段階は0本から始めてください。";
    if (count <= previousCount) return "開始本数は重複させず、上から小さい順に入力してください。";
    if (rate < previousRate) return "追加単価は、前の段階と同じか高い金額にしてください。";
    previousCount = count;
    previousRate = rate;
  }
  return "";
}

function SettingsForm({ settings, onSave }: Pick<SettingsPanelProps, "settings" | "onSave">) {
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [theme, setTheme] = useState(settings.theme);
  const [tiers, setTiers] = useState<TierDraft[]>(() => settings.thresholds.map((tier, id) => ({ id, count: String(tier.count), rate: String(tier.rate) })));
  const nextTierId = useRef(settings.thresholds.length);
  const tierError = validateTiers(tiers);

  function updateTier(id: number, field: "count" | "rate", value: string) {
    setSaved(false);
    setTiers(current => current.map(tier => tier.id === id ? { ...tier, [field]: value } : tier));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setError("");
    setSaved(false);
    try {
      if (tierError) throw new Error(tierError);
      const data = new FormData(event.currentTarget);
      const regionRates = { ...settings.regionRates };
      const regionNames = { ...settings.regionNames };
      const regionDescriptions = { ...settings.regionDescriptions };
      for (const area of areas) {
        const label = area === "omitted" ? "地域省略時" : `エリア${area}`;
        regionRates[area] = readInteger(data, `region-rate-${area}`, `${label}の単価`, 0, 10_000);
        regionNames[area] = readText(data, `region-name-${area}`, `${label}の名称`, 100);
        regionDescriptions[area] = readText(data, `region-description-${area}`, `${label}の説明`, 500);
      }
      const defaultArea = data.get("default-area");
      if (!areas.includes(defaultArea as Area)) throw new Error("最初に選択するエリアを選んでください。");
      const nextSettings: Settings = {
        ...settings,
        regionRates,
        regionNames,
        regionDescriptions,
        defaultArea: defaultArea as Area,
        thresholds: tiers.map(tier => ({ count: Number(tier.count), rate: Number(tier.rate) })),
        earlyDays: readInteger(data, "early-days", "早期補充の対象日数", 1, 365),
        earlyRate: readInteger(data, "early-rate", "早期補充の単価", 0, 10_000),
        weeklyGoal: readInteger(data, "weekly-goal", "週間目標", 1, Number.MAX_SAFE_INTEGER),
        weekStartsOn: readInteger(data, "week-start", "週の開始曜日", 0, 6) as Settings["weekStartsOn"],
        theme,
      };
      setSaving(true);
      await onSave(nextSettings);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存できませんでした。入力内容を確認して、もう一度お試しください。");
    } finally {
      setSaving(false);
    }
  }

  return <form className="panel settings-section" onSubmit={save} onChange={() => { setSaved(false); setError(""); }} aria-busy={saving}>
    <div className="section-heading"><div><h2>自分に合った設定に</h2><p className="muted">目標、計算条件、画面の見え方を調整できます。</p></div></div>

    <fieldset className="settings-section">
      <legend>目標と入力の初期値</legend>
      <div className="field-grid">
        <label className="field" htmlFor="weekly-goal">1週間の目標（円）<input id="weekly-goal" name="weekly-goal" type="number" inputMode="numeric" min={1} max={Number.MAX_SAFE_INTEGER} step={1} required defaultValue={settings.weeklyGoal} /></label>
        <label className="field" htmlFor="default-area">最初に選択するエリア<select id="default-area" name="default-area" defaultValue={settings.defaultArea}>{areas.map(area => <option key={area} value={area}>{area === "omitted" ? "地域省略" : `エリア${area}`} · {settings.regionNames[area]}</option>)}</select></label>
        <label className="field" htmlFor="week-start">週の開始曜日<select id="week-start" name="week-start" defaultValue={settings.weekStartsOn}>{weekdays.map((day, index) => <option value={index} key={day}>{day}</option>)}</select></label>
      </div>
    </fieldset>

    <fieldset className="settings-section">
      <legend>補充エリアと単価</legend>
      <p className="muted">地域を選ばないときは「地域省略」の単価で計算します。エリアAとは別々に設定できます。</p>
      {areas.map(area => <fieldset className="settings-section" key={area}>
        <legend>{area === "omitted" ? "地域省略時の基本単価" : `エリア${area}`}</legend>
        <div className="field-grid">
          <label className="field" htmlFor={`region-name-${area}`}>表示名<input id={`region-name-${area}`} name={`region-name-${area}`} type="text" maxLength={100} required defaultValue={settings.regionNames[area]} /></label>
          <label className="field" htmlFor={`region-rate-${area}`}>単価（円／本）<input id={`region-rate-${area}`} name={`region-rate-${area}`} type="number" inputMode="numeric" min={0} max={10_000} step={1} required defaultValue={settings.regionRates[area]} /></label>
        </div>
        <label className="field" htmlFor={`region-description-${area}`}>エリアの説明<input id={`region-description-${area}`} name={`region-description-${area}`} type="text" required maxLength={500} defaultValue={settings.regionDescriptions[area]} /></label>
      </fieldset>)}
    </fieldset>

    <fieldset className="settings-section">
      <legend>早期補充ボーナス</legend>
      <div className="field-grid">
        <label className="field" htmlFor="early-days">抜き取り日を含む対象日数（日）<input id="early-days" name="early-days" type="number" inputMode="numeric" min={1} max={365} step={1} required defaultValue={settings.earlyDays} /></label>
        <label className="field" htmlFor="early-rate">追加単価（円／本）<input id="early-rate" name="early-rate" type="number" inputMode="numeric" min={0} max={10_000} step={1} required defaultValue={settings.earlyRate} /></label>
      </div>
      <p className="muted">抜き取り日の分かる在庫から、古い順に自動判定します。対象本数は補充の記録で手入力もできます。</p>
    </fieldset>

    <fieldset className="settings-section" aria-describedby={tierError ? "tier-error" : "tier-help"}>
      <legend>週間の本数ボーナス</legend>
      <p id="tier-help" className="muted">週の補充合計で段階を決め、その週の補充全本数に加算します。最大10段階まで設定できます。</p>
      {tiers.map((tier, index) => <div className="settings-section" key={tier.id}>
        <div className="field-grid">
          <label className="field" htmlFor={`tier-count-${tier.id}`}>{index + 1}段階目 · 開始本数（本以上）<input id={`tier-count-${tier.id}`} type="number" inputMode="numeric" min={0} max={99_999} step={1} required readOnly={index === 0} value={tier.count} onChange={event => updateTier(tier.id, "count", event.target.value)} aria-describedby={index === 0 ? "first-tier-help" : undefined} /></label>
          <label className="field" htmlFor={`tier-rate-${tier.id}`}>追加単価（円／本）<input id={`tier-rate-${tier.id}`} type="number" inputMode="numeric" min={0} max={10_000} step={1} required value={tier.rate} onChange={event => updateTier(tier.id, "rate", event.target.value)} /></label>
        </div>
        {index === 0 ? <p id="first-tier-help" className="muted">最初の段階は0本から始まります。</p> : <button className="button button-secondary" type="button" onClick={() => { setSaved(false); setTiers(current => current.filter(value => value.id !== tier.id)); }} aria-label={`${index + 1}段階目のボーナスを削除`}><Trash2 size={16} aria-hidden="true" />この段階を削除</button>}
      </div>)}
      {tierError && <p id="tier-error" className="notice" role="alert">{tierError}</p>}
      <button className="button button-secondary" type="button" disabled={tiers.length >= 10 || !!tierError || Number(tiers.at(-1)?.count) >= 99_999} onClick={() => {
        const last = tiers.at(-1);
        const id = nextTierId.current++;
        setTiers(current => [...current, { id, count: String(Math.min(99_999, Number(last?.count ?? 0) + 50)), rate: String(Math.min(10_000, Number(last?.rate ?? 0) + 5)) }]);
        setSaved(false);
      }}><Plus size={18} aria-hidden="true" />段階を追加（{tiers.length} / 10）</button>
    </fieldset>

    <fieldset className="settings-section">
      <legend>画面の表示</legend>
      <div className="field-grid" role="group" aria-label="カラーテーマ">
        {themes.map(({ value, label, icon: Icon }) => <button className={`button ${theme === value ? "button-primary" : "button-secondary"}`} key={value} type="button" aria-pressed={theme === value} onClick={() => { setTheme(value); setSaved(false); }}><Icon size={18} aria-hidden="true" />{label}</button>)}
      </div>
      <p className="muted">「端末に合わせる」は、端末のライト／ダーク設定に合わせて表示します。</p>
    </fieldset>

    <p className="notice">地域・早期条件は新しい記録から適用します。本数ボーナスと週区切りは記録済みの週では維持し、新しい週から変更します。</p>
    {error && <p className="notice" role="alert">{error}</p>}
    {saved && <p className="notice" role="status"><Check size={18} aria-hidden="true" />設定を保存しました。</p>}
    <button className="button button-primary" type="submit" disabled={saving || !!tierError}>{saving ? "保存しています…" : "設定を保存する"}</button>
  </form>;
}

export function SettingsPanel(props: SettingsPanelProps) {
  return <div className="settings-section">
    <SettingsForm key={JSON.stringify(props.settings)} settings={props.settings} onSave={props.onSave} />
    <section className="panel settings-section" aria-labelledby="data-heading">
      <div className="section-heading"><div><h2 id="data-heading">記録を持ち運ぶ</h2><p className="muted">登録不要。記録はこのブラウザに保存します。</p></div></div>
      <p className="muted">端末やブラウザを変える前に、JSONバックアップを保存してください。ブラウザのデータを削除すると記録も消えます。</p>
      <div className="field-grid">
        <button className="button button-secondary" type="button" onClick={props.onBackup}><Download size={18} aria-hidden="true" />バックアップを保存（JSON）</button>
        <button className="button button-secondary" type="button" onClick={props.onImport}><Upload size={18} aria-hidden="true" />バックアップを復元（JSON）</button>
        <button className="button button-secondary" type="button" onClick={props.onCsv}><FileSpreadsheet size={18} aria-hidden="true" />作業記録を出力（CSV）</button>
        <button className="button button-secondary" type="button" onClick={props.onCsvImport}><Upload size={18} aria-hidden="true" />作業記録を取り込む（CSV）</button>
      </div>
      <p className="muted">JSONは記録と設定をまとめて保存する形式です。CSVは表計算との受け渡しに使えます。取り込み前に内容を確認できます。</p>
    </section>
    <section className="panel settings-section" aria-labelledby="calculation-heading">
      <div className="section-heading"><h2 id="calculation-heading">計算について</h2></div>
      <p className="muted">表示する報酬は、記録と設定に基づく目安です。最終的な条件・金額はSPOTJOBS公式アプリで確認してください。初期値は参考用で、単価や条件は変更できます。</p>
      <p className="muted">早期補充は、抜き取り日を含む3日間を初期設定としています。抜き取り日が不明な在庫は自動判定の対象に含めません。実際の対象本数に合わせて、補充記録で手入力できます。</p>
      <p className="muted">本アプリは個人制作の非公式アプリです。SPOTJOBS、ChargeSPOT、株式会社INFORICHとの提携・関係はありません。</p>
    </section>
    <section className="panel settings-section" aria-labelledby="install-heading">
      <div className="section-heading"><h2 id="install-heading">ホーム画面からすぐに</h2></div>
      <p className="muted">iPhoneはSafariの共有メニューから「ホーム画面に追加」。Androidはブラウザのメニューから「アプリをインストール」または「ホーム画面に追加」を選べます。</p>
      <p className="muted">最初の読み込みとオフライン用の保存が完了すると、通信がない場所でも記録できます。</p>
    </section>
    <section className="panel settings-section" aria-labelledby="demo-heading">
      <div className="section-heading"><h2 id="demo-heading">サンプルで試す</h2></div>
      <p className="muted">{props.demo ? "サンプルの記録を表示しています。自分の記録とは別に操作できます。" : "サンプルの記録で、入力方法や報酬・在庫の見え方を確認できます。"}</p>
      <button className="button button-secondary" type="button" onClick={props.onDemo}>{props.demo ? "自分の記録に戻る" : "サンプルを見る"}</button>
    </section>
  </div>;
}

export default SettingsPanel;
