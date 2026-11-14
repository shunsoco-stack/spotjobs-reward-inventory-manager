"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  CloudDownload,
  Copy,
  Download,
  Eye,
  EyeOff,
  Link2,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react";
import { createSyncPairingUrl } from "@/lib/sync/pairing-link";
import { parseSyncCode } from "@/lib/sync/protocol";
import type { SyncLocalPreferences } from "@/lib/sync/preferences";

export type SyncImportMode = "all" | "future";

export interface SyncPanelProps {
  preferences: SyncLocalPreferences;
  online: boolean;
  demo: boolean;
  syncing: boolean;
  reviewCount: number;
  hasExistingRecords: boolean;
  incomingSyncCode?: string;
  onConfigure: (syncCode: string, importMode: SyncImportMode) => Promise<void>;
  onBackfill: () => Promise<void>;
  onToggle: (enabled: boolean) => Promise<void>;
  onSync: () => Promise<void>;
  onDisconnect: (deleteCloud: boolean) => Promise<void>;
  onReview: () => void;
}

function PairingQr({ syncCode }: { syncCode: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pairingUrl, setPairingUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const target = canvas.current;
    if (!target) return;
    let url: string;
    try {
      url = createSyncPairingUrl(syncCode, window.location.href);
    } catch {
      setError("安全な接続リンクを作成できませんでした。同期コードをコピーしてください。");
      return;
    }
    setPairingUrl(url);
    setError("");
    void import("qrcode")
      .then(module => module.toCanvas(target, url, {
        width: 232,
        margin: 2,
        errorCorrectionLevel: "M",
        color: { dark: "#102e29", light: "#ffffff" },
      }))
      .catch(() => { if (active) setError("QRコードを表示できませんでした。接続リンクか同期コードをコピーしてください。"); });
    return () => { active = false; };
  }, [syncCode]);

  async function copyPairingLink() {
    if (!pairingUrl) return;
    try {
      await navigator.clipboard.writeText(pairingUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("接続リンクをコピーできませんでした。下の同期コードをコピーしてください。");
    }
  }

  return <div className="sync-pairing-qr">
    <div className="sync-qr-frame"><canvas ref={canvas} role="img" aria-label="スマホ接続用QRコード">スマホ接続用QRコード</canvas></div>
    <div className="sync-qr-copy">
      <strong><Smartphone size={18} aria-hidden="true" />スマホで読み取る</strong>
      <p>カメラで読み取り、表示された画面で接続を確定します。普段ホーム画面版を使う場合は、そちらでも接続が必要になる場合があります。コードはURLの#以降だけに入り、Vercelへ送信されません。</p>
      <button className="button button-secondary" type="button" onClick={() => void copyPairingLink()}>
        <Link2 size={18} aria-hidden="true" />{copied ? "接続リンクをコピーしました" : "接続リンクをコピー"}
      </button>
    </div>
    <p className="sync-secret-warning"><ShieldCheck size={17} aria-hidden="true" />このQRは同期の鍵です。自分の端末だけで読み取ってください。</p>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
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
  hasExistingRecords,
  incomingSyncCode,
  onConfigure,
  onBackfill,
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
  const [backfillConfirm, setBackfillConfirm] = useState(false);
  const [importMode, setImportMode] = useState<SyncImportMode | null>(hasExistingRecords ? null : "all");
  const [pairingOpen, setPairingOpen] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  const receivedCode = useRef<HTMLDivElement>(null);
  const configured = !!preferences.syncCode;

  useEffect(() => {
    setDraft(preferences.syncCode ?? "");
  }, [preferences.syncCode]);

  useEffect(() => {
    if (!configured && incomingSyncCode) {
      setDraft(incomingSyncCode);
      setError("");
      const frame = window.requestAnimationFrame(() => {
        const target = receivedCode.current;
        if (!target) return;
        target.focus({ preventScroll: true });
        target.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
          block: "start",
        });
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [configured, incomingSyncCode]);

  useEffect(() => {
    if (!configured) setImportMode(hasExistingRecords ? null : "all");
  }, [configured, hasExistingRecords]);

  async function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || demo) return;
    setError("");
    try {
      parseSyncCode(draft);
      if (!importMode) throw new Error("過去の履歴を取り込むか選んでください。");
      setSaving(true);
      await onConfigure(draft.trim(), importMode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "同期コードを保存できませんでした。");
    } finally {
      setSaving(false);
    }
  }

  async function backfill() {
    if (saving || syncing || demo) return;
    setError("");
    try {
      setSaving(true);
      await onBackfill();
      setBackfillConfirm(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "過去履歴を取り込めませんでした。");
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
          {incomingSyncCode && <div ref={receivedCode} className="sync-code-received" role="status" tabIndex={-1}>
            <Smartphone size={22} aria-hidden="true" />
            <div><strong>スマホ接続コードを受け取りました</strong><p>この端末で取り込む範囲を確認して、接続を確定してください。</p></div>
          </div>}
          <div className="sync-steps" aria-label="自動同期の設定手順">
            <span><b>1</b>端末ごとにコードを設定</span>
            <span><b>2</b>Edge拡張にも同じコード</span>
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
          <p id="sync-code-help" className="field-hint">PCで接続済みでも、スマホではこの設定が1回必要です。同じコードをEdge拡張、Web、今後のiOS／Android版で使います。コードはこの端末だけに保存し、JSONバックアップへ含めません。</p>
          <p className="notice"><Smartphone size={18} aria-hidden="true" />同期設定は、普段使うSafari／Chrome版とホーム画面版でそれぞれ必要になる場合があります。今後使う方の画面で接続してください。</p>
          {hasExistingRecords && <fieldset className="sync-import-choice">
            <legend>この端末へ取り込む範囲</legend>
            <label className={importMode === "all" ? "selected" : ""}>
              <input type="radio" name="sync-import-mode" value="all" checked={importMode === "all"} onChange={() => setImportMode("all")} />
              <span><strong>過去履歴も取り込む</strong><small>PCにある履歴をまとめて同期。スクショ取込は一致すれば統合しますが、同じ作業を手入力している場合は重複する可能性があります。</small></span>
            </label>
            <label className={importMode === "future" ? "selected" : ""}>
              <input type="radio" name="sync-import-mode" value="future" checked={importMode === "future"} onChange={() => setImportMode("future")} />
              <span><strong>今後の履歴だけ</strong><small>この端末の既存記録を優先し、接続後に完了した履歴だけ同期します。</small></span>
            </label>
            {!importMode && <p className="field-hint">どちらかを選ぶと接続できます。</p>}
          </fieldset>}
          <div className="sync-connect-actions">
            <button className="button button-primary" type="submit" disabled={saving || !draft.trim() || !importMode || demo}>
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

          {preferences.importAfter && <div className="sync-backfill notice">
            <ShieldCheck size={18} aria-hidden="true" />
            <div><strong>現在は今後の履歴だけを同期</strong><p>接続した{dateTime(preferences.importAfter)}以降に完了した履歴を取り込みます。</p>
              {!backfillConfirm ? <button className="text-button" type="button" onClick={() => setBackfillConfirm(true)}>過去履歴も取り込む</button> : <div className="sync-backfill-confirm warning">
                <AlertTriangle size={19} aria-hidden="true" /><div><strong>過去履歴を取り込みますか？</strong><p>手入力した同じ作業がある場合は重複する可能性があります。スクショ取込は完了時刻・種別・本数が一致すれば統合します。</p><div className="dialog-actions"><button className="button button-secondary" type="button" onClick={() => setBackfillConfirm(false)}>キャンセル</button><button className="button button-primary" type="button" disabled={saving || syncing || !online} onClick={() => void backfill()}>{saving ? "取り込み中…" : "過去履歴を取り込む"}</button></div></div>
              </div>}
            </div>
          </div>}

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

          <details className="sync-code-details sync-device-pairing" onToggle={event => setPairingOpen(event.currentTarget.open)}>
            <summary><QrCode size={22} aria-hidden="true" /><span><strong>スマホ・別端末を接続</strong><small>QRを読み取って接続を確認</small></span></summary>
            {pairingOpen && <PairingQr syncCode={preferences.syncCode!} />}
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
