"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  CloudDownload,
  Copy,
  Download,
  Eye,
  EyeOff,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { parseSyncCode } from "@/lib/sync/protocol";
import type { SyncLocalPreferences } from "@/lib/sync/preferences";

export interface SyncPanelProps {
  preferences: SyncLocalPreferences;
  online: boolean;
  demo: boolean;
  syncing: boolean;
  reviewCount: number;
  onConfigure: (syncCode: string) => Promise<void>;
  onToggle: (enabled: boolean) => Promise<void>;
  onSync: () => Promise<void>;
  onDisconnect: (deleteCloud: boolean) => Promise<void>;
  onReview: () => void;
}

function dateTime(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "まだありません";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function SyncPanel({
  preferences,
  online,
  demo,
  syncing,
  reviewCount,
  onConfigure,
  onToggle,
  onSync,
  onDisconnect,
  onReview,
}: SyncPanelProps) {
  const [draft, setDraft] = useState(preferences.syncCode ?? "");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  const configured = !!preferences.syncCode;

  useEffect(() => {
    setDraft(preferences.syncCode ?? "");
  }, [preferences.syncCode]);

  async function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || demo) return;
    setError("");
    try {
      parseSyncCode(draft);
      setSaving(true);
      await onConfigure(draft.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "同期コードを保存できませんでした。");
    } finally {
      setSaving(false);
    }
  }

  async function copyCode() {
    if (!preferences.syncCode) return;
    try {
      await navigator.clipboard.writeText(preferences.syncCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setRevealed(true);
      requestAnimationFrame(() => codeInput.current?.select());
      setError("自動コピーできませんでした。表示した同期コードを長押ししてコピーしてください。");
    }
  }

  async function disconnect(deleteCloud: boolean) {
    if (saving || syncing) return;
    setError("");
    try {
      setSaving(true);
      await onDisconnect(deleteCloud);
      setDisconnecting(false);
      setRevealed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "同期を解除できませんでした。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel settings-section auto-sync-panel" aria-labelledby="auto-sync-heading">
      <div className="section-heading sync-heading">
        <span className="round-icon sync-icon" aria-hidden="true"><CloudDownload size={22} /></span>
        <div>
          <h2 id="auto-sync-heading">SPOTJOBS自動取り込み</h2>
          <p className="muted">自宅PCのEdgeで完了履歴を確認し、この端末へ暗号化同期します。</p>
        </div>
        <span className={`sync-state ${configured && preferences.enabled ? "active" : ""}`}>
          {configured ? (preferences.enabled ? "自動同期 ON" : "一時停止中") : "未接続"}
        </span>
      </div>

      <div className="sync-privacy">
        <ShieldCheck size={19} aria-hidden="true" />
        <p><strong>パスワード・Cookieは読み取り・保存しません。</strong>履歴はPC内で暗号化し、同期サーバーには内容を読めない暗号文だけを最大90日保存します。</p>
      </div>

      <p className="notice"><strong>現在は個人向けの許可制ベータです。</strong>同期ブリッジに登録済みのコードだけ接続できます。新しいコードは、チャネル登録後に使えます。</p>

      {!configured ? (
        <form className="settings-section sync-connect" onSubmit={configure}>
          <div className="sync-steps" aria-label="自動同期の設定手順">
            <span><b>1</b>登録済みコードを貼る</span>
            <span><b>2</b>Edge拡張へ貼る</span>
            <span><b>3</b>自動で取り込む</span>
          </div>
          <label className="field" htmlFor="sync-code">
            同期コード
            <span className="secret-field">
              <input
                ref={codeInput}
                id="sync-code"
                name="sync-code"
                type={revealed ? "text" : "password"}
                value={draft}
                onChange={event => { setDraft(event.target.value); setError(""); }}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="別の端末のコードを貼り付け"
                disabled={saving || demo}
                required
                aria-describedby="sync-code-help"
              />
              <button type="button" aria-label={revealed ? "同期コードを隠す" : "同期コードを表示"} onClick={() => setRevealed(value => !value)}>
                {revealed ? <EyeOff size={19} /> : <Eye size={19} />}
              </button>
            </span>
          </label>
          <p id="sync-code-help" className="field-hint">同じコードをEdge拡張、Web、今後のiOS／Android版で使います。コードはこの端末だけに保存し、JSONバックアップへ含めません。失うと暗号文は復号できません。</p>
          <div className="sync-connect-actions">
            <button className="button button-primary" type="submit" disabled={saving || !draft.trim() || demo}>
              <ShieldCheck size={18} aria-hidden="true" />{saving ? "接続しています…" : "このコードで接続"}
            </button>
          </div>
          {demo && <p className="notice">デモ表示中は同期設定を変更できません。自分の記録に戻って設定してください。</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </form>
      ) : (
        <div className="settings-section sync-connected">
          <dl className="sync-summary">
            <div><dt>最終同期</dt><dd>{dateTime(preferences.lastSuccessAt)}</dd></div>
            <div><dt>状態</dt><dd className={preferences.lastStatus === "error" ? "danger" : ""}>{syncing ? "同期中…" : preferences.lastMessage ?? "接続済み"}</dd></div>
          </dl>

          {preferences.importAfter && (
            <p className="notice"><ShieldCheck size={18} aria-hidden="true" />既存記録の二重計上を防ぐため、接続した{dateTime(preferences.importAfter)}以降に完了した履歴を取り込みます。</p>
          )}

          {reviewCount > 0 && (
            <button className="sync-review" type="button" onClick={onReview}>
              <AlertTriangle size={20} aria-hidden="true" />
              <span><strong>補充 {reviewCount}件の地域・早期対象を確認</strong><small>履歴から編集すると確認済みになります</small></span>
            </button>
          )}

          <div className="sync-actions">
            <button className="button button-primary" type="button" disabled={!online || syncing || demo || !preferences.enabled} onClick={() => void onSync()}>
              <RefreshCw className={syncing ? "spin" : ""} size={19} aria-hidden="true" />{syncing ? "同期しています…" : "今すぐ同期"}
            </button>
            <button className="button button-secondary" type="button" disabled={saving || demo} onClick={() => void onToggle(!preferences.enabled)}>
              {preferences.enabled ? "自動同期を一時停止" : "自動同期を再開"}
            </button>
          </div>
          {!online && <p className="notice"><AlertTriangle size={18} aria-hidden="true" />オフラインです。入力はそのまま使え、再接続後に同期します。</p>}

          <details className="sync-code-details">
            <summary>同期コードを別の端末へコピー</summary>
            <label className="field" htmlFor="saved-sync-code">
              同期コード
              <span className="secret-field">
                <input
                  ref={codeInput}
                  id="saved-sync-code"
                  type={revealed ? "text" : "password"}
                  value={preferences.syncCode}
                  readOnly
                  spellCheck={false}
                  aria-label="保存済みの同期コード"
                />
                <button type="button" aria-label={revealed ? "同期コードを隠す" : "同期コードを表示"} onClick={() => setRevealed(value => !value)}>
                  {revealed ? <EyeOff size={19} /> : <Eye size={19} />}
                </button>
              </span>
            </label>
            <button className="button button-secondary" type="button" onClick={() => void copyCode()}>
              <Copy size={18} aria-hidden="true" />{copied ? "コピーしました" : "同期コードをコピー"}
            </button>
          </details>

          <div className="sync-extension">
            <div><strong>PC側のEdge拡張</strong><p className="muted">展開して読み込み、上の同期コードを貼り付けます。初期設定は30分ごとです。ログイン済みのジョブ履歴タブを開いておきます。</p></div>
            <a className="button button-secondary" href="/downloads/spotjobs-reward-inventory-edge-extension.zip" download>
              <Download size={18} aria-hidden="true" />Edge拡張をダウンロード
            </a>
          </div>

          {!disconnecting ? (
            <button className="text-button danger" type="button" onClick={() => setDisconnecting(true)}><Trash2 size={17} aria-hidden="true" />同期を解除</button>
          ) : (
            <div className="sync-disconnect warning">
              <AlertTriangle size={20} aria-hidden="true" />
              <div>
                <strong>同期を解除しますか？</strong>
                <p>端末内の作業記録は消えません。Edge拡張側も解除しないと、暗号化データが再作成されます。</p>
                <div className="dialog-actions">
                  <button className="button button-secondary" type="button" disabled={saving} onClick={() => setDisconnecting(false)}>キャンセル</button>
                  <button className="button button-secondary" type="button" disabled={saving} onClick={() => void disconnect(false)}>この端末だけ解除</button>
                  <button className="button button-danger" type="button" disabled={saving || !online} onClick={() => void disconnect(true)}>暗号化データも削除</button>
                </div>
              </div>
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}
