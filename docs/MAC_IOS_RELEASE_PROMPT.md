# Mac版Codex向け iOSリリース引き継ぎプロンプト

以下を、Mac上のCodexへそのまま貼り付けてください。MacにGitHub、Apple Developer、Xcode、Vercelの認証が必要な場面では、保存済みの認証を使い、パスワードや秘密鍵をチャット・ログ・Gitへ出さないでください。

---

```text
あなたは、この既存Webアプリを実用的なiOSアプリへ移植し、TestFlight、App Store Connect、本番公開まで担当してください。説明や計画だけで終わらず、実装・テスト・配布準備・審査提出まで、実際に進めてください。

## 対象

- アプリ名：SPOTJOBS報酬・在庫管理アプリ
- GitHub：https://github.com/shunsoco-stack/spotjobs-reward-inventory-manager
- Web本番：https://spotjobs-reward-inventory-manager.vercel.app/
- 現行ブランチ：main（必ず`origin/main`の最新までpullし、Windows側で準備したCapacitor共通層を含むこと）
- 技術：Next.js 16.4.2 / React 19 / TypeScript / static export / IndexedDB / Tesseract.js 7 / PWA / Capacitor 8.5.3
- 現行ビルド：`npm run build` で `out/` を生成する。`next.config.ts` は `output: 'export'`。
- 準備済み：`capacitor.config.ts`、Capacitor packageとnpm script、native runtime adapter、native時のService Worker停止、外部ブラウザ、共有シート経由のJSON/CSV書出し、custom scheme対応OCR URL、safe area、1024px icon、`/privacy`、`/support`、申請metadata草案。
- 未生成：`ios/`。Macで`docs/IOS_BUILD.md`を読み、Bundle IDを確認してから生成する。
- アプリは個人制作の非公式管理ツールで、SPOTJOBS、ChargeSPOT、株式会社INFORICHの公式サービスではない。公式ロゴや公式素材は使わない。

## 最初に必ず行うこと

1. リポジトリをcloneまたは既存cloneを開き、`git status`、`git remote -v`、`git log`を確認する。
2. `AGENTS.md`を全文読む。`DEVELOPMENT_RULES.md`があれば全文読む。
3. `docs/IOS_BUILD.md`と`docs/APP_STORE_METADATA_JA.md`を読み、Windows側の準備済み範囲と未検証事項を確認する。
4. このNext.jsは通常の知識で決め打ちせず、実装前に `node_modules/next/dist/docs/` の該当ガイドを読む。
5. 利用可能なSkillに `apple-design` / `/apple-design` があれば必ず使う。
6. Node.js 22以上、最新の安定版Xcode、Xcode Command Line Toolsを確認する。提出直前にApple公式のUpcoming Requirementsを再確認する。2026-10-17時点ではApp Store ConnectへのiOSアップロードにXcode 26以降とiOS 26 SDK以降が必要。
7. 新しい作業ブランチ `codex/ios-release` を作る。既存Web版を壊さず、共通コードを再利用する。
8. 最初に現行品質を固定するため、`npm ci`、`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、可能なら`npm run test:e2e`を実行し、結果を記録する。Windows側の基準は単体185件成功、ブラウザ17件成功・WebKitのオフライン再起動1件スキップ。

## 実装方針

既存の静的exportを端末へ同梱するCapacitor方式を第一候補とする。リモートURLだけを表示するWebViewは禁止。Apple Guideline 4.2対策として、通信なしで主要機能が動き、iOSの写真・ファイル・共有・外部ブラウザ・safe area等と統合された実用アプリにする。

- 2026-10-17時点の安定版はCapacitor 8。作業時点の公式安定版と互換性を確認し、pre-release版は使わない。
- 導入済みの`@capacitor/core`、`@capacitor/cli`、`@capacitor/ios` 8.5.3と各公式pluginの互換性を再確認する。`capacitor.config.ts`の`webDir`は`out`。
- Capacitor標準のlocal server/custom schemeから同梱assetを配信する。`file://`直読みや`server.url`による本番Webサイトのラップは使わない。
- iOS側はCapacitor 8標準のSwift Package Managerを優先する。必要性を説明できないCocoaPods依存やプラグインを増やさない。
- iOS deployment targetはCapacitor 8の要件に合わせて15.0以上とし、使用するWeb APIの互換性も確認する。必要なら16.4以上を選ぶが、理由を記録する。
- package scriptsの`ios:add`、`ios:sync`、`ios:open`、`ios:run`を使用し、不足するSimulator/Archive検証用コマンドだけ追加する。
- `ios/`、Capacitor設定、必要なAsset Catalog、Privacy ManifestはGit管理する。証明書、provisioning profile、API key、Apple ID、Teamの秘密情報は絶対にcommitしない。

## Bundle IDと署名

- Bundle IDはApp Store Connectでアプリレコードを作成した後は変更できないため、勝手に確定しない。
- 候補は `com.shunsoco.spotjobsmanager`。Apple Developer Portalで利用可能か確認し、ユーザーが別のreverse-DNS名を希望しない場合だけ採用する。
- XcodeのSigning TeamはユーザーのApple Developer Programチームを選ぶ。認証ダイアログ、2要素認証、契約同意が必要なら、その画面でユーザーに操作してもらう。認証情報を質問文やログへ貼らせない。
- App Store公開にはApple Developer Program加入が必要。未加入、契約未同意、税務・銀行情報未完了など外部アカウント側の不足があれば、ローカル実装と検証を先に完了してから、必要な操作だけを具体的に示す。

## 現行Web機能をすべて維持する

次を削らない。iOS実機で日常利用できることを完成条件にする。

- ホームDashboard、今週の報酬、補充本数、取出本数、現在庫、早期補充本数
- 次のBonus Tierまであと何本、現在との報酬差額
- 補充入力（オレンジ）、取出入力（水色）、大きなQuick Button、数値キーボード
- 地域A/B/C/D/省略と各地域の解説
- 早期補充、週間Bonus、週次表、日別・地域別集計
- 在庫、棚卸、差異確認、履歴、編集、削除、Undo
- 報酬シミュレーター、Tier到達、Goal、あと何本で目標
- JSON Backup/Restore、CSV Import/Export、事前Preview
- ジョブ履歴スクリーンショットからの端末内OCR取込・修正・重複除外
- Light/Dark/System、オフライン、デモデータ
- 今日または1週間の成績を選ぶX共有（`#SPOTJOBS`を含む。共有文に「個人制作の非公式管理ツール」は入れない）
- `https://app.spot.jobs/`をワンタップで端末の外部ブラウザに開く
- アプリ内の適切な場所では、非公式・非提携であることを明示する

## Windows側のiOS互換実装をMacで検証・補完する箇所

### 1. 実行環境Adapter

`src/lib/native-runtime.ts`にWeb/nativeの差を吸収するruntime serviceと単体テストがある。UIへCapacitor APIを直書きせず、この境界を維持し、実機で不足する機能だけ補完する。

- `isNativePlatform`
- 外部URLを開く
- 文章を共有する
- JSON/CSVファイルを書き出す
- JSON/CSV/画像ファイルを選ぶ
- 必要ならNetwork状態、Haptics、Status Bar

### 2. Service Worker/PWA

実装済みコードはWeb productionだけで`/sw.js`を登録し、Capacitor内では登録しない。nativeでは同梱assetにより最初からオフライン利用可能と表示し、PWAインストール案内を出さない。Web版のPWAを維持できていることと、iOS実機でこの分岐が正しく動くことを確認する。

### 3. 端末内保存とWeb版からの移行

現行は`src/lib/storage.ts`のIndexedDB（DB名`spotlog-worker`）へAppData全体を保存する。Storage Layerの境界を維持する。

- `capacitor://localhost`上のIndexedDBが、アプリ終了・端末再起動・アプリ更新後も保持されることを実機で確認する。
- 単なるPreferencesへの全件保存はしない。現行上限は20,000記録、Backup最大60,000,000文字であり不向き。
- IndexedDBを継続する場合も、書込完了、競合、失敗時メッセージ、JSON Backup/Restoreを実機確認する。
- native FilesystemまたはSQLiteへ移す場合は既存Storage interfaceにAdapterを追加し、原子的書込、schema version、旧IndexedDBからの一度きり移行、失敗時rollback、自動テストを用意する。理由なく全面移行しない。
- Web版とiOS版の保存領域は別。Cloud Syncがないため、Webのデータは自動でiOSへ移らない。WebでJSON Export→iOSでRestoreする移行手順を初回案内とREADMEへ明記する。
- アンインストールで端末内データが消えること、定期Backupを勧めることも明記する。

### 4. OCR

`src/lib/screenshot-ocr.ts`はHTTPSと`capacitor://localhost`の両方でTesseract worker/WASM/langを解決するhelperへ変更済み。2026-10-17のbuildでは`out/ocr`は約47.5MB、全`out`は約48.6MB。

- `capacitor://localhost/ocr/...`でWorker、WASM、gzip、MIMEが実際に読み込めることをSimulatorと実機で確認し、問題がある場合だけ既存helperを修正する。
- nativeではOCR資産を全て同梱するため「初回は通信が必要」という表示を出さない。Webでは現行条件に合わせる。
- iOSの写真/Files pickerから最大5枚を選択し、端末内OCR→候補修正→一括保存まで実機確認する。
- OCR画像・認識文字を外部送信しない。不要なCamera/Photo Library権限は追加しない。pluginで権限が必要になった場合だけ、具体的な日本語Usage DescriptionをInfo.plistへ入れる。
- 低メモリ端末、50MB asset、長いスクリーンショット、中止、タイムアウト、background→復帰を確認する。

### 5. 外部ブラウザと共有

- SPOTJOBSリンクはアプリ内WebViewへ遷移させず、`@capacitor/inappbrowser`の`openInExternalBrowser`等、実際に端末の既定外部ブラウザを開く方法を使う。`allowNavigation`に外部ドメインを入れない。
- X共有は今日/1週間の既存文面を維持し、nativeでは`x.com/intent/tweet`を外部ブラウザで開く。必要ならOS共有シートも補助導線として追加できるが、目立つ「Xで共有」ボタンを消さない。
- JSON/CSV ExportはWKWebViewのBlob downloadだけに依存しない。nativeではFilesystemのCache/Dataへ安全に一時保存し、`@capacitor/share`の共有シートから「ファイルに保存」できるようにする。完了/取消/失敗を処理し、一時ファイルを適切に掃除する。
- JSON/CSV Importは現行`input type=file`がFiles pickerで確実に動くか実機確認し、動かなければ保守されているfile picker pluginをruntime adapter経由で追加する。
- `@capacitor/filesystem`等のRequired Reason APIを使う場合、Privacy Manifestに正しいApple承認理由を記載する。コピペで推測しない。

### 6. iOS UI

- `viewportFit: 'cover'`、上/下/左右safe-area、Dynamic Island、ホームインジケータ、キーボードresize、スクロール、Sheet、Toastを実機で調整する。
- iPhone縦向きの片手入力を最優先。横スクロールを出さず、44pt以上のtouch target、数値入力時のnumeric keyboard、VoiceOver label、Dynamic Type/文字拡大、Reduce Motion、十分なcontrastを確認する。
- Light/Dark/SystemとStatus Barの文字色・背景を同期する。
- 補充はオレンジ、取出は水色を維持し、色だけで状態を伝えない。
- 保存成功時に軽いHapticsを追加してよい。頻繁な入力を遅くしたり、許可ダイアログを増やしたりしない。
- iPhoneをv1の主対象とする。iPad対応をApp Store Connectで有効にする場合は、iPadで全画面QAとiPad用スクリーンショットまで完了する。未検証のままiPad対応を宣言しない。

## アイコンとLaunch Screen

- `assets/app-icon-1024.png`は既存`public/icon.svg`を基に作成済みで、1024×1024、alphaなし、公式ロゴ不使用。Macで見た目と画像属性を再確認し、必要なら同じ独自モチーフの範囲で調整する。
- Asset Catalogへ必要なiconを設定し、ArchiveでMissing Icon/alpha警告がないことを確認する。
- 同じ独自モチーフで簡潔なLaunch Screenを作り、起動直後の白/黒flashを防ぐ。広告や公式サービスに見える表現を入れない。

## Privacy Policy、Support、App Privacy

Next静的exportに次の専用ページを追加済み。内容をiOS実装の最終状態へ合わせ、Web本番で公開する。

- `/privacy`：収集データ、保存場所、OCRが端末内であること、用途、第三者SDK、外部リンク、保持・削除方法、問い合わせ先、改定日
- `/support`：使い方、Backup/Restore、データ削除、既知の制約、連絡方法

設定画面とApp Store Connectから到達できるようにし、Vercel Productionで200応答と内容を確認する。実装済みSDKと通信を監査し、広告・分析・Cloud Syncがなくデータ送信もしないv1なら、App Privacyの「データを収集しない」を事実に基づいて回答する。表現だけで決めない。

- `PrivacyInfo.xcprivacy`をtargetに含める。
- CapacitorはAppleのprivacy manifest/SDK signature対象SDKであるため、最新版の署名・manifestとArchive Privacy Reportを確認する。
- Required Reason APIをbinary scan/Privacy Reportで洗い出し、実際の利用理由だけを宣言する。
- `ITSAppUsesNonExemptEncryption`は、全依存を確認し、Appleの質問に回答したうえで、免除対象のみなら`NO`を設定する。推測で設定しない。

## 広告

ユーザーは将来Web/iOS/Androidへ広告を付ける予定だが、現行には広告SDK、analytics、広告アカウントID、同意設計がない。v1は広告なしで公開準備を進め、空の広告枠や休眠SDKも入れない。広告のためにリリースを止めない。

広告をv1へ入れるようユーザーが明示し、広告networkと正式なApp ID/Ad Unit IDが揃った場合のみ別工程で追加する。その場合は、App Privacy、Privacy Policy、SDK Privacy Manifest/署名、同意、年齢rating、広告報告導線を更新する。cross-app/site trackingまたはIDFAを使う場合だけATTを適切な時点で求め、拒否時も主要機能を使えるようにする。fingerprintingは禁止。補充・取出の現場入力を全画面広告で遮らない。

## 商標・アプリ名の公開ゲート（最重要）

ユーザーはアプリ名を「SPOTJOBS報酬・在庫管理アプリ」と指定している。開発中に勝手に改名しない。ただしApple Review Guideline 4.1(c)、5.2.1、5.2.2では、権利者の許諾なしに第三者ブランド/製品名をアプリ名やiconへ使うこと、第三者サービスを無許可で収益化することが拒否リスクになる。「非公式」と書くだけでは解消しない。

- ローカル開発、実機QA、内部TestFlightまでは進める。
- Public App Reviewへ送る前に、SPOTJOBS/ChargeSPOT/INFORICH側から名称・商標利用の明示的許諾があるかをユーザーへ1回だけ確認する。
- 許諾あり：契約書、メール等の証拠をApp Reviewへ提示できる形にし、現在名を維持する。
- 許諾なし：勝手に改名せず、機能と背景を保った中立的なApp Store名候補を2〜3案提示し、ユーザーが選んだ名称へApp Store名、ホーム画面名、icon内文字、metadataを変更する。「SPOTJOBS」は用途・互換性の説明に必要な範囲だけで使い、非公式・非提携を明記する。
- この判断が終わるまでPublic App Review送信だけは行わない。他の実装、TestFlight、metadata草案、スクリーンショット作成は止めない。
- Review Notesには、公式API/ロゴ/素材を使わないこと、本人の手入力記録を端末内計算すること、公式サイトはユーザー操作時の外部リンクだけであること、ログイン不要であることを明記する。

## App Store Connect素材

日本語を主言語として、実装済み内容だけで次を作る。

- Name、Subtitle、Promotional Text、Description、Keywords
- Primary Category（Productivityを第一候補。最終選択を記録）
- Support URL、Privacy Policy URL、Marketing URL
- 年齢rating、content rights、輸出コンプライアンス、価格（無料を第一候補）、配信地域、DSA trader status
- Review contact、Review Notes、TestFlight Beta Description、What to Test
- App Storeスクリーンショット5枚以上。実在作業記録や個人情報を使わずデモデータで撮る。最低でもDashboard、補充入力、報酬内訳、在庫/棚卸、OCRまたはシミュレーターを含める。
- Appleがその時点で要求するiPhoneサイズを公式仕様で再確認する。PNG/JPG、alphaなし、端末frameや文言が誤認を招かないこと。iPadを有効にする場合はiPad素材も用意する。

App Store recordを作る前に、Bundle ID、表示するdeveloper/seller名、最終App Store名を確定する。SKUは個人情報を含まない一意な値にする。

## TestFlightとQA

1. Xcode SimulatorでDebug/Release build。
2. `xcodebuild`でclean buildし、警告を確認する。
3. 実iPhoneで次を全て確認する。
   - 初回起動、デモ、自分の記録
   - 補充、取出、編集、削除、Undo
   - 在庫増減、棚卸、差異反映確認
   - 早期補充、地域別単価、週間Bonusの境界、報酬、Goal、Simulator
   - 今日/1週間のX共有と`#SPOTJOBS`
   - SPOTJOBS URLが外部ブラウザで開く
   - ジョブ履歴画像選択、OCR、訂正、保存、取消、重複
   - JSON/CSV Export、Filesへの保存、Import Preview、Restore
   - airplane modeで起動・入力・履歴・Dashboard、復帰後も保存継続
   - force quit→再起動、端末再起動、アプリupdate後のデータ保持
   - Light/Dark/System、文字拡大、VoiceOver、Reduce Motion
   - 小型iPhone、最新大型iPhone、回転、keyboard表示、横スクロールなし
   - background/foreground、低メモリ状況、OCR中断
4. Safari Web Inspector/Xcode consoleでconsole error、network error、crash、constraint warningを確認する。
5. Web版のlint/typecheck/unit/build/E2Eも再実行し、回帰がないことを確認する。
6. Archive→Validate Appでerror 0。Privacy Report、App Store icon、signing、version/build、symbolsを確認する。
7. App Store Connectへuploadし、まず内部TestFlightで実機確認する。可能なら外部TestFlightも行う。外部初回はBeta App Reviewがあり、build有効期間は90日。

既存の自動テスト185件、54本すべて早期補充で4,050円、19/20/49/50/99/100/149/150本のBonus境界を必ず維持する。native adapterにも単体テストを追加するが、実装をなぞるだけの無意味なテストは増やさない。

## 提出と公開

- Version 1.0.0、build number 1から始め、再uploadではbuildだけ増やす。
- TestFlight QA、商標名ゲート、Privacy/metadata、Apple契約・輸出回答が揃ったらApp Reviewへ提出する。この依頼はiOS公開までの実行を求めているため、条件が揃った後に同じ内容の再確認を何度も求めず進める。
- 公開方式はManual Releaseを第一候補にする。審査通過後、公開地域と公開日時をユーザーへ示してリリースする。
- Appleからreject/metadata issueが来たら、理由を原文のまま記録し、安全に直せるものは修正→build/metadata更新→再提出する。商標許諾などユーザーしか解決できない事項だけ、必要な選択を具体的に聞く。
- Release後、App Store URLをREADME、Web版、ポートフォリオ用文面へ追加する。Vercel ProductionとGitHub mainも正常であることを再確認する。

## Gitと秘密情報

- `.env`、Apple ID、Teamの秘密値、証明書、`.p12`、provisioning profile、Auth Key `.p8`、広告secret、実作業履歴、実スクリーンショットをcommitしない。
- commit前にsecret scanと`git diff --check`を行う。
- native生成物を丸ごと無視せず、再現に必要なXcode project/SPM設定はcommitする。DerivedData、build、個人Workspace stateはignoreする。
- READMEへiOSのbuild/sync/open手順、データ移行、対応OS、Privacy/Support、TestFlight/App Store URLを追記する。
- まとまりごとにcommitし、originへpushする。必要ならPRを作る。

## 完了報告

最後に次を、事実とURL付きで報告する。未完了を完了扱いにしない。

- 採用したnative構成、Capacitor/Xcode/iOS targetのversion
- Bundle ID、Version、Build、Signing状態
- App Store名と商標許諾/名称判断
- Web版から維持した機能
- iOS向けに追加・修正した機能
- IndexedDB/native保存方式、Web→iOS移行方法、データ保持試験
- Offline、OCR、外部ブラウザ、X共有、JSON/CSV、Dark Modeの実機結果
- Privacy Policy URL、Support URL、Privacy Manifest/App Privacy回答
- 広告の有無。未実装なら「v1は広告なし」と明記
- lint、typecheck、unit、build、E2E、xcodebuild、Archive validationの結果
- テストしたSimulator/実機/OS version
- TestFlight build URLまたは状態
- App Store URLと公開状態
- GitHub branch/commit/PR URL
- 既知の制約、Apple審査からの指摘、残作業

作業中は定期的に短い進捗を伝える。確認待ちにせず進められる実装・検証・metadata準備はすべて先に進め、ユーザーにしか答えられないBundle ID、Apple Team、商標許諾等だけを必要な時点で簡潔に確認する。
```

## 参照する公式資料

- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Apple Upcoming Requirements](https://developer.apple.com/news/upcoming-requirements/)
- [App Store Connect workflow](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-workflow)
- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
- [App privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/)
- [Third-party SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/)
- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
- [Capacitor 8 environment setup](https://capacitorjs.com/docs/getting-started/environment-setup)
- [Capacitor 8 migration requirements](https://capacitorjs.com/docs/updating/8-0)

