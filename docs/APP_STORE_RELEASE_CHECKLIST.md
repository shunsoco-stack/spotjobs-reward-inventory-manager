# App Store release readiness checklist

更新日：2026-10-17

この文書は、Windowsで準備できる申請物と、Mac／Apple Developer Accountでしか完了できない作業を分けるための監査表です。申請文面の原本は `APP_STORE_METADATA_JA.md`、実行手順は `MAC_IOS_RELEASE_PROMPT.md` と `IOS_BUILD.md` を使用します。

## Windows側で確認済み

- [x] App Store名候補は18文字、Subtitleは18文字で、各30文字以内。
- [x] Promotional Textは71文字で、170文字以内。
- [x] KeywordsはUTF-8で70byteで、100byte以内。第三者名称は含めていない。
- [x] Description、TestFlight説明、What to Test、App Review Notesの日本語草案がある。
- [x] Privacy Policy URLとSupport URLの公開ページが実装されている。
- [x] Version 1.0は広告SDK、analytics SDK、Cloud Sync、クラッシュ収集を含めない方針が、実装・README・申請草案で一致している。
- [x] `assets/app-icon-1024.png` は1024×1024、RGB、alphaなし、角丸なしの独自画像。公式ロゴ・公式素材を使っていない。
- [x] Capacitor Filesystem 8.1.5向けのPrivacy Manifest雛形を `assets/ios/PrivacyInfo.xcprivacy` に用意した。File Timestamp APIをアプリcontainer内の一時exportファイルへ使うため、pluginが案内する `C617.1` を宣言している。
- [x] Web版とiOS版は保存領域が別で、JSON Export → iOS Restoreを移行方法とすることをREADME、Support、iOS手順へ明記した。
- [x] App Store用スクリーンショットの撮影順、個人情報除外、保存先を `docs/app-store/screenshots/README.md` に定義した。

## Macでbinary生成後に確認する項目

- [ ] `origin/main`の最新commitから`ios/`を生成し、Bundle IDとSigning Teamを確定する。
- [ ] `assets/ios/PrivacyInfo.xcprivacy`をアプリtargetへ追加し、Copy Bundle Resourcesへ含まれることを確認する。
- [ ] ArchiveからPrivacy Reportを生成し、appと全SDKの収集データ、tracking、required-reason APIが申請回答と一致することを確認する。
- [ ] Filesystem以外のapp code／SDKがrequired-reason APIを使う場合は、実際の用途に合うapproved reasonを追加する。雛形のまま決め打ちしない。
- [ ] 全依存を監査して、OS標準HTTPSなど免除対象の暗号だけなら`ITSAppUsesNonExemptEncryption = NO`を設定する。事実が異なる場合はexport complianceを申告する。
- [ ] AppIcon asset catalogへ1024px原本を登録し、XcodeのApp Icon検証に合格する。
- [ ] デモデータで実機／Simulatorの6.9-inch App Store画像を撮影し、`docs/app-store/screenshots/`へ保存する。既存の`docs/screenshots/`はWeb版ポートフォリオ画像なので提出しない。
- [ ] iPhone実機で初回起動、force quit、端末再起動、機内モード、アプリ更新後のIndexedDB保持を確認する。
- [ ] Web版でJSONを出力し、iOS版でRestore Previewの作成日時・件数・期間を確認して復元する。設定、全記録、在庫、週間報酬が一致することを確認する。
- [ ] JSON／CSV書出し、Filesへの保存、画像／JSON／CSVのpicker、X共有、SPOTJOBS公式サイトの外部ブラウザ起動を実機で確認する。
- [ ] VoiceOver、Dynamic Type、Light／Dark／System、safe area、横スクロールなし、numeric keyboardを実機で確認する。
- [ ] `xcodebuild`、Archive validation、TestFlight Internal Testingを成功させ、TestFlight install後にも主要flowを再確認する。

## App Store Connectで本人入力が必要な項目

- [ ] Apple Developer ProgramのTeam、正式なseller名、Bundle ID、SKUを確定する。Bundle IDとSKUは後で変更できないため、作成前に確認する。
- [ ] Copyrightへ`2026`と正式な個人名または法人名を入力する。
- [ ] App Review連絡先の氏名、電話番号、メールアドレスを入力する。認証がないためdemo accountは不要と明記する。
- [ ] Supportページへ、配信地域の法令上必要になる実際の連絡先（メール、電話、法的住所等）を掲載する。現在のGitHub Issuesだけで要件を満たすと決め打ちしない。
- [ ] 配信地域、価格（無料）、Release方式、DSA trader/non-trader、Age Rating、Content Rights、export complianceを本人が事実どおり回答する。
- [ ] App Privacyは、最終Archiveと通信監査で広告・analytics・Cloud Sync・クラッシュ収集がないことを確認できた場合だけ「No, we do not collect data from this app」と回答する。

## 公開を止めるゲート

- [ ] `SPOTJOBS`をApp Store名で使う明示的な許諾がある場合、Appleへ提示できる契約・メール等をApp Review Informationへ添付する。
- [ ] 許諾がない場合は、この名称のままPublic App Reviewへ送信しない。中立名称の候補をユーザーへ提示し、ユーザーが選んだ名称へApp Store名、Bundle表示名、metadata、スクリーンショットを揃えて変更する。
- [ ] Support URLに利用者が到達できる問い合わせ手段がない状態で送信しない。
- [ ] 実作業履歴、店舗名、個人情報がスクリーンショット、TestFlight Notes、Git、Issueへ含まれる状態で送信しない。

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

現行のREADME画像は次の寸法で、いずれもApp Storeの6.9-inch提出画像としては使用できません。

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
