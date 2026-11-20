# SPOTJOBS報酬・在庫管理 自動同期（Edge拡張）

ログイン済みのSPOTJOBS（拡張が背景で開く専用の同期用タブ `https://app.spot.jobs/user-job-list`）から、完了した補充・取出を定期確認し、端末内で暗号化して「SPOTJOBS報酬・在庫管理アプリ」専用の同期ブリッジへ保存するManifest V3拡張です。

## 取得の仕組み（v0.3.0）

- 拡張は自分で開いた同期用タブ（背景タブ）の中で、公式の完了履歴APIへ **1回の同期につき1回だけ** 読み取り専用のGETを送ります。送信先は `https://spotjobs-api.spotapi.jp/api/v1/rounder/work?taskStatus=FINISHED&pageNum=1&pageSize=50` の1つだけで、URLは拡張内の固定値です。送信前にHTTPS・ホスト名・パス・GETであることを確認し、一致しなければ通信しません。位置情報・ページ送り・再試行は使いません。
- 認証には、公式Webアプリと同じく、そのページでログイン中のSPOTJOBS（Firebase）が保存しているIDトークンを使います。ページ内で読み取り、そのGET 1回の `Authorization` Headerにだけ使い、拡張の保存領域・同期サーバー・ログ・画面のどこにも保存・送信しません。リフレッシュトークンやユーザー情報は読み取らず、トークンの更新（Googleの認証サーバーへの通信）も行いません。Cookieは送信しません。
- 公式画面のボタン操作、通信のフック、タブの再読み込みは一切行いません。
- SPOTJOBSへの通信は、定期同期（初期値30分）・スマホからの取得依頼・Popupの「接続して同期」「今すぐ同期」のときだけです。ブラウザー起動時やSPOTJOBSのページを開いたときに自動で取得することはありません。
- 前回のSPOTJOBSへの通信から60秒以内に同期が要求された場合は通信せず、前回の結果をそのまま返します。
- SPOTJOBSのログインが切れている場合（401/403、またはログイン情報がない場合）は「SPOTJOBSのログインが切れています」と表示し、スマホにはログアウト時のエラーとして表示されます。PCのEdgeでSPOTJOBSにログインし直してください。ログイン情報の有効期限が切れたまま更新されていない場合は、SPOTJOBSを開いたままにしてしばらくしてから再試行してください。

## プライバシー設計

- SPOTJOBSのパスワード、Cookie、Session Storageを読み取りません。ページ内で読むのは上記のIDトークンと有効期限だけで、ページの外へは出しません。
- 同期ブリッジへ送る前にAES-GCMで暗号化します。
- 同期コードからHKDF-SHA-256で認証用Tokenと暗号鍵を別々に導出します。
- 同期サーバーが受け取る作業履歴の内容は暗号文です（Protocol Version、件数、同期時刻のみMetadataとして付与します）。
- 権限はSPOTJOBS（`app.spot.jobs`）、このアプリ専用の同期サーバー、開発時にユーザーが許可したlocalhostだけです。APIへの通信はSPOTJOBSのページ内から行うため、APIホストへの追加権限はありません。

## 開発者向けテスト

```bash
cd browser-extension
npm test
```

## Edgeへ読み込む

1. アプリ設定画面へ、事前登録済みの同期コードを入力します。
2. Edgeで `edge://extensions` を開き、開発者モードを有効にします。
3. 「展開して読み込み」からこの `browser-extension` フォルダを選びます。
4. 拡張のPopupに同期コードを貼り付けて「接続して同期」を押します。
5. EdgeでSPOTJOBSにログインしたままにしておきます。ジョブ履歴画面を自分で開いておく必要はありません。

ブラウザー終了中、PCのSleep中、SPOTJOBSからログアウト中は取得できません。復帰後の次回同期で差分を取得します。

既存の展開済み拡張を更新する場合は、同じフォルダのファイルを更新して `edge://extensions` でこの拡張を再読み込みしてください。同期コードは維持されます。v0.2.0以降にはスマホからの取得依頼への応答機能があり、Chromium 120以降のEdge / Chromeが必要です。

v0.3.0では、背景タブで公式画面の位置情報取得が止まり履歴を取得できなかった問題を、上記のページ内からの直接GETに置き換えて解消しています。

## 同期用タブ

- 拡張は自分で開いた同期用タブ（`https://app.spot.jobs/user-job-list`）だけから履歴を取得します。同期時に同期用タブがなければ、既存のEdgeウィンドウへ背景タブとして開きます（タブを前面に出したり、ウィンドウを切り替えたりしません）。
- ユーザーが自分で開いたSPOTJOBSのタブは、選択・再読み込み・移動・クローズを一切行いません。
- 同期用タブを閉じても、次回の同期で開き直します（閉じた直後に開き直すことはありません）。同期用タブで別のページへ移動した場合も、そのタブには触れずに新しい同期用タブを開きます。
- Edgeのウィンドウが1つも開いていない場合は新しいウィンドウを作らず、「同期用タブを開けません」と表示します。
- 拡張はどのタブも再読み込みしません。同期用タブを新しく開いた直後だけ、読み込み完了（最大30秒）を待ってから取得します。履歴の取得は1回の同期につき1回で、失敗しても同じ同期の中で再試行しません（次回の同期で取得します）。
- 「接続を解除」では同期用タブの記録だけを消し、タブ自体は閉じません。
- 履歴の取得にはEdgeでSPOTJOBSへログインしたままであることが必要です。

同期サーバーの保存先を専用Cloudflare D1へ切り替えても、v0.2.1のVercel Endpoint・同期コード・暗号化Protocolは共通です。保存先変更だけのために、拡張の再インストールや同期コードの再発行は必要ありません。

## 同期仕様

- 初期値: 30分ごと（15 / 30 / 60分から選択）
- スマホの「今すぐ同期」: 専用サーバーへ取得依頼 → PCが依頼を確認 → 公式履歴を取得・暗号化保存 → スマホへ反映。通常の自動取得間隔を待ちません。
- PCの依頼確認: 30秒ごと。確認するのは依頼の有無のみで、公式履歴を30秒ごとに取得するわけではありません。ブラウザー起動・拡張の接続直後にも確認します（依頼がなければ起動時にSPOTJOBSへは通信しません）。
- 取得依頼は2分で失効します。PCが応答しなければスマホへ待機状況が表示されます。Sleep・ブラウザーの省電力処理・通信状態により30秒を超えて遅れる場合があり、PCをリモート起動する機能はありません。
- 取得完了の通知は暗号化履歴の保存成功後に送ります。通信失敗時は依頼IDと結果だけをPCへ保存して再通知し、同じ依頼による重複取得を避けます。
- 対象: `BATTERY_INSERT`、`BATTERY_EJECT`、`BL_BATTERY_EJECT`
- 一意キー: `rounderWorkId`
- 1回の取得: 公式APIの1ページ目（最新50件）。同期Inboxは既存の記録と統合して最新500件まで保持（長期保管は端末のIndexedDBとJSONバックアップ）
- 保存順: 完了日時の古い順
- タイムゾーンのない完了日時はSPOTJOBS運用に合わせて日本時間（UTC+09:00）として解釈
- 補充地域や早期対象をAPIから確定できない記録は、アプリ側で「要確認」として扱います。

## 保存先と無料運用

同期サーバーは、既存のVercelブリッジから認証必須のCloudflare Workerを経由し、暗号化された履歴と取得依頼をこのアプリ専用のD1へ保存します。GatewayのTokenやCloudflareアカウントのAPI Tokenを拡張へ配布することはありません。最新依頼の参照は180秒で論理的に失効し、依頼がないときの30秒ごとの確認は主キー検索1回で完了します。PC 1台を常時起動した場合の待受けは1日2,880回、31日で89,280回です。手動同期・定期取得・期限切れ行の削除は別に加算されます。

2026年11月確認時点の[Cloudflare D1 Free](https://developers.cloudflare.com/d1/platform/pricing/)は1日500万行の読み取り・10万行の書き込み、[Workers Free](https://developers.cloudflare.com/workers/platform/limits/)は1日10万Request・HTTP RequestあたりCPU 10 msが上限です。個人のPC 1台での利用を想定し、Freeプランのまま運用します。各無料枠は同一Account内の他の利用と共有されます。複数PCや大量の操作、事業者の条件変更によって上限に届く可能性があり、無制限・恒久的な無料利用を保証するものではありません。

旧Blob停止中の移行では、次の取得で公式の最新50件から新Inboxを作成します。アプリのIndexedDB内の既存履歴・編集・棚卸は保持されます。旧Blobの読取・物理削除は行わないため、旧保存先の暗号文の削除は管理者による別途の確認が必要です。検討段階のUpstash方式は本番へ接続しておらず、既存Upstash Databaseも変更しません。

平文は送信前に、次のv1 Snapshotとして暗号化します。

```ts
type SpotJobsSyncRecord = {
  externalId: string;
  workType: "BATTERY_INSERT" | "BATTERY_EJECT" | "BL_BATTERY_EJECT";
  completedAt: string;
  quantity: number;
  storeName: string;
  estimatedReward?: number;
  earlyRefill: boolean | null;
};

type SyncSnapshot = {
  version: 1;
  collectedAt: string;
  sourceVersion: string;
  records: SpotJobsSyncRecord[];
};
```

## ビルド

外部依存のないJavaScript/CSS/HTMLなのでBuildは不要です。フォルダをそのままEdgeへ読み込めます。Chrome Web Store等へ公開する場合は、このフォルダをZIP化してください。

30秒周期は[Chromium 120以降のalarms API](https://developer.chrome.com/docs/extensions/whats-new#chrome_120_minimum_alarm_granularity_reduced_to_30_seconds)に基づきます。
