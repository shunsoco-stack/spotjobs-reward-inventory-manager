import test from "node:test";
import assert from "node:assert/strict";
import { decryptSnapshot, deriveSyncSecrets, generateSyncCode } from "../lib/protocol.js";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const realDateNow = Date.now;
let clockOffset = 0;
let importId = 0;

const SENTINEL_TOKEN = "SENTINEL_TOKEN_DO_NOT_LEAK";
const SENTINEL_KEY = "firebase:authUser:SENTINEL_API_KEY_DO_NOT_LEAK:[DEFAULT]";
const SENTINELS = [SENTINEL_TOKEN, "SENTINEL_API_KEY_DO_NOT_LEAK", "SENTINEL_REFRESH_DO_NOT_LEAK"];
const SPOTJOBS_URL = "https://spotjobs-api.spotapi.jp/api/v1/rounder/work?taskStatus=FINISHED&pageNum=1&pageSize=50";
const USER_TAB_URL = "https://app.spot.jobs/user-job-list";
const MINUTE = 60 * 1000;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function waitUntil(condition) {
  const deadline = realDateNow() + 2_000;
  while (!condition()) {
    if (realDateNow() >= deadline) assert.fail("Expected asynchronous extension event did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function assertNoSentinel(label, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const sentinel of SENTINELS) {
    assert.ok(!text.includes(sentinel), `${label} must not contain credential material`);
  }
}

/** A fake app.spot.jobs page with Firebase persistence holding sentinel credentials. */
function fakePage({ auth, respond, onRequest }) {
  const expirationTime = auth === "expired" ? Date.now() - MINUTE : Date.now() + 60 * MINUTE;
  const rows = auth === "missing" ? [] : [{
    fbase_key: SENTINEL_KEY,
    value: {
      uid: "sentinel-uid",
      stsTokenManager: {
        accessToken: SENTINEL_TOKEN,
        refreshToken: "SENTINEL_REFRESH_DO_NOT_LEAK",
        expirationTime
      }
    }
  }];
  const indexedDB = {
    open() {
      const request = {};
      setTimeout(() => {
        request.result = {
          objectStoreNames: { contains: (name) => name === "firebaseLocalStorage" },
          transaction: () => ({
            objectStore: () => ({
              getAll() {
                const getRequest = {};
                setTimeout(() => {
                  getRequest.result = structuredClone(rows);
                  getRequest.onsuccess?.();
                }, 0);
                return getRequest;
              }
            })
          }),
          close() {}
        };
        request.onsuccess?.();
      }, 0);
      return request;
    }
  };
  return {
    indexedDB,
    localStorage: { length: 0, key: () => null, getItem: () => null },
    async fetch(input, init) {
      onRequest({ url: String(input), method: init.method, headers: { ...init.headers } });
      return respond();
    }
  };
}

async function loadBackground({
  configOverrides = {},
  beforeCollect,
  onConfigRead,
  onRunningAck,
  storedTab,
  // Session marker for the stored tab; defaults to matching it (same session).
  sessionTabId = storedTab?.tabId,
  sessionStorage = true,
  storedData = {},
  initialTabs = [{ id: 1, windowId: 10, url: USER_TAB_URL, status: "complete" }],
  windows = [{ id: 10, type: "normal", focused: true }],
  uploadStatus = 200,
  remotePending = true,
  auth = "valid",
  pageResponse = () => json({ data: { list: [{ rounderWorkId: "test-1", workType: "BATTERY_INSERT", endTime: "2026-11-15 10:00:00", score: 3, spotDetail: { spotName: "テスト店舗" } }] } })
} = {}) {
  const syncCode = generateSyncCode();
  const data = {
    config: {
      enabled: true,
      bridgeUrl: "https://spotjobs-reward-inventory-sync.vercel.app",
      intervalMinutes: 30,
      syncCode,
      ...configOverrides
    },
    ...storedData
  };
  if (storedTab) data.dedicatedSyncTab = storedTab;
  const sessionData = {};
  if (Number.isInteger(sessionTabId)) sessionData.dedicatedSyncTabSession = { tabId: sessionTabId };
  const listeners = {};
  const listenerSets = {};
  const alarms = new Map();
  const events = [];
  const tabCalls = [];
  const collectedTabIds = [];
  const storageWrites = [];
  const statusWrites = [];
  const bridgeRequests = [];
  const spotjobsRequests = [];
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
        async set(values) {
          storageWrites.push(structuredClone(values));
          if (values.syncStatus) statusWrites.push(structuredClone(values.syncStatus));
          Object.assign(data, values);
        },
        async remove(key) { delete data[key]; }
      },
      ...(sessionStorage ? {
        session: {
          async get(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            return structuredClone(Object.fromEntries(list.map((key) => [key, sessionData[key]])));
          },
          async set(values) { Object.assign(sessionData, structuredClone(values)); },
          async remove(key) { delete sessionData[key]; }
        }
      } : {})
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
      async query() { assert.fail("The extension must not query the user's tabs"); },
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
      async reload() { assert.fail("The extension must never reload a tab"); },
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
        assert.equal(options.func.name, "collectSpotJobsFromPage");
        assert.equal(options.args, undefined, "no URL or options are passed to the page");
        assert.notEqual(options.target.tabId, 1, "A user-opened tab must never be used");
        assert.equal(typeof data.lastSpotJobsRequestAt, "number", "request time is stored before collecting");
        collections += 1;
        collectedTabIds.push(options.target.tabId);
        events.push(`collect-${collections}`);
        await beforeCollect?.(collections);
        // Run the real serialized collector against a fake page.
        const page = fakePage({
          auth,
          respond: () => pageResponse(collections),
          onRequest: (entry) => spotjobsRequests.push(entry)
        });
        const previousWindow = globalThis.window;
        globalThis.window = page;
        try {
          const result = await options.func();
          return [{ result: structuredClone(result) }];
        } finally {
          globalThis.window = previousWindow;
        }
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
    assert.equal(url.origin, "https://spotjobs-reward-inventory-sync.vercel.app", "background only talks to the bridge");
    assert.equal(options.headers.Authorization, `Bearer ${secrets.authToken}`);
    bridgeRequests.push({ url: url.href, method: options.method, headers: { ...options.headers }, body: options.body ?? "" });
    if (url.pathname.includes("/refresh/")) {
      if (options.method === "GET") return remotePending ? json(request) : new Response(null, { status: 204 });
      const body = JSON.parse(options.body);
      Object.assign(request, body);
      events.push(`ack-${body.status}${body.errorCode ? `:${body.errorCode}` : ""}`);
      if (body.status === "running") await onRunningAck?.(data);
      if (body.status === "succeeded") assert.ok(uploads >= 1, "completion must follow snapshot upload");
      return json(request);
    }
    assert.ok(url.pathname.includes("/snapshot/"));
    if (options.method === "GET") return json({}, 404);
    const envelope = JSON.parse(options.body);
    const snapshot = await decryptSnapshot(envelope, secrets);
    assertNoSentinel("decrypted snapshot", snapshot);
    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.sourceVersion, "spotlog-edge/0.3.0");
    uploads += 1;
    events.push(`upload-${uploads}`);
    if (uploadStatus !== 200) return json({ error: "storage" }, uploadStatus);
    return json({ ok: true });
  };
  await import(`../background.js?test=${++importId}`);
  await new Promise((resolve) => setImmediate(resolve));
  const creates = () => tabCalls.filter((call) => call.create);
  const assertNoLeaks = () => {
    assertNoSentinel("storage writes", storageWrites);
    assertNoSentinel("status writes", statusWrites);
    assertNoSentinel("bridge requests", bridgeRequests);
    assertNoSentinel("final storage", data);
  };
  return {
    data, sessionData, alarms, listeners, listenerSets, events, tabs, tabCalls, collectedTabIds, creates, emitTabUpdated,
    storageWrites, statusWrites, bridgeRequests, spotjobsRequests, assertNoLeaks,
    collections: () => collections, uploads: () => uploads
  };
}

const sync = (h) => new Promise((resolve) => h.listeners.message({ type: "SYNC_NOW" }, {}, resolve));
const advance = (ms) => { clockOffset += ms; };

test.beforeEach(() => {
  clockOffset = 0;
  Date.now = () => realDateNow() + clockOffset;
});

test.afterEach(() => {
  Date.now = realDateNow;
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
});

test("remote alarm makes one SPOTJOBS GET, encrypts/uploads it, then completes the request", async () => {
  const h = await loadBackground();
  assert.equal(h.alarms.get("spotlog-periodic-sync").periodInMinutes, 30);
  assert.equal(h.alarms.get("spotlog-remote-refresh").periodInMinutes, 0.5);
  await h.listeners.alarm({ name: "spotlog-remote-refresh" });
  assert.deepEqual(h.events, ["ack-running", "collect-1", "upload-1", "ack-succeeded"]);
  assert.equal(h.data.syncStatus.trigger, "remote");
  assert.equal(h.data.syncStatus.state, "success");
  assert.equal(h.spotjobsRequests.length, 1);
  assert.equal(new URL(h.spotjobsRequests[0].url).href, SPOTJOBS_URL);
  assert.equal(h.spotjobsRequests[0].method, "GET");
  await h.listeners.alarm({ name: "spotlog-remote-refresh" });
  assert.equal(h.collections(), 1);
  h.assertNoLeaks();
});

test("the sentinel token never reaches storage, status, or bridge requests", async () => {
  const scenarios = [
    {},
    { pageResponse: () => json({}, 401) },
    { pageResponse: () => json({}, 500) },
    { pageResponse: () => { throw new TypeError(`boom ${SENTINEL_TOKEN} ${SENTINEL_KEY}`); } },
    { pageResponse: () => new Response(`not json ${SENTINEL_TOKEN}`) },
    { auth: "expired" },
    { auth: "missing" }
  ];
  for (const scenario of scenarios) {
    const h = await loadBackground(scenario);
    await h.listeners.alarm({ name: "spotlog-remote-refresh" });
    advance(2 * MINUTE);
    await sync(h);
    h.assertNoLeaks();
    assert.ok(h.statusWrites.length > 0);
  }
});

test("an expired SPOTJOBS login is reported to the phone as auth_required", async () => {
  const h = await loadBackground({ pageResponse: () => json({}, 401) });
  await h.listeners.alarm({ name: "spotlog-remote-refresh" });
  assert.deepEqual(h.events, ["ack-running", "collect-1", "ack-failed:auth_required"]);
  assert.equal(h.data.syncStatus.state, "auth-required");
  assert.equal(h.data.syncStatus.message, "SPOTJOBSのログインが切れています。PCのEdgeでSPOTJOBSにログインし直してください。");
  assert.equal(h.data.remoteRefreshResult.errorCode, "auth_required");
  assert.equal(h.uploads(), 0);
  assert.equal(h.spotjobsRequests.length, 1);
});

test("a missing auth record is auth-required without any SPOTJOBS request", async () => {
  const h = await loadBackground({ auth: "missing" });
  await h.listeners.alarm({ name: "spotlog-remote-refresh" });
  assert.equal(h.data.remoteRefreshResult.errorCode, "auth_required");
  assert.equal(h.spotjobsRequests.length, 0);
});

test("a stale token is a safe error without any SPOTJOBS request", async () => {
  const h = await loadBackground({ auth: "expired" });
  const response = await sync(h);
  assert.equal(response.status.state, "error");
  assert.equal(response.status.message, "SPOTJOBSのログイン情報を更新できませんでした。PCのEdgeでSPOTJOBSを開いたままにして、しばらくしてから再試行してください。");
  assert.equal(h.spotjobsRequests.length, 0);
  assert.equal(h.collections(), 1);
});

test("API and format errors use fixed messages, never raw text", async () => {
  const cases = [
    [() => json({}, 503), /（503）/u],
    [() => { throw new TypeError("raw network text"); }, /SPOTJOBSに接続できませんでした/u],
    [() => json({ unexpected: true }), /仕様が変わった/u]
  ];
  for (const [pageResponse, pattern] of cases) {
    const h = await loadBackground({ pageResponse });
    const response = await sync(h);
    assert.equal(response.status.state, "error");
    assert.match(response.status.message, pattern);
    assert.ok(!/SPOTLOG_|raw network/u.test(response.status.message));
  }
});

test("a collection failure is never retried in the same run", async () => {
  const h = await loadBackground({ pageResponse: () => json({}, 500) });
  const response = await sync(h);
  assert.equal(response.status.state, "error");
  assert.equal(h.collections(), 1);
  assert.equal(h.spotjobsRequests.length, 1);
  assert.equal(h.uploads(), 0);
});

test("a second sync within 60 seconds does not collect and returns the previous status", async () => {
  const h = await loadBackground();
  const first = await sync(h);
  assert.equal(first.status.state, "success");
  const writesBefore = h.statusWrites.length;
  advance(30_000);
  const second = await sync(h);
  assert.deepEqual(second.status, first.status);
  assert.equal(h.statusWrites.length, writesBefore, "status is left unchanged");
  assert.equal(h.collections(), 1);
  assert.equal(h.spotjobsRequests.length, 1);
  assert.equal(h.uploads(), 1);

  advance(31_000);
  const third = await sync(h);
  assert.equal(third.status.state, "success");
  assert.equal(h.collections(), 2);
  assert.equal(h.spotjobsRequests.length, 2);
});

test("a phone request waiting on a running sync reports that result within 60 seconds", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await loadBackground({ beforeCollect: async (count) => { if (count === 1) await gate; } });
  const regular = h.listeners.alarm({ name: "spotlog-periodic-sync" });
  await waitUntil(() => h.collections() === 1);
  const remote = h.listeners.alarm({ name: "spotlog-remote-refresh" });
  try {
    await waitUntil(() => h.events.includes("ack-running"));
    assert.ok(!h.events.includes("ack-succeeded"));
  } finally {
    release();
  }
  await Promise.all([regular, remote]);
  assert.equal(h.collections(), 1);
  assert.equal(h.uploads(), 1);
  assert.ok(h.events.indexOf("ack-succeeded") > h.events.indexOf("upload-1"));
});

test("a throttled phone request reports the previous failure state", async () => {
  const h = await loadBackground({ pageResponse: () => json({}, 401) });
  await sync(h);
  assert.equal(h.data.syncStatus.state, "auth-required");
  await h.listeners.alarm({ name: "spotlog-remote-refresh" });
  assert.equal(h.collections(), 1);
  assert.equal(h.data.remoteRefreshResult.errorCode, "auth_required");
});

test("a stored request time in the future does not block and is overwritten", async () => {
  const future = Date.now() + 10 * MINUTE;
  const h = await loadBackground({ storedData: { lastSpotJobsRequestAt: future } });
  await sync(h);
  assert.equal(h.collections(), 1);
  assert.ok(h.data.lastSpotJobsRequestAt < future);
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
  assert.deepEqual(h.sessionData.dedicatedSyncTabSession, { tabId });
  assert.ok(h.tabCalls.some((call) => call.update?.autoDiscardable === false && call.id === tabId));
  assert.ok(!h.tabCalls.some((call) => call === "get-1" || call.id === 1));
});

test("reuses the stored tab as-is, even when discarded or loading, without reloading", async () => {
  for (const state of [
    { status: "complete" },
    { status: "loading" },
    { status: "unloaded", discarded: true }
  ]) {
    const h = await loadBackground({
      storedTab: { tabId: 50, windowId: 10, openedAt: Date.now() - 600 * MINUTE },
      initialTabs: [
        { id: 1, windowId: 10, url: USER_TAB_URL, status: "complete" },
        { id: 50, windowId: 10, url: `${USER_TAB_URL}?tab=done`, ...state }
      ]
    });
    await sync(h);
    advance(2 * MINUTE);
    await sync(h);
    assert.equal(h.creates().length, 0);
    assert.deepEqual(h.collectedTabIds, [50, 50]);
  }
});

test("reopens the dedicated tab when the stored tab was closed or navigated away", async () => {
  const closed = await loadBackground({ storedTab: { tabId: 77, windowId: 10, openedAt: Date.now() } });
  await sync(closed);
  assert.equal(closed.creates().length, 1);
  assert.equal(closed.data.dedicatedSyncTab.tabId, closed.creates()[0].id);

  const moved = await loadBackground({
    storedTab: { tabId: 50, windowId: 10, openedAt: Date.now() },
    initialTabs: [{ id: 50, windowId: 10, url: "https://app.spot.jobs/home", status: "complete" }]
  });
  await sync(moved);
  assert.equal(moved.creates().length, 1);
  assert.ok(!moved.collectedTabIds.includes(50));
  assert.equal(moved.tabs.get(50).url, "https://app.spot.jobs/home");
});

test("after browser startup a previous-session tab id is never reused, even on a user-job-list tab", async () => {
  for (const sessionStorage of [false, true]) {
    // Tab 50 is now a user's own app.spot.jobs/user-job-list tab whose id
    // collides with the record left from the previous browser session.
    const h = await loadBackground({
      sessionStorage,
      remotePending: false,
      storedTab: { tabId: 50, windowId: 10, openedAt: Date.now() - 600 * MINUTE },
      initialTabs: [{ id: 50, windowId: 10, url: USER_TAB_URL, status: "complete" }]
    });
    await h.listeners.startup();
    assert.equal(h.data.dedicatedSyncTab, undefined, "startup forgets the stored record");
    assert.equal(h.tabCalls.length, 0, "startup touches no tab");
    await sync(h);
    assert.ok(!h.collectedTabIds.includes(50));
    assert.ok(!h.tabCalls.some((call) => call === "get-50" || call.id === 50));
    assert.equal(h.creates().length, 1);
    assert.equal(h.creates()[0].create.active, false);
    assert.deepEqual(h.collectedTabIds, [h.creates()[0].id]);
    assert.equal(h.tabs.get(50).url, USER_TAB_URL);
  }
});

test("a stored tab id without a matching session marker is not reused", async () => {
  for (const sessionTabId of [null, 51]) {
    const h = await loadBackground({
      sessionTabId,
      storedTab: { tabId: 50, windowId: 10, openedAt: Date.now() },
      initialTabs: [{ id: 50, windowId: 10, url: USER_TAB_URL, status: "complete" }]
    });
    await sync(h);
    assert.ok(!h.collectedTabIds.includes(50));
    assert.ok(!h.tabCalls.some((call) => call === "get-50" || call.id === 50));
    const creates = h.creates();
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0].create, { url: USER_TAB_URL, active: false, windowId: 10 });
    assert.equal(h.data.dedicatedSyncTab.tabId, creates[0].id);
    assert.deepEqual(h.sessionData.dedicatedSyncTabSession, { tabId: creates[0].id });
  }
});

test("without a normal window the sync reports page-required and opens nothing", async () => {
  const h = await loadBackground({ windows: [] });
  const response = await sync(h);
  assert.equal(response.status.state, "page-required");
  assert.equal(h.creates().length, 0);
  assert.equal(h.collections(), 0);
});

test("SPOTJOBS page loads never start a sync", async () => {
  const h = await loadBackground({
    storedTab: { tabId: 50, windowId: 10, openedAt: Date.now() },
    initialTabs: [
      { id: 1, windowId: 10, url: USER_TAB_URL, status: "complete" },
      { id: 50, windowId: 10, url: USER_TAB_URL, status: "complete" }
    ]
  });
  assert.equal(h.listenerSets.tab?.size ?? 0, 0, "no persistent tab listener");
  h.emitTabUpdated(1, { status: "complete" });
  h.emitTabUpdated(50, { status: "complete" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.collections(), 0);
  assert.equal(h.data.syncStatus, undefined);
});

test("browser startup reschedules alarms and polls the phone, but does not collect", async () => {
  const h = await loadBackground({ remotePending: false });
  h.alarms.clear();
  await h.listeners.startup();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(h.alarms.has("spotlog-periodic-sync"));
  assert.ok(h.alarms.has("spotlog-remote-refresh"));
  assert.ok(h.bridgeRequests.some((entry) => entry.url.includes("/refresh/") && entry.method === "GET"));
  assert.equal(h.collections(), 0);
  assert.equal(h.spotjobsRequests.length, 0);
});

test("bridge storage errors during upload never retry collection", async () => {
  const h = await loadBackground({
    storedTab: { tabId: 50, windowId: 10, openedAt: Date.now() },
    initialTabs: [{ id: 50, windowId: 10, url: USER_TAB_URL, status: "complete" }],
    uploadStatus: 500
  });
  const response = await sync(h);
  assert.equal(response.status.state, "error");
  assert.equal(h.creates().length, 0);
  assert.equal(h.collections(), 1);
  assert.equal(h.spotjobsRequests.length, 1);
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

test("disconnect forgets the dedicated sync tab without closing it", async () => {
  const h = await loadBackground();
  await sync(h);
  const tabId = h.data.dedicatedSyncTab.tabId;
  await new Promise((resolve) => h.listeners.message({ type: "DISCONNECT" }, {}, resolve));
  assert.equal(h.data.dedicatedSyncTab, undefined);
  assert.equal(h.sessionData.dedicatedSyncTabSession, undefined);
  assert.ok(h.tabs.has(tabId));
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
  assert.deepEqual(h.events, ["ack-running", "ack-failed:disabled"]);
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
