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
const SOURCE_VERSION = "spotlog-edge/0.2.2";
const DEDICATED_TAB_KEY = "dedicatedSyncTab";
const TAB_MAX_AGE_MS = 90 * 60 * 1000;
const TAB_LOAD_TIMEOUT_MS = 30_000;
let runningSync = null;
let dedicatedTabId = null;

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

async function readDedicatedTab() {
  const stored = await chrome.storage.local.get(DEDICATED_TAB_KEY);
  const record = stored?.[DEDICATED_TAB_KEY];
  return record && Number.isInteger(record.tabId) ? record : null;
}

async function forgetDedicatedTab() {
  dedicatedTabId = null;
  await chrome.storage.local.remove(DEDICATED_TAB_KEY);
}

async function rememberDedicatedTab(tabId, windowId) {
  dedicatedTabId = tabId;
  const record = { tabId, loadedAt: Date.now() };
  if (Number.isInteger(windowId)) record.windowId = windowId;
  await chrome.storage.local.set({ [DEDICATED_TAB_KEY]: record });
}

/**
 * Resolves true once the tab reports status "complete" (false on timeout or a
 * closed tab). Register before triggering a navigation so its completion event
 * cannot be missed. With acceptCurrent, an already-complete tab also counts.
 */
function watchTabLoad(tabId, { acceptCurrent = false } = {}) {
  let finish;
  const promise = new Promise((resolve) => {
    let done = false;
    let timer;
    const listener = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo?.status === "complete") finish(true);
    };
    finish = (loaded) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(loaded);
    };
    timer = setTimeout(() => finish(false), TAB_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
    if (acceptCurrent) {
      chrome.tabs.get(tabId).then(
        (tab) => { if (tab?.status === "complete") finish(true); },
        () => finish(false)
      );
    }
  });
  return { promise, cancel: () => finish(false) };
}

async function reloadDedicatedTab(tabId, windowId) {
  const load = watchTabLoad(tabId);
  try {
    await chrome.tabs.reload(tabId);
  } catch (error) {
    load.cancel();
    throw error;
  }
  await rememberDedicatedTab(tabId, windowId);
  await load.promise;
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
    // Best effort only; a discarded tab is reloaded before the next collection.
  }
  await watchTabLoad(tab.id, { acceptCurrent: true }).promise;
  return { tabId: tab.id, windowId: tab.windowId, refreshed: true };
}

/**
 * Returns the extension-owned sync tab, opening or reloading it at most once.
 * Tabs the user opened are never selected, reloaded, or otherwise touched.
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
      dedicatedTabId = tab.id;
      const age = Date.now() - Number(stored.loadedAt || 0);
      const stale = !(age >= 0 && age < TAB_MAX_AGE_MS);
      if (stale || tab.discarded || tab.status !== "complete") {
        await reloadDedicatedTab(tab.id, tab.windowId ?? stored.windowId);
        return { tabId: tab.id, windowId: tab.windowId, refreshed: true };
      }
      return { tabId: tab.id, windowId: tab.windowId, refreshed: false };
    }
    // Closed, or navigated away by the user: forget it without touching it.
    await forgetDedicatedTab();
  }
  return openDedicatedTab();
}

async function collectWithRecovery(prepared) {
  try {
    return await collectFromTab(prepared.tabId);
  } catch (error) {
    // A freshly opened/reloaded tab is not retried: at most one open-or-reload
    // and two collection attempts per sync run.
    if (prepared.refreshed) throw error;
    await reloadDedicatedTab(prepared.tabId, prepared.windowId);
    return collectFromTab(prepared.tabId);
  }
}

async function collectFromTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: collectSpotJobsFromPage,
    args: [{ pageSize: 50, maxRecords: 500 }]
  });
  const result = results?.[0]?.result;
  if (result?.error) throw new Error(result.error);
  if (!result || !Array.isArray(result.records)) {
    throw new Error("SPOTJOBSの履歴を読み取れませんでした。");
  }
  return result;
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
  const { config } = await getState();
  // A phone request is tied to the channel it arrived on. A configuration
  // change during an awaited read must never upload to a new channel and then
  // acknowledge the old request as successful.
  if (expectedConfig && (!config.enabled || config.syncCode !== expectedConfig.syncCode ||
    config.bridgeUrl !== expectedConfig.bridgeUrl)) return { state: "not-configured" };
  if (!config.enabled || !config.syncCode) {
    return setStatus("not-configured", "同期コードを設定してください。");
  }

  const bridgeUrl = normalizedBridgeUrl(config.bridgeUrl);
  await setStatus("syncing", "SPOTJOBSの完了履歴を確認しています…", { trigger });
  try {
    const prepared = await prepareDedicatedTab();
    if (!prepared) {
      const message = "同期用タブを開けませんでした。Edgeのウィンドウを開いてください。";
      const status = await setStatus("page-required", message);
      if (trigger === "manual") await maybeNotifyAuthRequired(message);
      return status;
    }

    // Always refresh the latest window and merge it with the encrypted remote
    // snapshot. A device-local "known ID" shortcut can lose records after a
    // remote expiry/delete, so correctness takes priority over a few requests.
    // Only collection failures may reload the sync tab; bridge errors below
    // never cause additional SPOTJOBS access.
    const collected = await collectWithRecovery(prepared);
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
    const rawMessage = error instanceof Error ? error.message : String(error);
    if (rawMessage.includes("SPOTLOG_AUTH_REQUIRED")) {
      const message = "EdgeでSPOTJOBSへ再ログインしてください。";
      const status = await setStatus("auth-required", message, { trigger });
      await maybeNotifyAuthRequired(message);
      return status;
    }
    const message = rawMessage.includes("SPOTLOG_API_FORMAT_CHANGED")
      ? "SPOTJOBSの画面仕様が変わった可能性があります。拡張機能を更新してください。"
      : rawMessage.includes("SPOTLOG_API_CAPTURE_TIMEOUT")
        ? "SPOTJOBSの完了履歴を読み込めませんでした。しばらくしてから再実行してください。"
      : rawMessage.replace(/^Error:\s*/u, "");
    return setStatus("error", message, { trigger });
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
    // requested it. Wait, then collect again instead of reporting old data.
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
  const { config } = await getState();
  await scheduleAlarms(config, true);
  const result = await pollRemoteRefresh();
  if (config.enabled && !result.handled) void runSync("startup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) return runSync("scheduled");
  if (alarm.name === REFRESH_ALARM_NAME) return pollRemoteRefresh();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !isSpotJobsListUrl(tab?.url)) return;
  // Loads of the extension-owned sync tab are driven by the sync run itself.
  if (tabId === dedicatedTabId) return;
  void (async () => {
    const stored = await readDedicatedTab().catch(() => null);
    if (stored?.tabId === tabId) return;
    await runSync("page-opened");
  })();
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
