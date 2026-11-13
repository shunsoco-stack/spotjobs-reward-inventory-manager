# SPOTJOBS報酬・在庫管理アプリ encrypted sync bridge

SPOTJOBSのログイン情報をクラウドへ渡さず、Edge拡張で取得した作業履歴をWeb／iOS／Android版「SPOTJOBS報酬・在庫管理アプリ」へ届けるための、個人用の暗号化同期Inboxです。本体PWAとは別のVercelプロジェクトとして公開します。

## Privacy model

- SPOTJOBSのパスワード、Cookie、認証Tokenは受け取りません。
- 作業履歴はPC上でAES-256-GCM暗号化してから送信します。
- Vercel Blobには`iv`と`ciphertext`を含む暗号化EnvelopeだけをPrivate Blobとして保存します。
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

### DELETE `/api/v1/snapshot/{channelId}`

同じChannel認証でPrivate Blobを削除し、204を返します。アプリ側では実行直前にUser確認を必須にします。

### GET `/api/v1/health`

Blobと個人Channelの設定が揃っている場合だけ200 / `ok: true`を返します。秘密値は返しません。

## Limits and controls

- JSON request: 最大1 MiB
- 復号前Ciphertext: 最大700 KiB
- Record数: 最大10,000
- PUT: 30回/分、GET: 120回/分、DELETE: 10回/分（Function instance単位の保護）
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
