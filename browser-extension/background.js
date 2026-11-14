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

const ALARM_NAME = "spotlog-periodic-sync";
const DEFAULT_BRIDGE_URL = "https://spotjobs-reward-inventory-sync.vercel.app";
const DEFAULT_INTERVAL = 30;
const SPOTJOBS_URL = "https://app.spot.jobs/user-job-list*";
const SOURCE_VERSION = "spotlog-edge/0.1.0";
let runningSync = null;

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

async function scheduleAlarm(intervalMinutes) {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: Math.min(intervalMinutes, 1),
    periodInMinutes: intervalMinutes
  });
}

async function findSpotJobsTab() {
  const tabs = await chrome.tabs.query({ url: SPOTJOBS_URL });
  return tabs.find((tab) => tab.id && tab.status === "complete") || tabs[0] || null;
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
      cache: "no-store"
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
      body: JSON.stringify(envelope)
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

async function performSync(trigger = "scheduled") {
  const { config } = await getState();
  if (!config.enabled || !config.syncCode) {
    return setStatus("not-configured", "同期コードを設定してください。");
  }

  const bridgeUrl = normalizedBridgeUrl(config.bridgeUrl);
  await setStatus("syncing", "SPOTJOBSの完了履歴を確認しています…", { trigger });
  const tab = await findSpotJobsTab();
  if (!tab?.id) {
    const message = "SPOTJOBSのジョブ履歴をEdgeで開いてください。";
    const status = await setStatus("page-required", message);
    if (trigger === "manual") await maybeNotifyAuthRequired(message);
    return status;
  }

  try {
    // Always refresh the latest window and merge it with the encrypted remote
    // snapshot. A device-local "known ID" shortcut can lose records after a
    // remote expiry/delete, so correctness takes priority over a few requests.
    const collected = await collectFromTab(tab.id);
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
      const message = "SPOTJOBSへ再ログインし、ジョブ履歴を開いてください。";
      const status = await setStatus("auth-required", message, { trigger });
      await maybeNotifyAuthRequired(message);
      return status;
    }
    const message = rawMessage.includes("SPOTLOG_API_FORMAT_CHANGED")
      ? "SPOTJOBSの画面仕様が変わった可能性があります。拡張機能を更新してください。"
      : rawMessage.includes("SPOTLOG_API_CAPTURE_TIMEOUT")
        ? "SPOTJOBSの完了履歴を読み込めませんでした。履歴画面を開いたまま再実行してください。"
      : rawMessage.replace(/^Error:\s*/u, "");
    return setStatus("error", message, { trigger });
  }
}

function runSync(trigger) {
  if (!runningSync) {
    runningSync = performSync(trigger).finally(() => {
      runningSync = null;
    });
  }
  return runningSync;
}

chrome.runtime.onInstalled.addListener(async () => {
  const { config } = await getState();
  await chrome.storage.local.set({ config });
  await scheduleAlarm(config.intervalMinutes);
});

chrome.runtime.onStartup.addListener(async () => {
  const { config } = await getState();
  await scheduleAlarm(config.intervalMinutes);
  if (config.enabled) void runSync("startup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void runSync("scheduled");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url?.startsWith("https://app.spot.jobs/user-job-list")
  ) {
    void runSync("page-opened");
  }
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
      await scheduleAlarm(intervalMinutes);
      sendResponse({ ok: true, config, status: await runSync("configured") });
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
      sendResponse({ ok: true });
    })();
    return true;
  }
  return false;
});
