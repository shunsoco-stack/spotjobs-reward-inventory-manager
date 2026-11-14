import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, legalPageStyles as styles } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "サポート | SPOTJOBS報酬・在庫管理アプリ",
  description: "SPOTJOBS報酬・在庫管理アプリのデータ保存、暗号化された自動取り込み、バックアップ、オフライン利用、スクリーンショット読取に関するサポート情報です。",
  alternates: { canonical: "https://spotjobs-reward-inventory-manager.vercel.app/support" },
  robots: { index: true, follow: true },
};

export default function SupportPage() {
  return <LegalPage
    current="support"
    eyebrow="SUPPORT"
    title="サポート"
    description="困ったときの確認方法と、不具合・要望の連絡先をまとめています。"
    updated="2026年11月13日"
  >
    <section className={styles.section} aria-labelledby="support-first">
      <h2 id="support-first">最初に確認してください</h2>
      <div className={styles.callout}>
        <strong>記録の正本は、現在使用している端末とブラウザ内に保存されます。</strong>
        <p>任意の自動取り込みはSPOTJOBS側の完了履歴だけを各端末へ追加します。設定・棚卸・手入力記録を含む完全な端末間同期やバックアップではありません。端末変更前には設定画面からJSONバックアップを保存してください。</p>
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

      <h3>自動取り込みが動かない</h3>
      <ol>
        <li>現在は個人向けの許可制ベータです。設定した同期コードに対応するチャネルが、同期ブリッジへ事前登録済みか確認してください。</li>
        <li>同じWebアプリURLを開くだけでは別端末へ同期設定は引き継がれません。PCの設定で「スマホ・別端末を接続」を開き、普段使うスマホ画面でQRを読み取って接続を確定してください。</li>
        <li>PCのEdgeへ専用拡張を「展開して読み込み」、アプリと同じ同期コードを設定してください。</li>
        <li>Edgeで<code>https://app.spot.jobs/user-job-list</code>をログイン済みの状態で開いてください。</li>
        <li>PCが起動していて、スリープしていないことを確認してください。Edge終了中、PCのスリープ中、SPOTJOBSからログアウト中は取得できません。</li>
        <li>Edge拡張で「今すぐ同期」を実行し、その後アプリの設定画面でも「今すぐ同期」を押してください。</li>
      </ol>
      <p>初期設定は30分ごとで、15分または60分へ変更できます。復帰後は次回同期で差分を確認します。アプリがオフラインの間も手入力は使え、再接続後に取り込めます。</p>
      <p>空の新規端末では、同期Inboxに残っている最新履歴（最大500件）を取り込みます。すでに記録がある端末では、「過去履歴も取り込む」または「今後の履歴だけ」を接続時に選べます。過去取込では同じ手入力が重複する可能性があるため、確認後に実行してください。以前「今後の履歴だけ」で接続した場合も、設定から過去履歴を追加できます。</p>
      <p>Safari／Chrome版とホーム画面版で保存領域が分かれる場合があります。QRを読み取った画面ではなくホーム画面版を普段使う場合は、ホーム画面版の設定でも接続状態を確認してください。</p>

      <h3>自動取り込み後に「要確認」と表示される</h3>
      <p>SPOTJOBS側の履歴だけでは補充の地域や早期対象を確定できない場合があります。履歴から対象記録を編集し、地域と早期対象を確認して保存すると確認済みになります。公式側の作業ID、またはスクリーンショット記録の完了日時・種類が一致する記録は重複を避けます。</p>

      <h3>同期コードを失った・第三者に見られた</h3>
      <p>同期コードは暗号文を復号する鍵の元になるため、パスワードと同様に管理してください。コードを失うと既存の暗号文を復号できません。第三者に知られた可能性がある場合は、アプリとEdge拡張の同期を止め、設定画面で同期解除時に「暗号化データも削除」を選び、新しい許可済みチャネルへ切り替えてください。</p>

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
      <p>CSVは表計算との受け渡しに利用できますが、設定を含む端末移行にはJSONバックアップを推奨します。同期コードはJSONへ含まれないため、利用を続ける場合は別途安全に移してください。自動取り込みは公式完了履歴だけが対象で、開発者は端末内データや復号鍵を保有していないため、バックアップがない設定・棚卸・手入力記録を代理で復元できません。</p>
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
