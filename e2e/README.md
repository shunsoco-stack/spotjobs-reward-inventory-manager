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

## スクリーンショット取り込みの追加検証

2026年9月21日に、ビルド済み静的プレビューの最終Chromiumで追加検証しました。提供された実画像は、画面内で完了している3件を補正なしで抽出しました。画像、店舗名、日時、認識文字、登録データはテスト成果物やリポジトリへ保存していません。

確認した操作は次のとおりです。

- 3件の候補確認と一括保存、保存直後の取消
- 同じ画像を再度読み込んだ場合の重複検出と保存対象からの除外
- 日付・種類・本数・時刻の不正値を保存しないこと
- 6桁の数字入力を時・分・秒へ整形し、秒が不足した時刻を補完せずエラーにすること
- 初回オンラインでOCR資産を取得した後、通信断中も画像を読み取れること
- 画像をサーバーへ送る通信がないこと
- コンソールエラー・ページ例外が0件であること

WebKitではオンライン状態の取り込みフローを以前の確認で通しています。通信断中の再起動は上記のWindows WebKit制約があるため、オフラインOCRの最終確認はChromiumで行いました。これは実機iPhone Safariが非対応という判定ではありません。

同じ最終状態で`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`が成功しています。単体テストは166件／5ファイルです。本番環境E2Eは14件成功・1件スキップでした。

## 公開環境での実行結果

2026年9月21日 02:40 JST に、[公開アプリ](https://spotjobs-reward-inventory-manager.vercel.app/)を未認証の独立したブラウザー保存領域から検証しました。

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

実行時間は1.4分。成功した14件ではコンソールエラー・ページ例外ともに0件でした。Chromiumの2構成では、公開URLの初回読込後に通信を切り、再読込→入力→保存→再読込→履歴確認まで成功しています。WebKitのスキップ理由と実機未検証の範囲は上記のとおりです。
