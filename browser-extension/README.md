# SPOTJOBS報酬・在庫管理 自動同期（Edge拡張）

ログイン済みの `https://app.spot.jobs/user-job-list` から、完了した補充・取出を定期確認し、端末内で暗号化して「SPOTJOBS報酬・在庫管理アプリ」専用の同期ブリッジへ保存するManifest V3拡張です。

## プライバシー設計

- SPOTJOBSのパスワード、Cookie、Local Storage、Session Storage、Authorization Headerを読み取りません。
- 履歴APIの呼び出しはログイン済みページのMAIN worldで行い、そのページ自身のSessionだけを利用します。
- 同期ブリッジへ送る前にAES-GCMで暗号化します。
- 同期コードからHKDF-SHA-256で認証用Tokenと暗号鍵を別々に導出します。
- 同期サーバーが受け取る作業履歴の内容は暗号文です（Protocol Version、件数、同期時刻のみMetadataとして付与します）。
- 権限はSPOTJOBS、このアプリ専用の同期サーバー、開発時にユーザーが許可したlocalhostだけです。

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
5. `https://app.spot.jobs/user-job-list` をログイン済みの状態で開いておきます。

ブラウザー終了中、PCのSleep中、SPOTJOBSからログアウト中は取得できません。復帰後の次回同期で差分を取得します。

既存の展開済み拡張を更新する場合は、同じフォルダのファイルを更新して `edge://extensions` でこの拡張を再読み込みしてください。同期コードは維持されます。v0.2.0以降にはスマホからの取得依頼への応答機能があり、Chromium 120以降のEdge / Chromeが必要です。

## 同期仕様

- 初期値: 30分ごと（15 / 30 / 60分から選択）
- スマホの「今すぐ同期」: 専用サーバーへ取得依頼 → PCが依頼を確認 → 公式履歴を取得・暗号化保存 → スマホへ反映。通常の自動取得間隔を待ちません。
- PCの依頼確認: 30秒ごと。確認するのは依頼の有無のみで、公式履歴を30秒ごとに取得するわけではありません。ブラウザー起動・拡張の接続直後にも確認します。
- 取得依頼は2分で失効します。PCが応答しなければスマホへ待機状況が表示されます。Sleep・ブラウザーの省電力処理・通信状態により30秒を超えて遅れる場合があり、PCをリモート起動する機能はありません。
- 取得完了の通知は暗号化履歴の保存成功後に送ります。通信失敗時は依頼IDと結果だけをPCへ保存して再通知し、同じ依頼による重複取得を避けます。
- 対象: `BATTERY_INSERT`、`BATTERY_EJECT`、`BL_BATTERY_EJECT`
- 一意キー: `rounderWorkId`
- 最大取得・同期Inbox: 最新500件（長期保管は端末のIndexedDBとJSONバックアップ）
- 保存順: 完了日時の古い順
- タイムゾーンのない完了日時はSPOTJOBS運用に合わせて日本時間（UTC+09:00）として解釈
- 補充地域や早期対象をAPIから確定できない記録は、アプリ側で「要確認」として扱います。

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
