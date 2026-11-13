const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PROTOCOL_VERSION = 1;
export const HKDF_SALT = "spotlog-sync-v1";
export const AUTH_INFO = "spotlog-sync-auth-v1";
export const ENCRYPTION_INFO = "spotlog-sync-encryption-v1";

function activeCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("この環境では暗号化機能を利用できません。");
  }
  return globalThis.crypto;
}

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function base64UrlToBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("同期コードの形式が正しくありません。");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("同期コードの形式が正しくありません。");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function parseSyncCode(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^spotlog-sync-v1:/u, "");
  const bytes = base64UrlToBytes(normalized);
  if (bytes.byteLength !== 32) {
    throw new Error("同期コードはこのアプリで作成した32バイトのコードを入力してください。");
  }
  return bytes;
}

export function generateSyncCode() {
  const bytes = new Uint8Array(32);
  activeCrypto().getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function deriveBits(sourceKey, info) {
  const cryptoApi = activeCrypto();
  return new Uint8Array(
    await cryptoApi.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode(HKDF_SALT),
        info: encoder.encode(info)
      },
      sourceKey,
      256
    )
  );
}

export async function deriveSyncSecrets(syncCode) {
  const cryptoApi = activeCrypto();
  const sourceKey = await cryptoApi.subtle.importKey(
    "raw",
    parseSyncCode(syncCode),
    "HKDF",
    false,
    ["deriveBits"]
  );
  const authBytes = await deriveBits(sourceKey, AUTH_INFO);
  const encryptionBytes = await deriveBits(sourceKey, ENCRYPTION_INFO);
  const encryptionKey = await cryptoApi.subtle.importKey(
    "raw",
    encryptionBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
  const channelHash = new Uint8Array(
    await cryptoApi.subtle.digest("SHA-256", authBytes)
  );

  return {
    authToken: bytesToBase64Url(authBytes),
    channelId: bytesToBase64Url(channelHash),
    encryptionKey
  };
}

function additionalData(channelId) {
  return encoder.encode(`spotlog-sync-v1:${channelId}`);
}

export async function encryptSnapshot(plaintext, secrets) {
  const cryptoApi = activeCrypto();
  const iv = new Uint8Array(12);
  cryptoApi.getRandomValues(iv);
  const encoded = encoder.encode(JSON.stringify(plaintext));
  const encrypted = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: additionalData(secrets.channelId),
      tagLength: 128
    },
    secrets.encryptionKey,
    encoded
  );

  return {
    version: PROTOCOL_VERSION,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted))
  };
}

export async function decryptSnapshot(envelope, secrets) {
  if (
    !envelope ||
    envelope.version !== PROTOCOL_VERSION ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("同期データの形式が正しくありません。");
  }
  const cryptoApi = activeCrypto();
  try {
    const decrypted = await cryptoApi.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(envelope.iv),
        additionalData: additionalData(secrets.channelId),
        tagLength: 128
      },
      secrets.encryptionKey,
      base64UrlToBytes(envelope.ciphertext)
    );
    return JSON.parse(decoder.decode(decrypted));
  } catch {
    throw new Error("同期データを復号できません。同期コードを確認してください。");
  }
}
