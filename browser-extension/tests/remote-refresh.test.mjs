import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteRefreshPoller } from "../lib/remote-refresh.js";

const NOW = Date.parse("2026-11-15T10:00:00Z");
const REQUEST_ID = "b17da59e-9928-4cf6-87f7-b7d76a446387";
const COMMAND = {
  requestId: REQUEST_ID,
  requestedAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 120_000).toISOString(),
  status: "pending"
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function harness(overrides = {}) {
  const data = {};
  const calls = [];
  let collects = 0;
  let command = { ...COMMAND };
  const dependencies = {
    getConfig: async () => ({ enabled: true, syncCode: "test-only", bridgeUrl: "https://bridge.invalid" }),
    deriveSecrets: async () => ({ channelId: "test-channel", authToken: "test-token" }),
    normalizeBridgeUrl: (value) => value,
    storage: {
      async get(key) { return { [key]: data[key] }; },
      async set(values) { Object.assign(data, values); }
    },
    async synchronize() { collects += 1; return { state: "success" }; },
    async fetchImpl(url, options) {
      assert.equal(url, "https://bridge.invalid/api/v1/refresh/test-channel");
      assert.equal(options.headers.Authorization, "Bearer test-token");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ method: options.method, body });
      if (options.method === "GET") return json(command);
      command = { ...command, ...body };
      return json(command);
    },
    ...overrides
  };
  return {
    dependencies,
    poll: createRemoteRefreshPoller(dependencies),
    calls,
    data,
    collects: () => collects,
    command: (value) => { command = value; }
  };
}

test("acknowledges running then success only after collection/upload completes", async () => {
  let release;
  const finished = new Promise((resolve) => { release = resolve; });
  const h = harness({ synchronize: async () => { await finished; return { state: "success" }; } });
  const pending = h.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls.map((call) => call.body?.status).filter(Boolean), ["running"]);
  release();
  assert.deepEqual(await pending, { handled: true });
  assert.deepEqual(h.calls.map((call) => call.body?.status).filter(Boolean), ["running", "succeeded"]);
  assert.equal(h.data.remoteRefreshResult.status, "succeeded");
  await h.poll();
  assert.equal(h.calls.filter((call) => call.method === "PUT").length, 2);
});

test("overlapping alarm ticks share the same in-flight poll", async () => {
  let release;
  const h = harness({ synchronize: () => new Promise((resolve) => { release = resolve; }) });
  const first = h.poll();
  const second = h.poll();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  release({ state: "success" });
  await Promise.all([first, second]);
  assert.equal(h.calls.filter((call) => call.method === "GET").length, 1);
});

test("a failed success acknowledgement retries after worker restart without another collection", async () => {
  const h = harness();
  const normalFetch = h.dependencies.fetchImpl;
  let failedOnce = false;
  h.dependencies.fetchImpl = async (url, options) => {
    if (options.body && JSON.parse(options.body).status === "succeeded" && !failedOnce) {
      failedOnce = true;
      return json({}, 503);
    }
    return normalFetch(url, options);
  };
  const poll = createRemoteRefreshPoller(h.dependencies);
  assert.deepEqual(await poll(), { handled: false });
  assert.equal(h.collects(), 1);
  assert.equal(h.data.remoteRefreshResult.status, "succeeded");
  const restartedPoll = createRemoteRefreshPoller(h.dependencies);
  assert.deepEqual(await restartedPoll(), { handled: true });
  assert.equal(h.collects(), 1);
  assert.equal(h.calls.at(-1).body.status, "succeeded");
});

test("malformed, absent and already completed requests do not fetch official history", async () => {
  for (const command of [
    { ...COMMAND, expiresAt: new Date(NOW).toISOString() },
    { ...COMMAND, requestId: "../other-channel" },
    { ...COMMAND, status: "succeeded" },
    { ...COMMAND, status: "failed", errorCode: "auth_required" },
    null
  ]) {
    const h = harness();
    h.command(command);
    await h.poll();
    assert.equal(h.collects(), 0);
    assert.equal(h.calls.length, 1);
  }
  const h = harness({ fetchImpl: async () => new Response(null, { status: 204 }) });
  await h.poll();
  assert.equal(h.collects(), 0);
});

test("disabled extensions do not poll the bridge", async () => {
  const h = harness({ getConfig: async () => ({ enabled: false }) });
  await h.poll();
  assert.equal(h.calls.length, 0);
});

test("auth, missing page, disabled and generic failures use safe status codes", async () => {
  for (const [state, errorCode] of [
    ["auth-required", "auth_required"],
    ["page-required", "page_required"],
    ["not-configured", "disabled"],
    ["error", "sync_failed"]
  ]) {
    const h = harness({ synchronize: async () => ({ state, message: "private upstream error" }) });
    await h.poll();
    assert.deepEqual(h.calls.at(-1).body, { requestId: REQUEST_ID, status: "failed", errorCode });
    assert.doesNotMatch(JSON.stringify(h.calls), /private upstream/u);
  }
  const h = harness({ synchronize: async () => { throw new Error("private response"); } });
  await h.poll();
  assert.equal(h.calls.at(-1).body.errorCode, "sync_failed");
  assert.doesNotMatch(JSON.stringify(h.calls), /private response/u);
});

test("failed running acknowledgement or expiry race does not begin a collection", async () => {
  for (const status of [401, 403, 410, 503]) {
    const h = harness({
      fetchImpl: async (_url, options) => options.method === "GET" ? json(COMMAND) : json({}, status)
    });
    await h.poll();
    assert.equal(h.collects(), 0);
    assert.equal(h.data.remoteRefreshResult, undefined);
  }
});

test("uses server expiry decisions even when the PC wall clock is ahead or behind", async () => {
  for (const year of [2000, 2100]) {
    const requestedAt = Date.parse(`${year}-01-01T00:00:00Z`);
    const h = harness();
    h.command({
      ...COMMAND,
      requestedAt: new Date(requestedAt).toISOString(),
      expiresAt: new Date(requestedAt + 120_000).toISOString()
    });
    await h.poll();
    assert.equal(h.collects(), 1);
    assert.equal(h.calls.at(-1).body.status, "succeeded");
  }
});

test("a running request resumes collection after a worker was suspended before completion", async () => {
  const h = harness();
  h.command({ ...COMMAND, status: "running" });
  await h.poll();
  assert.equal(h.collects(), 1);
  assert.equal(h.calls.at(-1).body.status, "succeeded");
});
