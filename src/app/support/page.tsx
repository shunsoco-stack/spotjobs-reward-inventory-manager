import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, legalPageStyles as styles } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "サポート | SPOTJOBS報酬・在庫管理アプリ",
  description: "SPOTJOBS報酬・在庫管理アプリのデータ保存、バックアップ、オフライン利用、スクリーンショット読取に関するサポート情報です。",
  alternates: { canonical: "https://spotjobs-reward-inventory-manager.vercel.app/support" },
  robots: { index: true, follow: true },
};

export default function SupportPage() {
  return <LegalPage
    current="support"
    eyebrow="SUPPORT"
    title="サポート"
    description="困ったときの確認方法と、不具合・要望の連絡先をまとめています。"
    updated="2026年10月17日"
  >
    <section className={styles.section} aria-labelledby="support-first">
      <h2 id="support-first">最初に確認してください</h2>
      <div className={styles.callout}>
        <strong>記録は、現在使用している端末とブラウザ内に保存されます。</strong>
        <p>ログインやクラウド同期はありません。別の端末・ブラウザ・公開URLへ自動では移りません。端末変更前には設定画面からJSONバックアップを保存してください。</p>
      </div>
      <div className={styles.actions}>
        <Link className={styles.primaryAction} href="/" prefetch={false}>アプリを開く</Link>
        <a className={styles.secondaryAction} href="/privacy.html">データの取り扱いを見る</a>
      </div>
    </section>

    <section className={styles.section} aria-labelledby="support-faq">
      <h2 id="support-faq">よくある問題</h2>
      <h3>記録が見つからない</h3>
      <ol>
        <li>以前と同じ端末、ブラウザ、公開URLで開いているか確認してください。</li>
        <li>デモデータ表示中の場合は、設定画面の「自分の記録に戻る」を選んでください。</li>
        <li>プライベートブラウズの終了、サイトデータの削除、アプリの削除後は、端末内の記録が残らない場合があります。</li>
        <li>JSONバックアップがある場合は、設定画面の「バックアップを復元（JSON）」から内容を確認して復元してください。</li>
      </ol>

      <h3>オフラインで開けない</h3>
      <p>Web版とホーム画面へ追加したPWAでは、初回利用時、更新後、またはブラウザのキャッシュ削除後に、オンラインでアプリを開き直してください。「オフラインで使う準備ができています」と表示された後に、補充・取出入力、ダッシュボード、履歴確認などをオフラインで利用できます。App Store版は必要なアプリ資産を同梱するため、インストール完了後の基本機能に通信は必要ありません。</p>

      <h3>スクリーンショットを読み取れない</h3>
      <p>Web版とPWAでは、文字認識用データの初回準備に通信が必要です。接続した状態でもう一度開き、文字が読める解像度のジョブ履歴画像を選んでください。App Store版には文字認識用データを同梱するため、端末内でオフライン処理できます。自動認識の結果は確定情報ではないため、日付、補充・取出、本数、店舗名を必ず確認・修正してから登録してください。</p>

      <h3>報酬が公式表示と合わない</h3>
      <p>本アプリの報酬は、登録内容と設定に基づく見込みです。設定画面で地域単価、早期補充条件、本数ボーナス、週の開始曜日を確認してください。確定額と最新条件はSPOTJOBS公式サービスで確認してください。</p>

      <h3>在庫が実数と合わない</h3>
      <p>履歴で補充・取出の入力漏れや重複を確認してください。実際の本数を確認できた場合は「在庫・棚卸」から棚卸数を登録し、差異を確認してから在庫へ反映できます。</p>
    </section>

    <section className={styles.section} aria-labelledby="support-backup">
      <h2 id="support-backup">バックアップと機種変更</h2>
      <ol>
        <li>移行元の設定画面で「バックアップを保存（JSON）」を選びます。</li>
        <li>保存したJSONファイルを、新しい端末へ安全な方法で移します。</li>
        <li>移行先で「バックアップを復元（JSON）」を選びます。</li>
        <li>作成日時、記録件数、対象期間を確認してから上書きします。</li>
      </ol>
      <p>CSVは表計算との受け渡しに利用できますが、設定を含む端末移行にはJSONバックアップを推奨します。開発者は端末内データを保有していないため、バックアップがない記録を代理で復元できません。</p>
    </section>

    <section className={styles.section} aria-labelledby="support-contact">
      <h2 id="support-contact">不具合・要望を連絡する</h2>
      <p>公開GitHubリポジトリのIssuesから受け付けます。GitHubアカウントが必要です。調査しやすいよう、次の情報を記載してください。</p>
      <ul>
        <li>Web、iPhone、Androidなど利用している版</li>
        <li>OSとブラウザ、またはアプリのバージョン</li>
        <li>問題が起きるまでの操作と、画面に表示されたエラー文</li>
        <li>オンライン／オフライン、通常データ／デモデータのどちらか</li>
      </ul>
      <p><strong>Issueは公開されます。</strong>実際の作業履歴、店舗名、スクリーンショット、JSON・CSV、氏名、連絡先、ログイン情報を添付しないでください。</p>
      <div className={styles.actions}>
        <a className={styles.primaryAction} href="https://github.com/shunsoco-stack/spotjobs-reward-inventory-manager/issues/new" target="_blank" rel="noopener noreferrer external">GitHub Issueを作成</a>
        <a className={styles.secondaryAction} href="https://github.com/shunsoco-stack/spotjobs-reward-inventory-manager" target="_blank" rel="noopener noreferrer external">ソースコードを見る</a>
      </div>
    </section>

    <section className={styles.section} aria-labelledby="support-scope">
      <h2 id="support-scope">サポート範囲</h2>
      <p>本アプリは個人制作の非公式ツールです。SPOTJOBSのアカウント、案件、報酬確定、モバイルバッテリーや公式アプリに関する問い合わせには対応できません。これらはSPOTJOBS公式サービスの案内を確認してください。</p>
    </section>
  </LegalPage>;
}
