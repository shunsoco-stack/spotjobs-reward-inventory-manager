import test from "node:test";
import assert from "node:assert/strict";
import { decryptSnapshot, deriveSyncSecrets, generateSyncCode } from "../lib/protocol.js";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
let importId = 0;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function waitUntil(condition) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail("Expected asynchronous extension event did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const USER_TAB_URL = "https://app.spot.jobs/user-job-list";

async function loadBackground({
  configOverrides = {},
  collector,
  onConfigRead,
  onRunningAck,
  storedTab,
  initialTabs = [{ id: 1, windowId: 10, url: USER_TAB_URL, status: "complete" }],
  windows = [{ id: 10, type: "normal", focused: true }],
  uploadStatus = 200
} = {}) {
  const syncCode = generateSyncCode();
  const data = {
    config: {
      enabled: true,
      bridgeUrl: "https://spotjobs-reward-inventory-sync.vercel.app",
      intervalMinutes: 30,
      syncCode,
      ...configOverrides
    }
  };
  if (storedTab) data.dedicatedSyncTab = storedTab;
  const listeners = {};
  const listenerSets = {};
  const alarms = new Map();
  const events = [];
  const tabCalls = [];
  const collectedTabIds = [];
  const tabs = new Map(initialTabs.map((tab) => [tab.id, { ...tab }]));
  let nextTabId = 100;
  let collections = 0;
  let uploads = 0;
  let configReads = 0;
  const emitTabUpdated = (tabId, changeInfo) => {
    const tab = tabs.get(tabId);
    for (const callback of [...(listenerSets.tab || [])]) callback(tabId, changeInfo, { ...tab });
  };
  const finishLoading = (tabId) => setImmediate(() => {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.status = "complete";
    tab.url = tab.pendingUrl || tab.url;
    delete tab.pendingUrl;
    emitTabUpdated(tabId, { status: "complete" });
  });
  const request = {
    requestId: "b17da59e-9928-4cf6-87f7-b7d76a446387",
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    status: "pending"
  };
  const event = (key) => ({
    addListener(callback) {
      // The first registration is the background's top-level listener.
      listeners[key] ??= callback;
      (listenerSets[key] ??= new Set()).add(callback);
    },
    removeListener(callback) { listenerSets[key]?.delete(callback); }
  });
  const secrets = await deriveSyncSecrets(syncCode);
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const result = structuredClone(Object.fromEntries(list.map((key) => [key, data[key]])));
          if (list.includes("config")) await onConfigRead?.(++configReads, data);
          return result;
        },
        async set(values) { Object.assign(data, values); },
        async remove(key) { delete data[key]; }
      }
    },
    alarms: {
      onAlarm: event("alarm"),
      async get(name) { return alarms.get(name); },
      async clear(name) { return alarms.delete(name); },
      async create(name, alarm) { alarms.set(name, alarm); }
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    tabs: {
      onUpdated: event("tab"),
      async query() { assert.fail("The extension must not select tabs by URL query"); },
      async get(tabId) {
        tabCalls.push(`get-${tabId}`);
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return { ...tab };
      },
      async create(properties) {
        const id = nextTabId++;
        tabCalls.push({ create: { ...properties }, id });
        tabs.set(id, {
          id, windowId: properties.windowId, url: "", pendingUrl: properties.url,
          status: "loading", active: properties.active
        });
        finishLoading(id);
        return { ...tabs.get(id) };
      },
      async reload(tabId) {
        tabCalls.push(`reload-${tabId}`);
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        tab.status = "loading";
        tab.discarded = false;
        finishLoading(tabId);
      },
      async update(tabId, properties) {
        tabCalls.push({ update: { ...properties }, id: tabId });
        assert.deepEqual(Object.keys(properties), ["autoDiscardable"]);
        return { ...tabs.get(tabId) };
      },
      async remove() { assert.fail("The extension must never close tabs"); }
    },
    windows: {
      async getAll(filter) {
        assert.deepEqual(filter, { windowTypes: ["normal"] });
        return windows.map((win) => ({ ...win }));
      },
      async update() { assert.fail("The extension must never focus a window"); },
      async create() { assert.fail("The extension must never create a window"); }
    },
    scripting: {
      async executeScript(options) {
        assert.equal(options.world, "MAIN");
        assert.notEqual(options.target.tabId, 1, "A user-opened tab must never be used");
        collections += 1;
        collectedTabIds.push(options.target.tabId);
        events.push(`collect-${collections}`);
        const custom = collector ? await collector(collections) : undefined;
        if (custom?.error) return [{ result: { records: null, collectedAt: new Date().toISOString(), error: custom.error } }];
        return [{ result: {
          collectedAt: new Date().toISOString(),
          records: [{ rounderWorkId: `test-${collections}`, workType: "BATTERY_INSERT", endTime: "2026-11-15 10:00:00", score: 3, spotDetail: { spotName: "テスト店舗" } }]
        } }];
      }
    },
    notifications: { async create() {} },
    runtime: {
      onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message"),
      getURL: (path) => `chrome-extension://test/${path}`
    }
  };
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    assert.equal(options.headers.Authorization, `Bearer ${secrets.authToken}`);
    if (url.pathname.includes("/refresh/")) {
      if (options.method === "GET") return json(request);
      const body = JSON.parse(options.body);
      Object.assign(request, body);
      events.push(`ack-${body.status}`);
      if (body.status === "running") await onRunningAck?.(data);
      if (body.status === "succeeded") assert.ok(uploads >= 1, "completion must follow snapshot upload");
      return json(request);
    }
    assert.ok(url.pathname.includes("/snapshot/"));
    if (options.method === "GET") return json({}, 404);
    const envelope = JSON.parse(options.body);
    const snapshot = await decryptSnapshot(envelope, secrets);
    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.sourceVersion, "spotlog-edge/0.2.2");
    uploads += 1;
    events.push(`upload-${uploads}`);
    if (uploadStatus !== 200) return json({ error: "storage" }, uploadStatus);
    return json({ ok: true });
  };
  await import(`../background.js?test=${++importId}`);
  await new Promise((resolve) => setImmediate(resolve));
  const creates = () => tabCalls.filter((call) => call.create);
  const reloads = () => tabCalls.filter((call) => typeof call === "string" && call.startsWith("reload-"));
  return {
    data, alarms, listeners, events, tabs, tabCalls, collectedTabIds, creates, reloads, emitTabUpdated,
    collections: () => collections, uploads: () => uploads
  };
}

const sync = (h) => new Promise((resolve) => h.listeners.message({ type: "SYNC_NOW" }, {}, resolve));
const MINUTE = 60 * 1000;

test.afterEach(() => {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});

test("remote alarm retrieves official data, encrypts/uploads it, then completes the request", async () => {
  const h = await loadBackground();
  assert.equal(h.alarms.get("spotlog-periodic-sync").periodInMinutes, 30);
  assert.equal(h.alarms.get("spotlog-remote-refresh").periodInMinutes, 0.5);
  await h.listeners.alarm({ name: "spotlog-remote-refresh" });
  assert.deepEqual(h.events, ["ack-running", "collect-1", "upload-1", "ack-succeeded"]);
  assert.equal(h.data.syncStatus.trigger, "remote");
  assert.equal(h.data.syncStatus.state, "success");
  await h.listeners.alarm({ name: "spotlog-remote-refresh" });
  assert.equal(h.collections(), 1);
});

test("a phone request waits for an older sync and performs a fresh collection before acknowledgement", async () => {
  let release;
  const collected = new Promise((resolve) => { release = resolve; });
  const h = await loadBackground({ collector: async (count) => { if (count === 1) await collected; } });
  const regular = h.listeners.alarm({ name: "spotlog-periodic-sync" });
  await waitUntil(() => h.collections() === 1);
  const remote = h.listeners.alarm({ name: "spotlog-remote-refresh" });
  try {
    await waitUntil(() => h.events.includes("ack-running"));
    assert.equal(h.collections(), 1);
    assert.ok(!h.events.includes("ack-succeeded"));
  } finally {
    release();
  }
  await Promise.all([regular, remote]);
  assert.equal(h.collections(), 2);
  assert.equal(h.uploads(), 2);
  assert.ok(h.events.indexOf("ack-succeeded") > h.events.indexOf("upload-2"));
});

test("disconnect clears both alarms and local acknowledgement retry state", async () => {
  const h = await loadBackground();
  await h.listeners.alarm({ name: "spotlog-remote-refresh" });
  assert.ok(h.data.remoteRefreshResult);
  await new Promise((resolve) => h.listeners.message({ type: "DISCONNECT" }, {}, resolve));
  assert.equal(h.data.config.enabled, false);
  assert.equal(h.data.config.syncCode, "");
  assert.equal(h.data.remoteRefreshResult, undefined);
  assert.equal(h.alarms.size, 0);
  await h.listeners.alarm({ name: "spotlog-remote-refresh" });
  assert.equal(h.collections(), 1);
});

test("a channel changed before collection is reported disabled, never uploaded or acknowledged successful", async () => {
  const h = await loadBackground({
    onRunningAck: async (data) => {
      data.config = { ...data.config, syncCode: generateSyncCode() };
    }
  });
  await h.listeners.alarm({ name: "spotlog-remote-refresh" });
  assert.equal(h.collections(), 0);
  assert.equal(h.uploads(), 0);
  assert.deepEqual(h.events, ["ack-running", "ack-failed"]);
  assert.equal(h.data.remoteRefreshResult.errorCode, "disabled");
});

test("configuration read races cannot upload a phone request to another channel", async () => {
  const h = await loadBackground({
    onConfigRead: async (read, data) => {
      // The storage read returns its original snapshot, then a concurrent
      // settings write replaces the live configuration before its continuation.
      if (read === 3) data.config = { ...data.config, syncCode: generateSyncCode() };
    }
  });
  await h.listeners.alarm({ name: "spotlog-remote-refresh" });
  // The fetch mock also asserts that every request uses the original channel's
  // token. A second unbound configuration read would use the wrong token.
  assert.deepEqual(h.events, ["ack-running", "collect-1", "upload-1", "ack-succeeded"]);
  assert.equal(h.data.remoteRefreshResult.status, "succeeded");
});

test("disconnect forgets the dedicated sync tab without closing it", async () => {
  const h = await loadBackground();
  await sync(h);
  const tabId = h.data.dedicatedSyncTab.tabId;
  await new Promise((resolve) => h.listeners.message({ type: "DISCONNECT" }, {}, resolve));
  assert.equal(h.data.dedicatedSyncTab, undefined);
  assert.ok(h.tabs.has(tabId));
});

test("opens a background dedicated tab when none is stored and never uses the user's tab", async () => {
  const h = await loadBackground();
  const response = await sync(h);
  assert.equal(response.status.state, "success");
  const creates = h.creates();
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].create, { url: USER_TAB_URL, active: false, windowId: 10 });
  const tabId = creates[0].id;
  assert.deepEqual(h.collectedTabIds, [tabId]);
  assert.equal(h.data.dedicatedSyncTab.tabId, tabId);
  assert.equal(h.data.dedicatedSyncTab.windowId, 10);
  assert.equal(typeof h.data.dedicatedSyncTab.loadedAt, "number");
  assert.ok(h.tabCalls.some((call) => call.update?.autoDiscardable === false && call.id === tabId));
  assert.equal(h.reloads().length, 0);
  // The user's own tab is never read, reloaded, or updated.
  assert.ok(!h.tabCalls.some((call) => call === "get-1" || call === "reload-1" || call.id === 1));
});

test("reuses a fresh stored tab without reloading", async () => {
  const h = await loadBackground({
    storedTab: { tabId: 50, windowId: 10, loadedAt: Date.now() - 10 * MINUTE },
    initialTabs: [
      { id: 1, windowId: 10, url: USER_TAB_URL, status: "complete" },
      { id: 50, windowId: 10, url: `${USER_TAB_URL}?tab=done`, status: "complete" }
    ]
  });
  await sync(h);
  await sync(h);
  assert.equal(h.creates().length, 0);
  assert.equal(h.reloads().length, 0);
  assert.deepEqual(h.collectedTabIds, [50, 50]);
  assert.equal(h.data.syncStatus.state, "success");
});

test("reloads the stored tab once when it is older than 90 minutes", async () => {
  const loadedAt = Date.now() - 91 * MINUTE;
  const h = await loadBackground({
    storedTab: { tabId: 50, windowId: 10, loadedAt },
    initialTabs: [{ id: 50, windowId: 10, url: USER_TAB_URL, status: "complete" }]
  });
  await sync(h);
  assert.deepEqual(h.reloads(), ["reload-50"]);
  assert.equal(h.creates().length, 0);
  assert.deepEqual(h.collectedTabIds, [50]);
  assert.ok(h.data.dedicatedSyncTab.loadedAt > loadedAt);
  await sync(h);
  assert.equal(h.reloads().length, 1, "a refreshed tab is not reloaded again");
});

test("reloads a discarded stored tab before collecting", async () => {
  const h = await loadBackground({
    storedTab: { tabId: 50, windowId: 10, loadedAt: Date.now() },
    initialTabs: [{ id: 50, windowId: 10, url: USER_TAB_URL, status: "unloaded", discarded: true }]
  });
  await sync(h);
  assert.deepEqual(h.reloads(), ["reload-50"]);
  assert.equal(h.collections(), 1);
  assert.equal(h.data.syncStatus.state, "success");
});

test("a capture timeout reloads once and retries once, then succeeds", async () => {
  const h = await loadBackground({
    storedTab: { tabId: 50, windowId: 10, loadedAt: Date.now() - 30 * MINUTE },
    initialTabs: [{ id: 50, windowId: 10, url: USER_TAB_URL, status: "complete" }],
    collector: (count) => (count === 1 ? { error: "SPOTLOG_API_CAPTURE_TIMEOUT" } : undefined)
  });
  const response = await sync(h);
  assert.equal(response.status.state, "success");
  assert.deepEqual(h.reloads(), ["reload-50"]);
  assert.equal(h.collections(), 2);
  assert.equal(h.uploads(), 1);
  assert.equal(h.creates().length, 0);
});

test("a second collection failure after reload is reported without another reload", async () => {
  const h = await loadBackground({
    storedTab: { tabId: 50, windowId: 10, loadedAt: Date.now() - 30 * MINUTE },
    initialTabs: [{ id: 50, windowId: 10, url: USER_TAB_URL, status: "complete" }],
    collector: () => ({ error: "SPOTLOG_API_CAPTURE_TIMEOUT" })
  });
  const response = await sync(h);
  assert.equal(response.status.state, "error");
  assert.equal(h.reloads().length, 1);
  assert.equal(h.collections(), 2);
  assert.equal(h.uploads(), 0);
});

test("a failure on a freshly opened tab is not retried", async () => {
  const h = await loadBackground({ collector: () => ({ error: "SPOTLOG_AUTH_REQUIRED" }) });
  const response = await sync(h);
  assert.equal(response.status.state, "auth-required");
  assert.equal(h.creates().length, 1);
  assert.equal(h.reloads().length, 0);
  assert.equal(h.collections(), 1);
});

test("reopens the dedicated tab when the stored tab was closed or navigated away", async () => {
  const closed = await loadBackground({ storedTab: { tabId: 77, windowId: 10, loadedAt: Date.now() } });
  await sync(closed);
  assert.equal(closed.creates().length, 1);
  assert.equal(closed.reloads().length, 0);
  assert.equal(closed.data.dedicatedSyncTab.tabId, closed.creates()[0].id);

  const moved = await loadBackground({
    storedTab: { tabId: 50, windowId: 10, loadedAt: Date.now() },
    initialTabs: [{ id: 50, windowId: 10, url: "https://app.spot.jobs/home", status: "complete" }]
  });
  await sync(moved);
  assert.equal(moved.creates().length, 1);
  assert.equal(moved.reloads().length, 0);
  assert.ok(!moved.collectedTabIds.includes(50));
  assert.equal(moved.tabs.get(50).url, "https://app.spot.jobs/home");
});

test("without a normal window the sync reports page-required and opens nothing", async () => {
  const h = await loadBackground({ windows: [] });
  const response = await sync(h);
  assert.equal(response.status.state, "page-required");
  assert.equal(h.creates().length, 0);
  assert.equal(h.collections(), 0);
});

test("load events of the dedicated tab do not start a sync; other history tabs do", async () => {
  const h = await loadBackground({
    storedTab: { tabId: 50, windowId: 10, loadedAt: Date.now() },
    initialTabs: [
      { id: 1, windowId: 10, url: USER_TAB_URL, status: "complete" },
      { id: 50, windowId: 10, url: USER_TAB_URL, status: "complete" }
    ]
  });
  h.emitTabUpdated(50, { status: "complete" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.collections(), 0);

  h.emitTabUpdated(1, { status: "complete" });
  await waitUntil(() => h.data.syncStatus?.state === "success");
  assert.equal(h.data.syncStatus.trigger, "page-opened");
  assert.deepEqual(h.collectedTabIds, [50]);
});

test("bridge storage errors during upload never reload the tab or retry collection", async () => {
  const h = await loadBackground({
    storedTab: { tabId: 50, windowId: 10, loadedAt: Date.now() - 30 * MINUTE },
    initialTabs: [{ id: 50, windowId: 10, url: USER_TAB_URL, status: "complete" }],
    uploadStatus: 500
  });
  const response = await sync(h);
  assert.equal(response.status.state, "error");
  assert.equal(h.reloads().length, 0);
  assert.equal(h.creates().length, 0);
  assert.equal(h.collections(), 1);
});
