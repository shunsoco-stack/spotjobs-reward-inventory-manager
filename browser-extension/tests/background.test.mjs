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

async function loadBackground({ configOverrides = {}, collector, onConfigRead, onRunningAck } = {}) {
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
  const listeners = {};
  const alarms = new Map();
  const events = [];
  let collections = 0;
  let uploads = 0;
  let configReads = 0;
  const request = {
    requestId: "b17da59e-9928-4cf6-87f7-b7d76a446387",
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    status: "pending"
  };
  const event = (key) => ({ addListener(callback) { listeners[key] = callback; } });
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
    tabs: { onUpdated: event("tab"), async query() { return [{ id: 1, status: "complete" }]; } },
    scripting: {
      async executeScript(options) {
        assert.equal(options.world, "MAIN");
        collections += 1;
        events.push(`collect-${collections}`);
        if (collector) await collector(collections);
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
    assert.equal(snapshot.sourceVersion, "spotlog-edge/0.2.1");
    uploads += 1;
    events.push(`upload-${uploads}`);
    return json({ ok: true });
  };
  await import(`../background.js?test=${++importId}`);
  await new Promise((resolve) => setImmediate(resolve));
  return { data, alarms, listeners, events, collections: () => collections, uploads: () => uploads };
}

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
