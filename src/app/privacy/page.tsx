import type { Metadata } from "next";
import { LegalPage, legalPageStyles as styles } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "プライバシーポリシー | SPOTJOBS報酬・在庫管理アプリ",
  description: "SPOTJOBS報酬・在庫管理アプリにおける端末内データ、画像認識、バックアップ、外部リンクの取り扱いについて説明します。",
  alternates: { canonical: "https://spotjobs-reward-inventory-manager.vercel.app/privacy" },
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return <LegalPage
    current="privacy"
    eyebrow="PRIVACY"
    title="プライバシーポリシー"
    description="SPOTJOBS報酬・在庫管理アプリで扱う情報と、その保存場所・削除方法を説明します。"
    updated="2026年10月17日"
  >
    <section className={styles.section} aria-labelledby="privacy-scope">
      <h2 id="privacy-scope">1. 適用範囲</h2>
      <p>本ポリシーは、個人制作の「SPOTJOBS報酬・在庫管理アプリ」（以下「本アプリ」）に適用されます。本アプリは、SPOTJOBS、ChargeSPOT、株式会社INFORICHが提供する公式サービスではありません。</p>
      <p>本ページでは、現在公開しているバージョンの動作を記載しています。機能や外部サービスの追加により取り扱いが変わる場合は、実装前または公開時に本ポリシーを更新します。</p>
    </section>

    <section className={styles.section} aria-labelledby="privacy-data">
      <h2 id="privacy-data">2. 本アプリが扱う情報</h2>
      <dl className={styles.details}>
        <div>
          <dt>作業記録と設定</dt>
          <dd>補充・取出・棚卸の日付、本数、地域、早期補充、メモ、在庫、報酬条件、目標金額、表示設定などを扱います。これらは利用端末のIndexedDBに保存され、開発者のサーバーへ送信されません。</dd>
        </div>
        <div>
          <dt>ジョブ履歴のスクリーンショット</dt>
          <dd>利用者が選んだ画像は、Tesseract.jsを使って端末内で文字認識します。画像や認識途中の全文を外部の画像認識APIへ送りません。原画像はIndexedDB、JSONバックアップ、CSVへ保存されません。確認後に登録した作業内容とメモだけが作業記録として残ります。</dd>
        </div>
        <div>
          <dt>バックアップとCSV</dt>
          <dd>JSONバックアップとCSVは、利用者が操作したときだけ端末へ書き出します。保存先や、その後の共有先は利用者が選びます。読み込むファイルも端末内で解析します。</dd>
        </div>
      </dl>
    </section>

    <section className={styles.section} aria-labelledby="privacy-collection">
      <h2 id="privacy-collection">3. 収集・送信と外部サービス</h2>
      <div className={styles.callout}>
        <strong>現在のバージョンに、利用者アカウント、クラウド同期、独自の送信API、アクセス解析SDK、広告SDKはありません。</strong>
        <p>開発者は、端末内に保存された作業記録、画像、設定を閲覧・復元できません。</p>
      </div>
      <h3>Web版の配信</h3>
      <p>Web版はVercelを通じて静的ファイルと文字認識用データを配信します。Webページへの接続時には、配信、安全確保、不正利用防止に必要な一般的な接続情報がホスティング事業者によって処理される場合があります。App Store版では、アプリ本体と文字認識用データを端末へ同梱します。開発者は、どちらの版にも独自の行動分析機能を組み込んでいません。</p>
      <h3>利用者が開く外部リンク</h3>
      <p>SPOTJOBS公式サイト、Xの共有画面、GitHubのサポート画面などは、利用者がリンクを押したときだけ外部ブラウザで開きます。移動後は各サービスの規約とプライバシーポリシーが適用され、接続情報や利用者が入力・投稿した内容を各サービスが取り扱う場合があります。</p>
      <p>Xへの共有では、共有前に本アプリが作成した投稿文と公開Web版URLをXの投稿画面へ渡します。投稿は利用者が内容を確認し、X上で操作した場合にだけ行われます。</p>
    </section>

    <section className={styles.section} aria-labelledby="privacy-retention">
      <h2 id="privacy-retention">4. 保存期間と削除方法</h2>
      <ul>
        <li>作業記録と設定は、利用者が削除するか、ブラウザのサイトデータを消去するまで利用端末に残ります。</li>
        <li>個別の作業記録は、本アプリの「履歴」から開いて削除できます。</li>
        <li>端末内の全データを消す場合、Web版とホーム画面へ追加したPWAでは、ブラウザ設定から本アプリのサイトデータを削除してください。ホーム画面のアイコンを消すだけでは、サイトデータが残る場合があります。App Store版では、アプリをアンインストールするとアプリ内の保存領域も削除されます。</li>
        <li>書き出したJSONやCSVは本アプリの保存領域外にあります。不要になったファイルは、保存先の「ファイル」アプリやクラウドストレージなどから利用者自身で削除してください。</li>
      </ul>
      <p>本アプリにクラウド同期はないため、端末データの消去後に開発者が記録を復元することはできません。消去や端末変更の前にJSONバックアップを保存してください。</p>
    </section>

    <section className={styles.section} aria-labelledby="privacy-security">
      <h2 id="privacy-security">5. 安全に利用するために</h2>
      <p>端末の画面ロックを設定し、バックアップファイルを第三者が閲覧できない場所へ保存してください。メモ、スクリーンショット、バックアップ、問い合わせ内容には、氏名、住所、電話番号、ログイン情報など不要な個人情報を含めないでください。</p>
      <p>プライベートブラウズ、端末の空き容量不足、ブラウザによる保存領域の整理、アプリの削除などでデータが失われる場合があります。定期的なJSONバックアップを推奨します。</p>
    </section>

    <section className={styles.section} aria-labelledby="privacy-changes">
      <h2 id="privacy-changes">6. ポリシーの変更</h2>
      <p>広告、分析、クラウド同期など、情報の取り扱いに影響する機能を追加する場合は、本ページと各ストアのプライバシー表示を更新します。重要な変更がある場合は、アプリ内または公開ページで案内します。</p>
    </section>

    <section className={styles.section} aria-labelledby="privacy-contact">
      <h2 id="privacy-contact">7. お問い合わせ</h2>
      <p>本ポリシーや本アプリに関する問い合わせは、公開GitHubリポジトリのIssuesから受け付けます。Issueは公開されるため、実際の作業履歴、店舗名、スクリーンショット、バックアップファイル、その他の個人情報を投稿しないでください。</p>
      <div className={styles.actions}>
        <a className={styles.primaryAction} href="https://github.com/shunsoco-stack/spotjobs-reward-inventory-manager/issues/new" target="_blank" rel="noopener noreferrer external">GitHubで問い合わせる</a>
        <a className={styles.secondaryAction} href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer external">Vercelのプライバシーポリシー</a>
      </div>
    </section>
  </LegalPage>;
}
