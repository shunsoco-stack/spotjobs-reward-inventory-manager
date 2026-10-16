# App Store Connect 日本語メタデータ草案

更新日：2026-10-17

この文書はiOS版1.0の申請草案です。実装・実機QA後に、実際のbinaryと一致するよう見直してください。`SPOTJOBS`名称をApp Store名へ使用する場合は、公開審査前に権利者の明示的な許諾を確認します。許諾がない場合も勝手に改名せず、ユーザーが選んだ中立名称へ差し替えます。

## 基本情報

| 項目 | 草案 |
| --- | --- |
| App Store名 | SPOTJOBS報酬・在庫管理アプリ |
| Subtitle | 補充・取出・報酬・在庫をすばやく記録 |
| Primary Category | Productivity |
| Secondary Category | Utilities |
| 価格 | 無料 |
| 主言語 | 日本語 |
| Bundle ID | 未確定。候補 `com.shunsoco.spotjobsmanager` |
| SKU | `spotjobs-manager-ios-001` |
| Version | 1.0.0 |
| Copyright | `2026 [Apple Developerの正式な個人名または法人名]` |
| Marketing URL | https://spotjobs-reward-inventory-manager.vercel.app/ |
| Support URL | https://spotjobs-reward-inventory-manager.vercel.app/support/（実際の連絡先を掲載してから使用） |
| Privacy Policy URL | https://spotjobs-reward-inventory-manager.vercel.app/privacy/ |

## Promotional Text

補充・取出を現場ですばやく記録。今週の見込み報酬、次の本数ボーナス、現在庫、棚卸差異まで、通信が不安定な場所でもひとつのアプリで確認できます。

## Description

「SPOTJOBS報酬・在庫管理アプリ」は、ChargeSPOTのモバイルバッテリー再配置業務に取り組む個人ワーカー向けの非公式管理ツールです。

補充や取出をスマートフォンで素早く記録し、今週の見込み報酬、現在庫、早期補充、次の本数ボーナスまでまとめて確認できます。

主な機能

・補充／取出のかんたん入力
・本数を加算できるクイックボタン
・地域別単価と地域説明
・早期補充と週間本数ボーナスの自動計算
・次のボーナスまで「あと何本？」を表示
・週間目標まで必要な追加本数をシミュレーション
・現在庫、日別在庫、棚卸、棚卸差異の管理
・日次／週次履歴と地域別集計
・ジョブ履歴スクリーンショットの端末内読み取り
・今日または1週間の成績をXへ共有
・JSONバックアップ／復元、CSV入出力
・ライト／ダーク／システムテーマ
・主要機能のオフライン利用

記録はログインなしで端末内に保存されます。スクリーンショットの文字認識も端末内で行い、画像や認識結果を外部サーバーへ送信しません。端末変更や再インストールに備え、設定画面から定期的にJSONバックアップを保存してください。

表示する報酬は、入力内容とユーザーが設定した条件に基づく見込みです。確定金額や最新条件は公式サービスで確認してください。

本アプリは個人制作の非公式管理ツールです。SPOTJOBS、ChargeSPOT、株式会社INFORICHとの提携・関係はありません。公式アカウント、公式API、決済機能には接続しません。

## Keywords

`バッテリー,作業管理,収益管理,棚卸管理,副業管理,業務効率化,オフライン`

各語は2文字を超え、全体はUTF-8で99byteです。App Store Connectへ保存するときにも再確認します。商標許諾がない場合、`SPOTJOBS`はkeywordsへ入れません。

## Version 1.0 紹介メモ

初回版ではApp Store Connectの「このバージョンの新機能（What's New）」欄は表示されません。次の文はTestFlightや公開告知へ転用するための内部メモです。

補充・取出、報酬、週間ボーナス、在庫、棚卸、シミュレーションをiPhoneで管理できる初回リリースです。ジョブ履歴スクリーンショットの端末内読み取り、JSON／CSV、X共有、オフライン利用にも対応します。

## TestFlight Beta Description

実際の作業中に補充・取出・在庫・報酬を素早く確認するための非公式管理アプリです。ログインは不要で、記録とOCR処理は端末内で完結します。テストには個人情報を含まないデモデータを使用してください。

## What to Test

1. 初回起動後、「サンプルを見る」でデモデータを表示できること。
2. 補充と取出を登録し、在庫と週間報酬へ即時反映されること。
3. 次の本数ボーナスまでの残り本数、報酬シミュレーター、週間目標を確認できること。
4. 棚卸数を入力し、差異を確認してから在庫へ反映できること。
5. ジョブ履歴のスクリーンショットを選び、候補を修正して保存できること。
6. JSON／CSVをFilesへ保存し、JSON復元とCSV取込のPreviewを確認できること。
7. 機内モードでアプリを再起動し、入力・Dashboard・履歴を利用できること。
8. 今日／1週間の成績を選び、Xの共有画面を外部ブラウザで開けること。
9. 「SPOTJOBSを開く」で公式Webサイトが端末の外部ブラウザに開くこと。
10. Light／Dark／System、文字拡大、VoiceOverで操作できること。

## App Review Notes

本アプリは、個人ワーカーが自分で入力した補充・取出記録から、報酬の目安と手元在庫を端末内で計算する独立した非公式ツールです。

- ログイン、会員登録、課金はありません。
- 公式API、公式アカウント、公式ロゴ、公式素材は使用しません。
- SPOTJOBS／ChargeSPOT／株式会社INFORICHが提供・承認する公式アプリではありません。
- 公式Webサイトへのリンクは、ユーザーがボタンを押した場合だけ外部ブラウザで開きます。
- App本体、画面、計算logic、文字認識modelはbinaryへ同梱しており、remote websiteを表示する構成ではありません。補充・取出・報酬・在庫・棚卸・履歴・OCRは通信なしで動作します。
- JSON／CSVの書出しはiOSのFilesystemと共有sheetへ統合し、公式サイトとX共有は既定の外部browserで開きます。
- 入力記録は端末内へ保存され、当方のserverへ送信されません。
- スクリーンショットOCRは同梱したTesseract.jsのmodelを使い、端末内で処理します。画像と認識文字は外部へ送信しません。
- 主要機能は通信なしで利用できます。外部サイトとX共有を開く場合だけ通信が必要です。
- デモデータは、ホームまたは設定の「サンプルを見る」から表示できます。個人情報を含みません。
- 広告SDK、analytics SDK、Cloud SyncはVersion 1.0に含みません。

審査時に確認してほしい主な導線：ホーム → 補充／取出、ホーム → 在庫・棚卸、ホーム → 報酬シミュレーター、履歴 → スクショから取り込む、設定 → Backup／Restore。

名称・商標の明示的許諾がある場合は、その証拠と連絡先をResolution Centerまたは添付欄へ追加します。許諾がない状態では、この名称のままPublic App Reviewへ送信しません。

## App Privacy回答草案

Version 1.0のbinaryと通信を最終監査し、広告・analytics・Cloud Sync・クラッシュ収集を含まないことを確認できた場合：

- Data Collection：No, we do not collect data from this app
- Tracking：No
- Privacy Policy URL：上記URL

端末内のIndexedDB、Filesへユーザーが保存するBackup、端末内OCRは、開発者または第三者serverへ送信されない限りApp Privacy上の「収集」には含めない想定です。ただし、App Store Connectの当時の定義と全SDKの実動作を確認してから回答します。

## Content Rights・広告・暗号化

- Content Rights：第三者コンテンツを配信しない。名称の商標利用は公開ゲートで別途確認する。
- Advertising：Version 1.0は広告なし。広告SDKも同梱しない。
- Encryption：OS標準のHTTPS等、免除対象の暗号だけかを全依存で確認し、App Store Connectの質問へ回答する。事実確認後に限り`ITSAppUsesNonExemptEncryption = NO`を設定する。
- Age Rating：暴力、性的表現、ギャンブル、薬物、ユーザー生成コンテンツ、アプリ内Web閲覧は実装しない想定。最新質問票へ事実どおり回答し、App Store Connectが算出したratingを採用する。
- DSA Trader Status：Apple Developer Account Holder本人が法的状態を回答する。住所・電話・メールの公開範囲を確認する。

## 審査前にユーザー本人が埋める項目

- Apple Developer ProgramのTeamと正式なseller名
- 最終Bundle ID
- Copyrightへ載せる正式名
- App Review連絡先の氏名、電話番号、メールアドレス
- Supportページへ公開する実際の連絡先（配信地域の法令に応じた住所、メールアドレス、電話番号）。現在のGitHub Issuesだけでは提出しない
- 配信地域
- DSA trader/non-trader回答
- `SPOTJOBS`名称・商標利用の許諾有無と証拠
- Manual Releaseの公開日

Apple IDのパスワード、2要素認証code、証明書秘密鍵、`.p8`、`.p12`、provisioning profileは、この文書、Issue、Git、チャットへ記載しません。

## スクリーンショット案

実在の作業履歴を使わず、デモデータを使って実機またはSimulatorから撮影します。

1. Dashboard：今週の報酬、補充、取出、現在庫、次Tierまであと何本
2. 補充入力：大きな本数入力、Quick Button、地域、早期補充
3. 週次報酬：基本、早期、週間Bonus、日別集計
4. 在庫・棚卸：現在庫、直近3日、棚卸差異
5. スクショ取込：画像選択、端末内処理、確認して保存
6. シミュレーター：追加本数、到達Tier、予想報酬、目標まであと何本

2026年10月17日時点では、Appleが必須としているDynamic Islandのmedium display（縦1179×2556または1206×2622）で作成します。提出直前に公式仕様を再確認し、PNG/JPG、alphaなしで保存します。iPad対応を有効にする場合は、iPad実機QAと必須の13-inch iPad素材も追加します。
