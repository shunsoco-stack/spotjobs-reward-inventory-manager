/**
 * Runs in the MAIN world of the extension-owned app.spot.jobs sync tab.
 *
 * The official web client authenticates with `Authorization: Bearer <Firebase
 * ID token>`. This collector reads the page's own, already-issued ID token from
 * the page's Firebase persistence and sends exactly one read-only GET to the
 * single allowlisted completed-history endpoint, using the page's fetch.
 *
 * - No URL, host, or query is accepted from the caller: everything is a constant.
 * - The token (and the record key, which contains the Firebase API key) only
 *   lives in local variables for that single request. It is never returned,
 *   logged, stored, or sent anywhere else. Refresh tokens are never read.
 * - No DOM clicks, no fetch hooking, no geolocation, no token refresh, no retry.
 *
 * Keep every helper inside this function: chrome.scripting.executeScript
 * serializes the function without its module scope.
 */
export async function collectSpotJobsFromPage() {
  const API_ORIGIN = "https://spotjobs-api.spotapi.jp";
  const API_HOSTNAME = "spotjobs-api.spotapi.jp";
  const API_PATH = "/api/v1/rounder/work";
  const API_METHOD = "GET";
  const API_QUERY = [["taskStatus", "FINISHED"], ["pageNum", "1"], ["pageSize", "50"]];
  // Independent literal: the built URL must match it exactly (no lat/lng/workTypes).
  const ALLOWED_URL = "https://spotjobs-api.spotapi.jp/api/v1/rounder/work?taskStatus=FINISHED&pageNum=1&pageSize=50";
  const AUTH_DB_NAME = "firebaseLocalStorageDb";
  const AUTH_STORE_NAME = "firebaseLocalStorage";
  const AUTH_KEY_PREFIX = "firebase:authUser:";
  const REQUEST_TIMEOUT_MS = 15_000;
  const STORAGE_TIMEOUT_MS = 5_000;
  // A token that expires within this window would almost certainly be rejected
  // in flight; report it as stale instead of spending the request.
  const EXPIRY_MARGIN_MS = 30_000;

  const page = typeof window === "undefined" ? globalThis : window;
  const pageFetch = page.fetch;
  const collectedAt = () => new Date().toISOString();
  const fail = (error) => ({ records: null, collectedAt: collectedAt(), error });

  const extractList = (payload) => {
    const queue = [{ value: payload, depth: 0 }];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (Array.isArray(current.value)) return current.value;
      if (!current.value || typeof current.value !== "object" || visited.has(current.value)) {
        continue;
      }
      visited.add(current.value);
      for (const key of ["list", "records", "content", "items", "rows"]) {
        if (Array.isArray(current.value[key])) return current.value[key];
      }
      if (current.depth < 3) {
        for (const key of ["data", "result", "payload"]) {
          if (current.value[key] && typeof current.value[key] === "object") {
            queue.push({ value: current.value[key], depth: current.depth + 1 });
          }
        }
      }
    }
    return null;
  };

  // Returns only { accessToken, expirationTime } of the first auth user, or null.
  const pickCredential = (user) => {
    const manager = user && typeof user === "object" ? user.stsTokenManager : null;
    if (!manager || typeof manager !== "object") return null;
    const accessToken = typeof manager.accessToken === "string" ? manager.accessToken : "";
    if (!accessToken) return null;
    return { accessToken, expirationTime: Number(manager.expirationTime) };
  };

  const readIndexedDbCredential = () => new Promise((resolve) => {
    const factory = page.indexedDB;
    if (!factory || typeof factory.open !== "function") {
      resolve(null);
      return;
    }
    let settled = false;
    let db = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { db?.close(); } catch { /* ignore */ }
      db = null;
      resolve(value);
    };
    const timer = setTimeout(() => done(null), STORAGE_TIMEOUT_MS);
    let openRequest;
    try {
      openRequest = factory.open(AUTH_DB_NAME);
    } catch {
      done(null);
      return;
    }
    // Never create the official database when it does not exist yet.
    openRequest.onupgradeneeded = () => {
      try { openRequest.transaction?.abort(); } catch { /* ignore */ }
      done(null);
    };
    openRequest.onerror = () => done(null);
    openRequest.onblocked = () => done(null);
    openRequest.onsuccess = () => {
      if (settled) {
        try { openRequest.result?.close(); } catch { /* ignore */ }
        return;
      }
      db = openRequest.result;
      try {
        if (!db.objectStoreNames.contains(AUTH_STORE_NAME)) {
          done(null);
          return;
        }
        const store = db.transaction(AUTH_STORE_NAME, "readonly").objectStore(AUTH_STORE_NAME);
        const getAll = store.getAll();
        getAll.onerror = () => done(null);
        getAll.onsuccess = () => {
          const rows = Array.isArray(getAll.result) ? getAll.result : [];
          const row = rows.find((entry) => typeof entry?.fbase_key === "string" &&
            entry.fbase_key.startsWith(AUTH_KEY_PREFIX));
          done(row ? pickCredential(row.value) : null);
        };
      } catch {
        done(null);
      }
    };
  });

  const readLocalStorageCredential = () => {
    try {
      const storage = page.localStorage;
      if (!storage) return null;
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (typeof key !== "string" || !key.startsWith(AUTH_KEY_PREFIX)) continue;
        const raw = storage.getItem(key);
        if (!raw) continue;
        try {
          const credential = pickCredential(JSON.parse(raw));
          if (credential) return credential;
        } catch {
          // Unparsable record: keep looking.
        }
      }
    } catch {
      // Storage unavailable in this context.
    }
    return null;
  };

  // 1. The request is built only from constants and verified before use.
  let url;
  try {
    url = new URL(API_PATH, API_ORIGIN);
    for (const [name, value] of API_QUERY) url.searchParams.set(name, value);
  } catch {
    return fail("SPOTLOG_BLOCKED_REQUEST");
  }
  if (url.protocol !== "https:" || url.hostname !== API_HOSTNAME || url.port !== "" ||
    url.pathname !== API_PATH || url.href !== ALLOWED_URL || url.hash !== "" ||
    url.username !== "" || url.password !== "" || API_METHOD !== "GET") {
    return fail("SPOTLOG_BLOCKED_REQUEST");
  }
  if (typeof pageFetch !== "function") return fail("SPOTLOG_API_FORMAT_CHANGED");

  // 2. The page's current Firebase ID token (never refreshed here).
  let credential = null;
  try {
    credential = await readIndexedDbCredential();
  } catch {
    credential = null;
  }
  if (!credential) credential = readLocalStorageCredential();
  if (!credential) return fail("SPOTLOG_AUTH_REQUIRED");
  const { expirationTime } = credential;
  if (!Number.isFinite(expirationTime) || expirationTime <= Date.now() + EXPIRY_MARGIN_MS) {
    credential = null;
    return fail("SPOTLOG_TOKEN_STALE");
  }

  // 3. Exactly one request.
  let response;
  try {
    const init = {
      method: API_METHOD,
      headers: { Authorization: `Bearer ${credential.accessToken}`, Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    };
    credential = null;
    response = await pageFetch.call(page, url.toString(), init);
  } catch {
    return fail("SPOTLOG_API_ERROR:NETWORK");
  } finally {
    credential = null;
  }

  if (response.status === 401 || response.status === 403) return fail("SPOTLOG_AUTH_REQUIRED");
  if (!response.ok) {
    const status = Number(response.status);
    return fail(`SPOTLOG_API_ERROR:${Number.isInteger(status) ? status : "UNKNOWN"}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return fail("SPOTLOG_API_FORMAT_CHANGED");
  }
  const records = extractList(payload);
  if (!records) return fail("SPOTLOG_API_FORMAT_CHANGED");
  return { records, collectedAt: collectedAt() };
}
