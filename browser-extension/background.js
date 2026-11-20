import {
  decryptSnapshot,
  deriveSyncSecrets,
  encryptSnapshot
} from "./lib/protocol.js";
import {
  mergeSnapshots,
  normalizeSpotJobsItems
} from "./lib/normalizer.js";
import { collectSpotJobsFromPage } from "./lib/page-collector.js";
import { createRemoteRefreshPoller } from "./lib/remote-refresh.js";

const ALARM_NAME = "spotlog-periodic-sync";
const REFRESH_ALARM_NAME = "spotlog-remote-refresh";
const DEFAULT_BRIDGE_URL = "https://spotjobs-reward-inventory-sync.vercel.app";
const DEFAULT_INTERVAL = 30;
const SPOTJOBS_PAGE_URL = "https://app.spot.jobs/user-job-list";
const SOURCE_VERSION = "spotlog-edge/0.3.0";
const DEDICATED_TAB_KEY = "dedicatedSyncTab";
const DEDICATED_TAB_SESSION_KEY = "dedicatedSyncTabSession";
const LAST_REQUEST_KEY = "lastSpotJobsRequestAt";
const MIN_REQUEST_INTERVAL_MS = 60_000;
const TAB_LOAD_TIMEOUT_MS = 30_000;
let runningSync = null;

// Fixed, user-facing messages. Raw collector or browser error text is never
// shown, stored, or sent (it could otherwise carry request details).
const MESSAGES = {
  authRequired: "SPOTJOBSのログインが切れています。PCのEdgeでSPOTJOBSにログインし直してください。",
  tokenStale: "SPOTJOBSのログイン情報を更新できませんでした。PCのEdgeでSPOTJOBSを開いたままにして、しばらくしてから再試行してください。",
  blocked: "安全のため、SPOTJOBSへの通信を中止しました。拡張機能を更新してください。",
  formatChanged: "SPOTJOBSの仕様が変わった可能性があります。拡張機能を更新してください。",
  network: "SPOTJOBSに接続できませんでした。通信状態を確認して、しばらくしてから再試行してください。",
  apiError: (status) => `SPOTJOBSの完了履歴を取得できませんでした（${status}）。しばらくしてから再試行してください。`,
  tabUnavailable: "同期用タブから履歴を読み取れませんでした。しばらくしてから再試行してください。",
  tabNotLoaded: "同期用タブの読み込みが完了しませんでした。しばらくしてから再試行してください。"
};

class CollectionError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function getState() {
  const stored = await chrome.storage.local.get([
    "config",
    "syncStatus"
  ]);
  return {
    config: {
      enabled: false,
      bridgeUrl: DEFAULT_BRIDGE_URL,
      intervalMinutes: DEFAULT_INTERVAL,
      syncCode: "",
      ...(stored.config || {})
    },
    syncStatus: stored.syncStatus || {
      state: "not-configured",
      message: "同期コードを設定してください。"
    }
  };
}

async function setStatus(state, message, extra = {}) {
  const syncStatus = {
    state,
    message,
    updatedAt: new Date().toISOString(),
    ...extra
  };
  await chrome.storage.local.set({ syncStatus });
  const needsAttention = ["auth-required", "page-required", "error"].includes(state);
  await chrome.action.setBadgeText({
    text: state === "syncing" ? "…" : needsAttention ? "!" : ""
  });
  if (state === "syncing" || needsAttention) {
    await chrome.action.setBadgeBackgroundColor({
      color: needsAttention ? "#C73333" : "#1AAEE8"
    });
  }
  return syncStatus;
}

function normalizedBridgeUrl(value) {
  const url = new URL(value);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const isProduction = url.origin === new URL(DEFAULT_BRIDGE_URL).origin;
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new Error("同期先はHTTPSを指定してください。");
  }
  if (!isProduction && !isLocal) {
    throw new Error("同期先はこのアプリ専用の同期サーバーのみ指定できます。");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

async function scheduleAlarms(config, reset = false) {
  if (!config.enabled || !config.syncCode) {
    await Promise.all([chrome.alarms.clear(ALARM_NAME), chrome.alarms.clear(REFRESH_ALARM_NAME)]);
    return;
  }
  const intervals = [
    [ALARM_NAME, config.intervalMinutes],
    [REFRESH_ALARM_NAME, 0.5]
  ];
  for (const [name, periodInMinutes] of intervals) {
    const existing = await chrome.alarms.get(name);
    if (reset || !existing || existing.periodInMinutes !== periodInMinutes) {
      await chrome.alarms.create(name, {
        delayInMinutes: Math.min(periodInMinutes, 1),
        periodInMinutes
      });
    }
  }
}

function isSpotJobsListUrl(url) {
  return typeof url === "string" && url.startsWith(SPOTJOBS_PAGE_URL);
}

// Tab ids are only unique within one browser session. chrome.storage.session
// is cleared when the browser exits, so a marker there proves the stored id
// was issued in the current session and cannot belong to a user's tab.
function sessionArea() {
  const area = chrome.storage?.session;
  return area && typeof area.get === "function" ? area : null;
}

/** Returns true/false for a session marker match, or null if unavailable. */
async function sessionMarkerMatches(tabId) {
  const area = sessionArea();
  if (!area) return null;
  try {
    const stored = await area.get(DEDICATED_TAB_SESSION_KEY);
    return stored?.[DEDICATED_TAB_SESSION_KEY]?.tabId === tabId;
  } catch {
    return null;
  }
}

async function readDedicatedTab() {
  const stored = await chrome.storage.local.get(DEDICATED_TAB_KEY);
  const record = stored?.[DEDICATED_TAB_KEY];
  if (!record || !Number.isInteger(record.tabId)) return null;
  // Without session storage, onStartup forgetting the record is the guard.
  if ((await sessionMarkerMatches(record.tabId)) === false) return null;
  return record;
}

async function forgetDedicatedTab() {
  await chrome.storage.local.remove(DEDICATED_TAB_KEY);
  try {
    await sessionArea()?.remove(DEDICATED_TAB_SESSION_KEY);
  } catch {
    // The session marker is cleared with the browser session anyway.
  }
}

async function rememberDedicatedTab(tabId, windowId) {
  const record = { tabId, openedAt: Date.now() };
  if (Number.isInteger(windowId)) record.windowId = windowId;
  await chrome.storage.local.set({ [DEDICATED_TAB_KEY]: record });
  try {
    await sessionArea()?.set({ [DEDICATED_TAB_SESSION_KEY]: { tabId } });
  } catch {
    // Without a marker the tab is simply not reused; a new one is opened.
  }
}

/**
 * Resolves true once a freshly opened tab reports status "complete" (false on
 * timeout or a closed tab). An already-complete tab also counts.
 */
function watchTabLoad(tabId) {
  return new Promise((resolve) => {
    let done = false;
    let timer;
    const listener = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo?.status === "complete") finish(true);
    };
    const finish = (loaded) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(loaded);
    };
    timer = setTimeout(() => finish(false), TAB_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(
      (tab) => { if (tab?.status === "complete") finish(true); },
      () => finish(false)
    );
  });
}

async function openDedicatedTab() {
  let windows = [];
  try {
    windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  } catch {
    windows = [];
  }
  const candidates = (windows || []).filter((win) => Number.isInteger(win?.id) && !win.incognito);
  if (!candidates.length) return null;
  // Never focus a window or activate a tab: the sync tab opens in the background.
  const target = candidates.find((win) => win.focused) || candidates[0];
  let tab;
  try {
    tab = await chrome.tabs.create({ url: SPOTJOBS_PAGE_URL, active: false, windowId: target.id });
  } catch {
    return null;
  }
  if (!Number.isInteger(tab?.id)) return null;
  await rememberDedicatedTab(tab.id, Number.isInteger(tab.windowId) ? tab.windowId : target.id);
  try {
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } catch {
    // Best effort only; the extension never reloads the tab.
  }
  const loaded = await watchTabLoad(tab.id);
  return { tabId: tab.id, windowId: tab.windowId, loaded };
}

/**
 * Returns the extension-owned sync tab, opening it only when it is missing.
 * The extension never reloads any tab, and tabs the user opened are never
 * selected, queried, or otherwise touched.
 */
async function prepareDedicatedTab() {
  const stored = await readDedicatedTab();
  if (stored) {
    let tab = null;
    try {
      tab = await chrome.tabs.get(stored.tabId);
    } catch {
      tab = null;
    }
    if (tab && isSpotJobsListUrl(tab.url || tab.pendingUrl)) {
      return { tabId: tab.id, windowId: tab.windowId, loaded: true };
    }
    // Closed, or navigated away by the user: forget it without touching it.
    await forgetDedicatedTab();
  }
  return openDedicatedTab();
}

/** Returns true when a SPOTJOBS request was already made within the interval. */
async function withinMinimumInterval() {
  const stored = await chrome.storage.local.get(LAST_REQUEST_KEY);
  const last = Number(stored?.[LAST_REQUEST_KEY]);
  const now = Date.now();
  // A stored time in the future (clock changed) never blocks; it is overwritten.
  return Number.isFinite(last) && last <= now && now - last < MIN_REQUEST_INTERVAL_MS;
}

/** Executes the page collector once. Throws CollectionError with a fixed code. */
async function collectFromTab(tabId) {
  await chrome.storage.local.set({ [LAST_REQUEST_KEY]: Date.now() });
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: collectSpotJobsFromPage
    });
  } catch {
    throw new CollectionError("SPOTLOG_TAB_UNAVAILABLE");
  }
  const result = results?.[0]?.result;
  if (result?.error) throw new CollectionError(String(result.error));
  if (!result || !Array.isArray(result.records)) {
    throw new CollectionError("SPOTLOG_API_FORMAT_CHANGED");
  }
  return result;
}

function collectionFailure(code) {
  if (code === "SPOTLOG_AUTH_REQUIRED") return { state: "auth-required", message: MESSAGES.authRequired };
  if (code === "SPOTLOG_TOKEN_STALE") return { state: "error", message: MESSAGES.tokenStale };
  if (code === "SPOTLOG_BLOCKED_REQUEST") return { state: "error", message: MESSAGES.blocked };
  if (code === "SPOTLOG_API_FORMAT_CHANGED") return { state: "error", message: MESSAGES.formatChanged };
  if (code === "SPOTLOG_API_ERROR:NETWORK") return { state: "error", message: MESSAGES.network };
  const apiStatus = /^SPOTLOG_API_ERROR:(\d{3})$/u.exec(code)?.[1];
  if (apiStatus) return { state: "error", message: MESSAGES.apiError(apiStatus) };
  if (code === "SPOTLOG_TAB_NOT_LOADED") return { state: "error", message: MESSAGES.tabNotLoaded };
  return { state: "error", message: MESSAGES.tabUnavailable };
}

async function fetchRemoteSnapshot(bridgeUrl, secrets) {
  const response = await fetch(
    `${bridgeUrl}/api/v1/snapshot/${encodeURIComponent(secrets.channelId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${secrets.authToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    }
  );
  if (response.status === 404) return [];
  if (response.status === 401 || response.status === 403) {
    throw new Error("同期コードが同期先と一致しません。");
  }
  if (!response.ok) throw new Error(`同期データの取得に失敗しました（${response.status}）。`);
  const body = await response.json();
  const plaintext = await decryptSnapshot(body.envelope || body, secrets);
  return Array.isArray(plaintext?.records) ? plaintext.records : [];
}

async function uploadSnapshot(bridgeUrl, secrets, records, collectedAt) {
  const plaintext = {
    version: 1,
    collectedAt,
    sourceVersion: SOURCE_VERSION,
    records
  };
  const encrypted = await encryptSnapshot(plaintext, secrets);
  const envelope = {
    ...encrypted,
    source: "spotjobs-edge",
    recordCount: records.length,
    collectedAt
  };
  const response = await fetch(
    `${bridgeUrl}/api/v1/snapshot/${encodeURIComponent(secrets.channelId)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${secrets.authToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(15_000)
    }
  );
  if (response.status === 401 || response.status === 403) {
    throw new Error("同期コードが同期先と一致しません。");
  }
  if (!response.ok) throw new Error(`同期データの保存に失敗しました（${response.status}）。`);
}

async function maybeNotifyAuthRequired(message) {
  const { lastAuthNotificationAt = 0 } = await chrome.storage.local.get(
    "lastAuthNotificationAt"
  );
  if (Date.now() - lastAuthNotificationAt < 6 * 60 * 60 * 1000) return;
  try {
    await chrome.notifications.create("spotlog-auth-required", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon.svg"),
      title: "SPOTJOBS報酬・在庫管理 自動同期",
      message
    });
    await chrome.storage.local.set({ lastAuthNotificationAt: Date.now() });
  } catch {
    // The action badge still communicates the error if this platform cannot
    // render the bundled SVG as a notification icon.
  }
}

async function performSync(trigger = "scheduled", expectedConfig) {
  const { config, syncStatus: previousStatus } = await getState();
  // A phone request is tied to the channel it arrived on. A configuration
  // change during an awaited read must never upload to a new channel and then
  // acknowledge the old request as successful.
  if (expectedConfig && (!config.enabled || config.syncCode !== expectedConfig.syncCode ||
    config.bridgeUrl !== expectedConfig.bridgeUrl)) return { state: "not-configured" };
  if (!config.enabled || !config.syncCode) {
    return setStatus("not-configured", "同期コードを設定してください。");
  }

  const bridgeUrl = normalizedBridgeUrl(config.bridgeUrl);
  // At most one SPOTJOBS request per minute, whatever the trigger. A sync
  // started too soon reports the previous result unchanged and uploads nothing.
  if (await withinMinimumInterval()) return previousStatus;

  await setStatus("syncing", "SPOTJOBSの完了履歴を確認しています…", { trigger });
  let collected;
  try {
    const prepared = await prepareDedicatedTab();
    if (!prepared) {
      const message = "同期用タブを開けませんでした。Edgeのウィンドウを開いてください。";
      const status = await setStatus("page-required", message);
      if (trigger === "manual") await maybeNotifyAuthRequired(message);
      return status;
    }
    if (!prepared.loaded) throw new CollectionError("SPOTLOG_TAB_NOT_LOADED");
    // Exactly one collection per run: failures are reported, never retried.
    collected = await collectFromTab(prepared.tabId);
  } catch (error) {
    const failure = collectionFailure(error instanceof CollectionError ? error.code : "");
    const status = await setStatus(failure.state, failure.message, { trigger });
    if (failure.state === "auth-required") await maybeNotifyAuthRequired(failure.message);
    return status;
  }

  try {
    // Merge the latest window with the encrypted remote snapshot. Bridge
    // errors below never cause additional SPOTJOBS access.
    const incoming = normalizeSpotJobsItems(collected.records);
    const secrets = await deriveSyncSecrets(config.syncCode);
    const existing = await fetchRemoteSnapshot(bridgeUrl, secrets);
    const existingIds = new Set(existing.map((record) => record?.externalId).filter(Boolean));
    const newCount = incoming.filter((record) => !existingIds.has(record.externalId)).length;
    const merged = mergeSnapshots(existing, incoming);
    await uploadSnapshot(bridgeUrl, secrets, merged, collected.collectedAt);

    return setStatus(
      "success",
      newCount
        ? `${newCount}件の新しい履歴を暗号化して同期しました。`
        : "新しい履歴はありません。",
      {
        lastSyncedAt: new Date().toISOString(),
        importedCount: newCount,
        totalCount: merged.length,
        trigger
      }
    );
  } catch (error) {
    // Bridge/encryption errors carry only this extension's own messages.
    const rawMessage = error instanceof Error ? error.message : String(error);
    return setStatus("error", rawMessage.replace(/^Error:\s*/u, ""), { trigger });
  }
}

function runSync(trigger, expectedConfig) {
  if (expectedConfig && runningSync) {
    return runningSync.then(() => runSync(trigger, expectedConfig));
  }
  if (!runningSync) {
    runningSync = performSync(trigger, expectedConfig).finally(() => {
      runningSync = null;
    });
  }
  return runningSync;
}

const pollRemoteRefresh = createRemoteRefreshPoller({
  getConfig: async () => (await getState()).config,
  deriveSecrets: deriveSyncSecrets,
  normalizeBridgeUrl: normalizedBridgeUrl,
  storage: chrome.storage.local,
  synchronize: (_command, requestedConfig) => {
    // A sync already in progress may have captured history before the phone
    // requested it. Wait, then collect again; within the minimum request
    // interval the just-finished result is reported instead.
    return runSync("remote", requestedConfig);
  }
});

// Chrome may discard alarms across sessions. Recreate missing alarms whenever
// the worker wakes, without moving an existing alarm's scheduled time.
void getState().then(({ config }) => scheduleAlarms(config)).catch(() => undefined);

chrome.runtime.onInstalled.addListener(async () => {
  const { config } = await getState();
  await chrome.storage.local.set({ config });
  await scheduleAlarms(config, true);
  await pollRemoteRefresh();
});

chrome.runtime.onStartup.addListener(async () => {
  // Tab ids from the previous browser session may now belong to user tabs:
  // forget the record (without touching any tab) before anything else.
  await forgetDedicatedTab();
  const { config } = await getState();
  await scheduleAlarms(config, true);
  // No immediate collection at startup: SPOTJOBS is only accessed by the
  // scheduled alarm, a phone request, or the popup.
  await pollRemoteRefresh();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) return runSync("scheduled");
  if (alarm.name === REFRESH_ALARM_NAME) return pollRemoteRefresh();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_STATE") {
    getState().then(sendResponse);
    return true;
  }
  if (message?.type === "CONFIGURE") {
    (async () => {
      const { config: previous } = await getState();
      const intervalMinutes = [15, 30, 60].includes(Number(message.config?.intervalMinutes))
        ? Number(message.config.intervalMinutes)
        : DEFAULT_INTERVAL;
      const config = {
        ...previous,
        enabled: true,
        bridgeUrl: normalizedBridgeUrl(message.config?.bridgeUrl || DEFAULT_BRIDGE_URL),
        intervalMinutes,
        syncCode: String(message.config?.syncCode || "").trim()
      };
      await deriveSyncSecrets(config.syncCode);
      await chrome.storage.local.set({ config });
      await scheduleAlarms(config, true);
      const remote = await pollRemoteRefresh();
      const status = remote.handled ? (await getState()).syncStatus : await runSync("configured");
      sendResponse({ ok: true, config, status });
    })().catch((error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  }
  if (message?.type === "SYNC_NOW") {
    runSync("manual").then((status) => sendResponse({ ok: status.state !== "error", status }));
    return true;
  }
  if (message?.type === "DISCONNECT") {
    (async () => {
      const { config } = await getState();
      const next = { ...config, enabled: false, syncCode: "" };
      await chrome.storage.local.set({
        config: next,
        syncStatus: {
          state: "not-configured",
          message: "同期コードを設定してください。",
          updatedAt: new Date().toISOString()
        }
      });
      await chrome.alarms.clear(ALARM_NAME);
      await chrome.alarms.clear(REFRESH_ALARM_NAME);
      await chrome.storage.local.remove("remoteRefreshResult");
      // Forget (but never close) the sync tab; it is the user's to keep or close.
      await forgetDedicatedTab();
      sendResponse({ ok: true });
    })();
    return true;
  }
  return false;
});
