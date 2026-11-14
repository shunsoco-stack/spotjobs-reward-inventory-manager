import { describe, expect, it, vi } from "vitest";
import {
  SYNC_PAIRING_FRAGMENT_KEY,
  consumeSyncPairingFragment,
  createSyncPairingUrl,
  parseSyncPairingFragment,
} from "./pairing-link";

const syncCode = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("cross-device sync pairing links", () => {
  it("keeps the sync code only in the URL fragment", () => {
    const pairingUrl = createSyncPairingUrl(
      syncCode,
      "https://spotjobs.example/settings?campaign=private#previous",
    );
    const parsed = new URL(pairingUrl);

    expect(parsed.origin + parsed.pathname).toBe("https://spotjobs.example/settings");
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe(`#${SYNC_PAIRING_FRAGMENT_KEY}=${syncCode}`);
    expect(pairingUrl.split("#")[0]).not.toContain(syncCode);
  });

  it("validates codes before creating or accepting a pairing link", () => {
    expect(() => createSyncPairingUrl("broken", "https://spotjobs.example/"))
      .toThrow("同期コード");
    expect(() => createSyncPairingUrl(syncCode, "http://spotjobs.example/"))
      .toThrow("HTTPS");
    expect(() => createSyncPairingUrl(syncCode, "http://localhost:3059/"))
      .not.toThrow();
    expect(() => createSyncPairingUrl(syncCode, "http://127.0.0.1:3059/"))
      .not.toThrow();
    expect(() => createSyncPairingUrl(syncCode, "http://[::1]:3059/"))
      .not.toThrow();
    expect(() => createSyncPairingUrl(syncCode, "https://user:password@spotjobs.example/"))
      .toThrow("認証情報");
    expect(() => createSyncPairingUrl(syncCode, "file:///app/index.html"))
      .toThrow("HTTPS");
    expect(() => createSyncPairingUrl(syncCode, "not a url"))
      .toThrow("正しくありません");
    expect(parseSyncPairingFragment(`#${SYNC_PAIRING_FRAGMENT_KEY}=broken`))
      .toEqual({ status: "invalid", message: "スマホ接続リンクが正しくありません。" });
    expect(parseSyncPairingFragment(
      `#${SYNC_PAIRING_FRAGMENT_KEY}=${syncCode}&${SYNC_PAIRING_FRAGMENT_KEY}=${syncCode}`,
    )).toEqual({ status: "invalid", message: "スマホ接続リンクが正しくありません。" });
  });

  it("consumes a valid code and immediately strips the whole secret fragment", () => {
    const replaceState = vi.fn();
    const result = consumeSyncPairingFragment(
      {
        hash: `#${SYNC_PAIRING_FRAGMENT_KEY}=${syncCode}&view=settings`,
        pathname: "/",
        search: "?theme=dark",
      },
      { state: { preserved: true }, replaceState },
    );

    expect(result).toEqual({ status: "ready", syncCode });
    expect(replaceState).toHaveBeenCalledWith({ preserved: true }, "", "/?theme=dark");
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain(syncCode);
  });

  it("strips an invalid pairing fragment but ignores query and unrelated anchors", () => {
    const invalidReplace = vi.fn();
    expect(consumeSyncPairingFragment(
      { hash: `#${SYNC_PAIRING_FRAGMENT_KEY}=broken`, pathname: "/app", search: "" },
      { state: null, replaceState: invalidReplace },
    ).status).toBe("invalid");
    expect(invalidReplace).toHaveBeenCalledWith(null, "", "/app");

    const unrelatedReplace = vi.fn();
    expect(consumeSyncPairingFragment(
      { hash: "#inventory", pathname: "/", search: `?${SYNC_PAIRING_FRAGMENT_KEY}=${syncCode}` },
      { state: null, replaceState: unrelatedReplace },
    )).toEqual({ status: "none" });
    expect(unrelatedReplace).not.toHaveBeenCalled();
  });
});
