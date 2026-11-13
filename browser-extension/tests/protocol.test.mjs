import test from "node:test";
import assert from "node:assert/strict";

const {
  deriveSyncSecrets,
  encryptSnapshot,
  decryptSnapshot,
  generateSyncCode,
  parseSyncCode
} = await import("../lib/protocol.js");

test("32-byte sync code derives stable separated secrets", async () => {
  const code = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(parseSyncCode(code).byteLength, 32);
  const first = await deriveSyncSecrets(code);
  const second = await deriveSyncSecrets(code);
  assert.equal(first.authToken, second.authToken);
  assert.equal(first.channelId, second.channelId);
  assert.notEqual(first.authToken, first.channelId);
});

test("snapshot encrypts, decrypts, and rejects tampering", async () => {
  const secrets = await deriveSyncSecrets(generateSyncCode());
  const value = {
    version: 1,
    records: [{ externalId: "job-1", workType: "BATTERY_INSERT", quantity: 3 }]
  };
  const envelope = await encryptSnapshot(value, secrets);
  assert.deepEqual(await decryptSnapshot(envelope, secrets), value);

  const tampered = {
    ...envelope,
    ciphertext: `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith("A") ? "B" : "A"}`
  };
  await assert.rejects(() => decryptSnapshot(tampered, secrets), /復号できません/u);
});

test("invalid sync code is rejected", () => {
  assert.throws(() => parseSyncCode("short"), /形式|32バイト/u);
  assert.throws(() => parseSyncCode("!!!"), /形式/u);
});
