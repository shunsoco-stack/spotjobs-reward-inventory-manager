import { parseSyncCode } from "./protocol";

export const SYNC_PAIRING_FRAGMENT_KEY = "spotjobs-sync";

export type SyncPairingFragment =
  | { status: "none" }
  | { status: "ready"; syncCode: string }
  | { status: "invalid"; message: string };

export interface PairingLocation {
  hash: string;
  pathname: string;
  search: string;
}

export interface PairingHistory {
  state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/**
 * Builds a same-origin pairing link whose secret exists only after `#`.
 * URL fragments are not included in HTTP requests or Referer headers.
 */
export function createSyncPairingUrl(syncCode: string, baseUrl: string): string {
  const normalized = syncCode.trim();
  parseSyncCode(normalized);

  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw new Error("接続先URLが正しくありません。"); }
  if (url.username || url.password) {
    throw new Error("接続先URLに認証情報を含めないでください。");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("接続先URLはHTTPSのWebアプリを指定してください。");
  }

  // Never copy an existing query into the pairing link. The sync code is kept
  // exclusively in the fragment and therefore never reaches the web server.
  url.search = "";
  url.hash = new URLSearchParams([[SYNC_PAIRING_FRAGMENT_KEY, normalized]]).toString();
  return url.toString();
}

export function parseSyncPairingFragment(hash: string): SyncPairingFragment {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!fragment) return { status: "none" };

  const params = new URLSearchParams(fragment);
  const values = params.getAll(SYNC_PAIRING_FRAGMENT_KEY);
  if (values.length === 0) return { status: "none" };
  if (values.length !== 1) {
    return { status: "invalid", message: "スマホ接続リンクが正しくありません。" };
  }

  const syncCode = values[0].trim();
  try {
    parseSyncCode(syncCode);
    return { status: "ready", syncCode };
  } catch {
    return { status: "invalid", message: "スマホ接続リンクが正しくありません。" };
  }
}

/**
 * Reads a pairing fragment and immediately removes it from the visible URL.
 * Invalid pairing fragments are stripped as well so a malformed secret never
 * lingers in browser history. Unrelated anchors are left untouched.
 */
export function consumeSyncPairingFragment(
  location: PairingLocation,
  history: PairingHistory,
): SyncPairingFragment {
  const result = parseSyncPairingFragment(location.hash);
  if (result.status !== "none") {
    history.replaceState(history.state, "", `${location.pathname}${location.search}` || "/");
  }
  return result;
}
