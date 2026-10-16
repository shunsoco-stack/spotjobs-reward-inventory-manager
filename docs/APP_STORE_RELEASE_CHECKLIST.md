# App Store release readiness checklist

更新日：2026-10-17

この文書は、Windowsで準備できる申請物と、Mac／Apple Developer Accountでしか完了できない作業を分けるための監査表です。申請文面の原本は `APP_STORE_METADATA_JA.md`、実行手順は `MAC_IOS_RELEASE_PROMPT.md` と `IOS_BUILD.md` を使用します。

## Windows側で確認済み

- [x] App Store名候補は18文字、Subtitleは18文字で、各30文字以内。
- [x] Promotional Textは71文字で、170文字以内。
- [x] KeywordsはUTF-8で99byteで、100byte以内。各語は3文字以上で、App Store名・会社名・第三者名称を重複させていない。
- [x] Description、TestFlight説明、What to Test、App Review Notesの日本語草案がある。
- [x] Privacy Policy URLとSupport URLの公開ページが実装されている。
- [x] Version 1.0は広告SDK、analytics SDK、Cloud Sync、クラッシュ収集を含めない方針が、実装・README・申請草案で一致している。
- [x] `assets/app-icon-1024.png` は1024×1024、RGB、alphaなし、角丸なしの独自画像。公式ロゴ・公式素材を使っていない。
- [x] Capacitor Filesystem 8.1.5向けのPrivacy Manifest雛形を `assets/ios/PrivacyInfo.xcprivacy` に用意した。File Timestamp APIをアプリcontainer内の一時exportファイルへ使うため、pluginが案内する `C617.1` を宣言している。
- [x] Web版とiOS版は保存領域が別で、JSON Export → iOS Restoreを移行方法とすることをREADME、Support、iOS手順へ明記した。
- [x] App Store用スクリーンショットの撮影順、個人情報除外、保存先を `docs/app-store/screenshots/README.md` に定義した。

## Macでbinary生成後に確認する項目

- [ ] 名称・商標の判断後、`origin/main`の最新commitから`ios/`を生成し、最終Bundle IDとSigning Teamを確定する。
- [ ] 初回は`npm run ios:release-preflight -- --identity-confirmed`、以後は`npm run ios:release-preflight`を成功させ、`.artifacts/ios-release-preflight.md`でWeb品質、local E2E、native audit、SPM解決、署名なしSimulator build、App.app内Privacy Manifestの証跡を確認する。
- [ ] ホーム画面表示名を最終App Store名と揃え、Version `1.0.0`、Build `1`から開始する。再upload時はBuildだけを増やす。
- [ ] v1をiPhone専用にするかiPadにも対応するかをユーザーと確定し、Xcodeの対象device familyへ反映する。iPad対応時はiPad実機QAと提出画像も追加する。
- [ ] 独自モチーフのLaunch Screenを設定し、Light／Darkの起動時に不自然な白／黒flashや公式サービスと誤認させる表現がないことを確認する。
- [ ] `assets/ios/PrivacyInfo.xcprivacy`をアプリtargetへ追加し、Copy Bundle Resourcesへ含まれることを確認する。
- [ ] ArchiveからPrivacy Reportを生成し、appと全SDKの収集データ、tracking、required-reason APIが申請回答と一致することを確認する。
- [ ] Filesystem以外のapp code／SDKがrequired-reason APIを使う場合は、実際の用途に合うapproved reasonを追加する。雛形のまま決め打ちしない。
- [ ] 全依存を監査して、OS標準HTTPSなど免除対象の暗号だけなら`ITSAppUsesNonExemptEncryption = NO`を設定する。事実が異なる場合はexport complianceを申告する。
- [ ] AppIcon asset catalogへ1024px原本を登録し、XcodeのApp Icon検証に合格する。
- [ ] デモデータで実機／SimulatorのApp Store画像を撮影し、`docs/app-store/screenshots/`へ保存・commitする。2026-10-17時点の必須iPhone枠はDynamic Islandのmedium display（portrait `1179×2556`または`1206×2622`）。iPad対応時は13-inch（portrait `2064×2752`または`2048×2732`）も必須。提出直前に公式仕様を再確認し、既存の`docs/screenshots/`はWeb版ポートフォリオ画像なので提出しない。
- [ ] iPhone実機で初回起動、force quit、端末再起動、機内モード、アプリ更新後のIndexedDB保持を確認する。
- [ ] Web版でJSONを出力し、iOS版でRestore Previewの作成日時・件数・期間を確認して復元する。設定、全記録、在庫、週間報酬が一致することを確認する。
- [ ] JSON／CSV書出し、Filesへの保存、画像／JSON／CSVのpicker、X共有、SPOTJOBS公式サイトの外部ブラウザ起動を実機で確認する。
- [ ] VoiceOver、Dynamic Type、Light／Dark／System、safe area、横スクロールなし、numeric keyboardを実機で確認する。
- [ ] `xcodebuild`、Archive validation、TestFlight Internal Testingを成功させ、TestFlight install後にも主要flowを再確認する。

## App Store Connectで本人入力が必要な項目

- [ ] Apple Developer ProgramのTeam、正式なseller名、Bundle ID、SKUを確定する。暫定候補`com.shunsoco.spotjobsmanager`にも第三者名称が含まれるため、名称・商標の判断をApple Developer PortalへのBundle ID登録前に終える。Bundle IDとSKUは後で変更できないため、作成前に確認する。
- [ ] Copyrightへ`2026`と正式な個人名または法人名を入力する。
- [ ] App Review連絡先の氏名、電話番号、メールアドレスを入力する。認証がないためdemo accountは不要と明記する。
- [ ] Supportページへ、配信地域の法令上必要になる実際の連絡先（メール、電話、法的住所等）を掲載する。現在のGitHub Issuesだけで要件を満たすと決め打ちしない。
- [ ] 配信地域、価格（無料）、Release方式、DSA trader/non-trader、Age Rating、Content Rights、export complianceを本人が事実どおり回答する。
- [ ] Version 1.0を広告SDK・広告枠なしで公開する前提をユーザー本人が確認する。初回から広告を入れる場合は、この監査結果を無効として広告・Privacy・同意設計を再監査する。
- [ ] App Privacyは、最終Archiveと通信監査で広告・analytics・Cloud Sync・クラッシュ収集がないことを確認できた場合だけ「No, we do not collect data from this app」と回答する。

## 外部配信を止めるゲート

- [ ] `SPOTJOBS`をApp Store名とBundle ID候補`com.shunsoco.spotjobsmanager`で使う前に、名称・商標の明示的な許諾有無を確認する。許諾がある場合は、Appleへ提示できる契約・メール等をApp Review Informationへ添付する。
- [ ] 許諾がない場合は、Apple Developer Portalへ暫定Bundle IDを登録しない。中立名称と中立Bundle IDの候補を提示し、ユーザーが選んだ値へApp Store名、ホーム画面表示名、Bundle ID、metadata、スクリーンショットを揃えて変更する。勝手に名称やIDを確定しない。
- [ ] 名称判断が終わるまで、App ID／App Store Connectアプリレコードを作らず、内部／外部TestFlight、Beta App Review、Public App Reviewへ送信しない。判断前はSimulatorとXcodeから直接installした実機でQAする。判断前の内部TestFlightが不可欠なら、productionへ転用しない中立名称・中立Bundle IDの別app recordが必要になることを説明し、本人が明示的に選んだ場合に限る。
- [ ] Support URLに利用者が到達できる問い合わせ手段がない状態で送信しない。
- [ ] 個人情報のないデモApp Storeスクリーンショットは`docs/app-store/screenshots/`へcommitしてよい。実作業履歴、実店舗名、個人情報を含む画像はTestFlight Notes、Git、Issueへ含めず、提出にも使わない。

## 広告を追加する場合

Version 1.0の現状は広告なしです。将来Web／iOS／Androidへ広告を追加する計画はありますが、広告network、App ID、Ad Unit ID、同意設計が未確定のため、休眠SDKや空の広告枠は同梱しません。

広告をApp Review前に追加する場合は、この監査結果を無効として次をやり直します。

- Privacy PolicyとApp Privacy回答を、広告SDKとその第三者partnerの実際の収集・利用へ合わせて更新する。
- Appleのthird-party SDK要件に沿うPrivacy Manifestとsignatureを確認し、Archive Privacy Reportへ反映されることを確認する。
- IDFAまたはcross-app/site trackingを使う場合だけ、ATT purpose stringと許可flowを実装する。拒否時も主要機能を使えるようにする。
- 年齢rating、子ども向け扱い、地域別同意、広告報告導線を確認する。
- 現場入力を全画面広告で遮らず、補充・取出・棚卸の保存操作を広告tapと誤認させない。

## スクリーンショット監査

AppleはiPhoneのdevice size／localizationごとに1〜10枚を受け付け、alpha/transparencyを認めていません。UIが同じなら、最も高い必須解像度を提出して小さいdeviceへscaleできます。提出時点の公式仕様を再確認してください。

現行のREADME画像は次の寸法で、いずれもApp Storeで必須のDynamic Island medium-display提出画像としては使用できません。

| ファイル | 現在の寸法 | 用途 |
| --- | ---: | --- |
| `docs/screenshots/01-dashboard.png` | 390×844 | README／portfolio |
| `docs/screenshots/02-replenishment.png` | 390×2020 | README／portfolio |
| `docs/screenshots/03-weekly-reward.png` | 1440×2204 | README／portfolio |
| `docs/screenshots/04-inventory.png` | 390×1718 | README／portfolio |
| `docs/screenshots/05-simulator.png` | 1440×1000 | README／portfolio |

撮影したnative画像は原寸のまま保存し、伸長・切り貼りで寸法だけ合わせないでください。

## 公式資料

- App information: https://developer.apple.com/help/app-store-connect/reference/app-information/app-information/
- Platform version information: https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information/
- Screenshot specifications: https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/
- App privacy: https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/
- Complete review information: https://developer.apple.com/help/app-review/before-submitting-for-review/complete-review/
- Privacy manifests: https://developer.apple.com/documentation/bundleresources/privacy-manifest-files/
- Required-reason APIs: https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api/
- Export compliance: https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations/
