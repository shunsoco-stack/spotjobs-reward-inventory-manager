import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  decodeBase64Url, decryptSyncSnapshot, deriveSyncCredentials, encodeBase64Url,
  encryptSyncSnapshot, generateSyncCode, parseSyncCode,
} from "./protocol";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
});

describe("encrypted sync protocol", () => {
  it("uses the shared HKDF protocol vector and a 256-bit portable code", async () => {
    const code = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const credentials = await deriveSyncCredentials(code);
    expect(credentials.bearerToken).toBe("ctsLbHTS8uV919pCUAwNuz8qfl9SxZTF0dYTdu6-Be0");
    expect(credentials.channelId).toBe("ynzgMBMFD4IVCyCa-d0vU4gmthLhB_slhZcfrujvENI");
    expect(parseSyncCode(code)).toEqual(Uint8Array.from({ length: 32 }, (_, index) => index));
    const generated = generateSyncCode();
    expect(generated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parseSyncCode(generated)).toHaveLength(32);
  });

  it("round-trips binary base64url without padding", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
    expect(() => parseSyncCode("AAAA")).toThrow("32バイト");
    expect(() => decodeBase64Url("invalid+")).toThrow("形式");
  });

  it("encrypts a v1 snapshot and rejects tampering or another pairing code", async () => {
    const code = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const credentials = await deriveSyncCredentials(code);
    const snapshot = { version: 1, collectedAt: "2026-11-13T01:02:03.000Z", sourceVersion: "spotlog-edge/0.1.0", records: [{ id: "one" }] };
    const envelope = await encryptSyncSnapshot(snapshot, credentials);
    expect(envelope).toMatchObject({ version: 1, source: "spotjobs-edge", recordCount: 1, collectedAt: snapshot.collectedAt });
    expect(decodeBase64Url(envelope.iv)).toHaveLength(12);
    expect(await decryptSyncSnapshot(envelope, credentials)).toEqual(snapshot);

    const changed = envelope.ciphertext[0] === "A" ? "B" : "A";
    await expect(decryptSyncSnapshot({ ...envelope, ciphertext: `${changed}${envelope.ciphertext.slice(1)}` }, credentials)).rejects.toThrow("復号");
    const other = await deriveSyncCredentials("Hh8dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA");
    await expect(decryptSyncSnapshot(envelope, other)).rejects.toThrow("復号");
  });
});
