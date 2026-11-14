# SPOTJOBS報酬・在庫管理アプリ encrypted sync bridge

SPOTJOBSのログイン情報をクラウドへ渡さず、Edge拡張で取得した作業履歴をWeb／iOS／Android版「SPOTJOBS報酬・在庫管理アプリ」へ届けるための、個人用の暗号化同期Inboxです。本体PWAとは別のVercelプロジェクトとして公開します。

## Privacy model

- SPOTJOBSのパスワード、Cookie、認証Tokenは受け取りません。
- 作業履歴はPC上でAES-256-GCM暗号化してから送信します。
- 作業履歴は`iv`と`ciphertext`を含む暗号化EnvelopeとしてPrivate Blobへ保存します。遠隔更新の依頼には、Opaque ID・時刻・処理状態・限定したエラーCodeだけを保存します。
- 復号Keyは同期Codeから端末内で導出し、Serverへ送りません。
- Server側Allowlistに登録した個人Channelだけが利用できます。
- 保存期間はDefault 90日です。期限切れデータは読取時に削除されます。
- Vercel FunctionsからBlobへの認証は、短時間で自動更新されるOIDCを使い、長期の読書きTokenを本番環境へ置きません。

暗号化はServer侵害時の内容秘匿を目的とします。同期Codeを知る人は履歴を復号できるため、Passwordと同様に扱ってください。

## Protocol v1

同期CodeはBase64URL表現のRandom 32 bytesです。ClientはHKDF-SHA-256で用途別Keyを導出します。

| 項目 | 値 |
| --- | --- |
| HKDF salt | `spotlog-sync-v1` |
| auth info | `spotlog-sync-auth-v1` |
| encryption info | `spotlog-sync-encryption-v1` |
| channel ID | `base64url(SHA-256(authToken bytes))` |
| Authorization | `Bearer base64url(authToken bytes)` |
| AES-GCM AAD | `spotlog-sync-v1:{channelId}` |

### PUT `/api/v1/snapshot/{channelId}`

Request bodyは次の6項目だけを受理します。

```json
{
  "version": 1,
  "iv": "base64url-12-byte-iv",
  "ciphertext": "base64url-aes-gcm-ciphertext",
  "recordCount": 12,
  "source": "spotjobs-edge",
  "collectedAt": "2026-11-13T01:02:03.000Z"
}
```

Success:

```json
{
  "ok": true,
  "storedAt": "2026-11-13T01:05:00.000Z",
  "expiresAt": "2027-02-11T01:05:00.000Z"
}
```

### GET `/api/v1/snapshot/{channelId}`

```json
{
  "envelope": {
    "version": 1,
    "iv": "...",
    "ciphertext": "...",
    "recordCount": 12,
    "source": "spotjobs-edge",
    "collectedAt": "2026-11-13T01:02:03.000Z"
  },
  "storedAt": "2026-11-13T01:05:00.000Z",
  "expiresAt": "2027-02-11T01:05:00.000Z"
}
```

Snapshotがまだない場合は404です。

読取はBlobのCDN Cacheを使わず、保存直後の最新Snapshotを返します。

### 遠隔取得 `/api/v1/refresh/{channelId}`

スマホの「今すぐ同期」がPCのEdge拡張へ最新履歴の取得を依頼するためのEndpointです。Snapshotと同じBearer認証・個人Channel Allowlist・Origin制限を使用します。

- `POST {}`: 更新依頼を作成します。2分以内の実行待ち／実行中の依頼があれば再利用します。
- `GET`: PCが最新依頼を確認します。依頼がない、または期限切れなら204です。
- `GET ?requestId={UUID}`: スマホが自分の依頼の状態を確認します。
- `PUT {"requestId":"UUID","status":"running"}`: PCが取得開始を通知します。
- SnapshotのUpload成功後にPCが`PUT {"requestId":"UUID","status":"succeeded"}`を送ります。
- 失敗時は`status: "failed"`と`errorCode`を送ります。Codeは`auth_required`、`page_required`、`disabled`、`sync_failed`だけを受け付け、公式サイトの任意Messageや認証情報は保存しません。

各成功Responseは次の形式です。`completedAt`は成功／失敗時にServerが付けます。

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "requestedAt": "2026-11-15T01:00:00.000Z",
  "expiresAt": "2026-11-15T01:02:00.000Z",
  "status": "succeeded",
  "completedAt": "2026-11-15T01:00:20.000Z"
}
```

依頼は2分で失効し、期限切れのPUTは410です。完了した依頼の状態は変更できません。依頼ごとに保存し、Blob ETagによる条件付き書込で同時更新と古い完了通知の上書きを防ぎます。状態読取もCDN Cacheを迂回します。遠隔取得MetadataはBlob TTLにより1日で自動削除されます。PCがSleep中、Edgeが終了中、拡張が停止中の場合は取得できません。

### DELETE `/api/v1/snapshot/{channelId}`

同じChannel認証でPrivate Blobを削除し、204を返します。アプリ側では実行直前にUser確認を必須にします。

### GET `/api/v1/health`

Blobと個人Channelの設定が揃っている場合だけ200 / `ok: true`を返します。秘密値は返しません。

## Limits and controls

- JSON request: 最大1 MiB
- 復号前Ciphertext: 最大700 KiB
- Record数: 最大10,000
- PUT: 30回/分、GET: 120回/分、DELETE: 10回/分（Function instance単位の保護）
- 遠隔取得: POST 10回/分、GET/PUT 120回/分、JSON最大1 KiB（Function instance単位の保護）
- 厳密なOrigin Allowlist。Wildcard CORSとCredential Cookieは使用しません。
- 認証TokenのSHA-256とURL ChannelをConstant-time比較します。
- Publicな任意Channel作成を防ぐため、`SYNC_ALLOWED_CHANNEL_IDS`が空ならFail closedします。

大規模公開時はVercel FirewallのRate Limitも併用してください。現在は1User向けのBridgeです。

## Local verification

```bash
npm install
npm run typecheck
npm test
```

`.env.example`を参考にPrivate Vercel Blobと許可Channelを設定します。実値を`.env`やGitへCommitしないでください。

## Vercel deployment

1. このDirectoryをRoot Directoryにした別Vercel Projectを作成します。
2. Private Vercel Blob Storeを接続します。
3. 同期Codeから算出したChannel IDだけを`SYNC_ALLOWED_CHANNEL_IDS`に設定します。
4. ProductionへDeployします。
5. HealthとStable Routeを確認します。

```bash
npm run verify:deployment -- https://your-sync-bridge.vercel.app
```

同期Code、派生Key、ローカル検証で使用する場合の`BLOB_READ_WRITE_TOKEN`を画面・Log・Commitへ出さないでください。本番はVercelの`BLOB_STORE_ID`とOIDCを利用します。
