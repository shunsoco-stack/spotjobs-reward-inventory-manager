const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const SYNC_PROTOCOL_VERSION = 1 as const;
export const SYNC_HKDF_SALT = "spotlog-sync-v1";
export const SYNC_AUTH_INFO = "spotlog-sync-auth-v1";
export const SYNC_ENCRYPTION_INFO = "spotlog-sync-encryption-v1";
export const MAX_ENCRYPTED_SNAPSHOT_BYTES = 1_000_000;

export interface EncryptedSyncEnvelope {
  version: typeof SYNC_PROTOCOL_VERSION;
  iv: string;
  ciphertext: string;
  recordCount: number;
  source: "spotjobs-edge";
  collectedAt: string;
}

export interface SyncCredentials {
  channelId: string;
  bearerToken: string;
  encryptionKey: CryptoKey;
}

function webCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) throw new Error("この端末では暗号化同期を利用できません。");
  return globalThis.crypto;
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 8_192)));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64Url(value: string, label = "暗号化データ"): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label}の形式が正しくありません。`);
  const remainder = value.length % 4;
  if (remainder === 1) throw new Error(`${label}の形式が正しくありません。`);
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - remainder) % 4);
  let decoded: string;
  try { decoded = atob(padded); }
  catch { throw new Error(`${label}の形式が正しくありません。`); }
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

/** Generates a portable 256-bit pairing code. The code itself never needs to reach the bridge. */
export function generateSyncCode(): string {
  return encodeBase64Url(webCrypto().getRandomValues(new Uint8Array(32)));
}

export function parseSyncCode(value: string): Uint8Array {
  const bytes = decodeBase64Url(value.trim(), "同期コード");
  if (bytes.length !== 32) throw new Error("同期コードは32バイトのコードを入力してください。");
  return bytes;
}

async function deriveBytes(key: CryptoKey, info: string): Promise<Uint8Array> {
  const bits = await webCrypto().subtle.deriveBits({
    name: "HKDF", hash: "SHA-256", salt: buffer(textEncoder.encode(SYNC_HKDF_SALT)),
    info: buffer(textEncoder.encode(info)),
  }, key, 256);
  return new Uint8Array(bits);
}

/** Derives independent authentication and encryption material from one pairing code. */
export async function deriveSyncCredentials(syncCode: string): Promise<SyncCredentials> {
  const root = await webCrypto().subtle.importKey("raw", buffer(parseSyncCode(syncCode)), "HKDF", false, ["deriveBits"]);
  const [authToken, encryptionBytes] = await Promise.all([
    deriveBytes(root, SYNC_AUTH_INFO), deriveBytes(root, SYNC_ENCRYPTION_INFO),
  ]);
  const [digest, encryptionKey] = await Promise.all([
    webCrypto().subtle.digest("SHA-256", buffer(authToken)),
    webCrypto().subtle.importKey("raw", buffer(encryptionBytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
  ]);
  return {
    channelId: encodeBase64Url(new Uint8Array(digest)),
    bearerToken: encodeBase64Url(authToken),
    encryptionKey,
  };
}

function associatedData(channelId: string): ArrayBuffer {
  return buffer(textEncoder.encode(`${SYNC_HKDF_SALT}:${channelId}`));
}

export function validateEncryptedEnvelope(value: unknown): EncryptedSyncEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("同期データの形式が正しくありません。");
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== SYNC_PROTOCOL_VERSION || envelope.source !== "spotjobs-edge"
    || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string"
    || typeof envelope.recordCount !== "number" || !Number.isSafeInteger(envelope.recordCount)
    || envelope.recordCount < 0 || envelope.recordCount > 20_000
    || typeof envelope.collectedAt !== "string" || !Number.isFinite(Date.parse(envelope.collectedAt))) {
    throw new Error("対応していない同期データです。");
  }
  const iv = decodeBase64Url(envelope.iv, "初期化ベクトル");
  const ciphertext = decodeBase64Url(envelope.ciphertext, "暗号文");
  if (iv.length !== 12) throw new Error("初期化ベクトルの長さが正しくありません。");
  if (ciphertext.length < 17 || ciphertext.length > MAX_ENCRYPTED_SNAPSHOT_BYTES) throw new Error("暗号文のサイズを確認してください。");
  return {
    version: SYNC_PROTOCOL_VERSION, iv: envelope.iv, ciphertext: envelope.ciphertext,
    recordCount: envelope.recordCount, source: "spotjobs-edge", collectedAt: new Date(envelope.collectedAt).toISOString(),
  };
}

export async function encryptSyncSnapshot(value: unknown, credentials: SyncCredentials): Promise<EncryptedSyncEnvelope> {
  const plaintext = textEncoder.encode(JSON.stringify(value));
  if (plaintext.length > MAX_ENCRYPTED_SNAPSHOT_BYTES - 16) throw new Error("同期する履歴が大きすぎます。");
  const iv = webCrypto().getRandomValues(new Uint8Array(12));
  const ciphertext = await webCrypto().subtle.encrypt({
    name: "AES-GCM", iv: buffer(iv), additionalData: associatedData(credentials.channelId), tagLength: 128,
  }, credentials.encryptionKey, buffer(plaintext));
  const snapshot = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const records = Array.isArray(snapshot.records) ? snapshot.records : [];
  const collectedAt = typeof snapshot.collectedAt === "string" && Number.isFinite(Date.parse(snapshot.collectedAt))
    ? new Date(snapshot.collectedAt).toISOString() : new Date().toISOString();
  return {
    version: SYNC_PROTOCOL_VERSION, iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    recordCount: records.length, source: "spotjobs-edge", collectedAt,
  };
}

export async function decryptSyncSnapshot(envelopeValue: unknown, credentials: SyncCredentials): Promise<unknown> {
  const envelope = validateEncryptedEnvelope(envelopeValue);
  try {
    const plaintext = await webCrypto().subtle.decrypt({
      name: "AES-GCM", iv: buffer(decodeBase64Url(envelope.iv)),
      additionalData: associatedData(credentials.channelId), tagLength: 128,
    }, credentials.encryptionKey, buffer(decodeBase64Url(envelope.ciphertext)));
    return JSON.parse(textDecoder.decode(plaintext));
  } catch {
    throw new Error("同期データを復号できません。同期コードが正しいか確認してください。");
  }
}
