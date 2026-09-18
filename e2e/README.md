# ブラウザ検証

ビルド済みの静的プレビューを起動してから実行します。開発サーバーでは Service Worker が登録されないため、オフラインの検証には使いません。

```powershell
npm run build
npm run preview
# 別のターミナル
npm run test:e2e
```

既定の対象は `http://localhost:3059` です。別のプレビューを使う場合は `E2E_BASE_URL` を設定してください。

検証対象は Desktop Chromium、Pixel 7 の Chromium エミュレーション、iPhone 13 の WebKit エミュレーションです。各テストは新しいブラウザ保存領域で始まり、入力・編集・設定は画面操作、JSON/CSV の取込はファイル選択で行います。テストデータを IndexedDB に直接書き込む処理はありません。

- 初回画面、サンプルと個人記録の分離、390px／320px を含む横はみ出し
- 取出60本→補充54本の4,050円、ボーナス・追加本数・目標試算
- 編集、削除と取消、棚卸の観測と確認後反映、旧単価の保持
- JSON のダウンロードと上書き復元、UTF-8 CSV のプレビューと不正行の拒否
- テーマ切替と再読込、PWA 資産、通信断中の入力と保存
- Chromium では Service Worker による通信断状態の再起動と保存継続

スクリーンショット、コンソール検証、失敗時のトレースは `test-results/`、HTML レポートは `playwright-report/` に保存します。

WebKit は実機 iPhone の Safari ではありません。Playwright の [Service Worker サポート](https://playwright.dev/docs/service-workers)は Chromium に限定されており、この Windows WebKit では通信断状態のページ再起動がブラウザ内部エラーになります。そのテスト1件を理由付きでスキップします。WebKit の通信断後の入力・保存・オンライン復帰後の再読込は別のテストで検証します。iPhone Safari 実機のオフライン再起動は未検証です。

## 公開環境での実行結果

2026年9月18日 16:50 JST に、[公開アプリ](https://spotjobs-reward-inventory-manager.vercel.app/)を未認証の独立したブラウザー保存領域から検証しました。

```powershell
$env:E2E_BASE_URL = 'https://spotjobs-reward-inventory-manager.vercel.app'
npm.cmd run test:e2e
```

| 構成 | 成功 | スキップ |
| --- | ---: | ---: |
| Desktop Chromium | 5 | 0 |
| Pixel 7 Chromium | 5 | 0 |
| iPhone 13 WebKit | 4 | 1 |
| 合計 | 14 | 1 |

実行時間は1.1分。成功した14件ではコンソールエラー・ページ例外ともに0件でした。Chromiumの2構成では、公開URLの初回読込後に通信を切り、再読込→入力→保存→再読込→履歴確認まで成功しています。WebKitのスキップ理由と実機未検証の範囲は上記のとおりです。
