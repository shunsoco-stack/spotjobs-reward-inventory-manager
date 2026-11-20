import test from "node:test";
import assert from "node:assert/strict";
import { collectSpotJobsFromPage } from "../lib/page-collector.js";

const SENTINEL_TOKEN = "SENTINEL_TOKEN_DO_NOT_LEAK";
const SENTINEL_KEY = "firebase:authUser:SENTINEL_API_KEY_DO_NOT_LEAK:[DEFAULT]";
const SENTINEL_REFRESH = "SENTINEL_REFRESH_DO_NOT_LEAK";
const SENTINELS = [SENTINEL_TOKEN, "SENTINEL_API_KEY_DO_NOT_LEAK", SENTINEL_REFRESH];
const EXPECTED_URL = "https://spotjobs-api.spotapi.jp/api/v1/rounder/work?taskStatus=FINISHED&pageNum=1&pageSize=50";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace", "dir", "table"];
const originalConsole = Object.fromEntries(CONSOLE_METHODS.map((name) => [name, console[name]]));

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function authUser({ expiresInMs = 30 * 60 * 1000, accessToken = SENTINEL_TOKEN } = {}) {
  return {
    uid: "sentinel-uid",
    email: "sentinel@example.invalid",
    stsTokenManager: {
      accessToken,
      refreshToken: SENTINEL_REFRESH,
      expirationTime: Date.now() + expiresInMs
    }
  };
}

/** Minimal asynchronous IndexedDB fake. `databases` maps db name -> store name -> rows. */
function fakeIndexedDb(databases) {
  const opened = [];
  return {
    opened,
    open(name) {
      opened.push(name);
      const request = {};
      setTimeout(() => {
        const stores = databases[name];
        if (!stores) {
          request.transaction = { abort() { request.aborted = true; } };
          request.onupgradeneeded?.({});
          return;
        }
        request.result = {
          objectStoreNames: { contains: (storeName) => Object.hasOwn(stores, storeName) },
          transaction(storeName, mode) {
            assert.equal(mode, "readonly");
            return {
              objectStore() {
                return {
                  getAll() {
                    const getRequest = {};
                    setTimeout(() => {
                      getRequest.result = structuredClone(stores[storeName]);
                      getRequest.onsuccess?.();
                    }, 0);
                    return getRequest;
                  },
                  put() { assert.fail("The collector must never write the auth store"); },
                  delete() { assert.fail("The collector must never write the auth store"); }
                };
              }
            };
          },
          close() {}
        };
        request.onsuccess?.();
      }, 0);
      return request;
    },
    deleteDatabase() { assert.fail("The collector must never delete databases"); }
  };
}

function fakeLocalStorage(entries) {
  const keys = Object.keys(entries);
  return {
    get length() { return keys.length; },
    key: (index) => keys[index] ?? null,
    getItem: (key) => (Object.hasOwn(entries, key) ? entries[key] : null),
    setItem() { assert.fail("The collector must never write localStorage"); },
    removeItem() { assert.fail("The collector must never write localStorage"); }
  };
}

function installPage({
  respond = () => jsonResponse({ data: { list: [{ rounderWorkId: "w-1" }] } }),
  idbRows = [{ fbase_key: SENTINEL_KEY, value: authUser() }],
  localStorageEntries = {},
  withIndexedDb = true
} = {}) {
  const calls = [];
  const consoleCalls = [];
  for (const name of CONSOLE_METHODS) {
    console[name] = (...args) => { consoleCalls.push(args); };
  }
  globalThis.fetch = () => assert.fail("Only the page's own fetch may be used");
  const databases = idbRows ? { firebaseLocalStorageDb: { firebaseLocalStorage: idbRows } } : {};
  const indexedDB = withIndexedDb ? fakeIndexedDb(databases) : undefined;
  const page = {
    indexedDB,
    localStorage: fakeLocalStorage(localStorageEntries),
    async fetch(input, init) {
      calls.push({ input, init, headers: { ...init?.headers } });
      return respond(input, init);
    },
    get document() { assert.fail("The collector must not touch the DOM"); },
    get navigator() { assert.fail("The collector must not access navigator/geolocation"); },
    XMLHttpRequest: class { constructor() { assert.fail("No XHR"); } }
  };
  globalThis.window = page;
  return { page, calls, consoleCalls, indexedDB };
}

function assertNoLeak(value, consoleCalls) {
  const serialized = JSON.stringify(value);
  for (const sentinel of SENTINELS) {
    assert.ok(!serialized.includes(sentinel), "result must not contain credential material");
  }
  const logged = consoleCalls.map((args) => args.map(String).join(" ")).join("\n");
  for (const sentinel of SENTINELS) {
    assert.ok(!logged.includes(sentinel), "console must not receive credential material");
  }
}

test.afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
  for (const name of CONSOLE_METHODS) console[name] = originalConsole[name];
});

test("makes exactly one GET to the single allowlisted endpoint with the page token", async () => {
  const { calls, consoleCalls } = installPage();
  const result = await collectSpotJobsFromPage();

  assert.equal(result.error, undefined);
  assert.deepEqual(result.records, [{ rounderWorkId: "w-1" }]);
  assert.deepEqual(Object.keys(result).sort(), ["collectedAt", "records"]);
  assert.equal(calls.length, 1);
  const [{ input, init, headers }] = calls;
  const url = new URL(input);
  const expected = new URL(EXPECTED_URL);
  assert.equal(url.origin, expected.origin);
  assert.equal(url.pathname, expected.pathname);
  assert.deepEqual([...url.searchParams], [...expected.searchParams]);
  assert.equal(url.href, expected.href);
  assert.equal(init.method, "GET");
  assert.equal(init.credentials, "omit");
  assert.equal(init.redirect, "error");
  assert.equal(init.cache, "no-store");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.body, undefined);
  assert.deepEqual(Object.keys(headers).sort(), ["Accept", "Authorization"]);
  assert.equal(headers.Accept, "application/json");
  assert.ok(headers.Authorization === `Bearer ${SENTINEL_TOKEN}`, "uses the page's ID token");
  assertNoLeak(result, consoleCalls);
});

test("ignores any URL, host, or query passed in options", async () => {
  const { calls } = installPage();
  const result = await collectSpotJobsFromPage({
    url: "https://evil.example/api/v1/rounder/work",
    origin: "https://evil.example",
    host: "evil.example",
    hostname: "evil.example",
    path: "/api/v1/other",
    pageSize: 500,
    pageNum: 2,
    lat: 35,
    lng: 139,
    taskStatus: "UNFINISHED",
    method: "POST"
  });
  assert.equal(result.error, undefined);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].input).href, EXPECTED_URL);
  assert.equal(calls[0].init.method, "GET");
});

test("blocks the request when the serialized constants are tampered with", async () => {
  const source = collectSpotJobsFromPage.toString();
  const tamperings = [
    ['const API_ORIGIN = "https://spotjobs-api.spotapi.jp"', 'const API_ORIGIN = "https://evil.example"'],
    ['const API_ORIGIN = "https://spotjobs-api.spotapi.jp"', 'const API_ORIGIN = "http://spotjobs-api.spotapi.jp"'],
    ['const API_ORIGIN = "https://spotjobs-api.spotapi.jp"', 'const API_ORIGIN = "https://spotjobs-api.spotapi.jp:8443"'],
    ['const API_PATH = "/api/v1/rounder/work"', 'const API_PATH = "/api/v1/rounder/other"'],
    ['const API_METHOD = "GET"', 'const API_METHOD = "POST"'],
    ['["pageSize", "50"]]', '["pageSize", "50"], ["lat", "35"]]']
  ];
  for (const [from, to] of tamperings) {
    assert.ok(source.includes(from), `fixture must match: ${from}`);
    // eslint-disable-next-line no-new-func
    const tampered = new Function(`return (${source.replace(from, to)});`)();
    const { calls, indexedDB } = installPage();
    const result = await tampered();
    assert.equal(result.error, "SPOTLOG_BLOCKED_REQUEST", to);
    assert.equal(result.records, null);
    assert.equal(calls.length, 0, "no request when blocked");
    assert.equal(indexedDB.opened.length, 0, "credentials are not even read when blocked");
  }
});

test("never returns or logs the token, record key, or refresh token", async () => {
  for (const respond of [
    () => jsonResponse([{ rounderWorkId: "ok" }]),
    () => jsonResponse({}, 401),
    () => jsonResponse({}, 500),
    () => { throw new TypeError(`network down ${SENTINEL_TOKEN} ${SENTINEL_KEY}`); },
    () => new Response(`not json ${SENTINEL_TOKEN}`, { status: 200 })
  ]) {
    const { consoleCalls } = installPage({ respond });
    const result = await collectSpotJobsFromPage();
    assertNoLeak(result, consoleCalls);
  }
});

test("401 and 403 map to SPOTLOG_AUTH_REQUIRED without retrying", async () => {
  for (const status of [401, 403]) {
    const { calls } = installPage({ respond: () => jsonResponse({}, status) });
    const result = await collectSpotJobsFromPage();
    assert.equal(result.error, "SPOTLOG_AUTH_REQUIRED");
    assert.equal(result.records, null);
    assert.equal(calls.length, 1);
  }
});

test("other failures map to fixed codes after a single request", async () => {
  const cases = [
    [() => jsonResponse({}, 500), "SPOTLOG_API_ERROR:500"],
    [() => jsonResponse({}, 429), "SPOTLOG_API_ERROR:429"],
    [() => { throw new TypeError("Failed to fetch"); }, "SPOTLOG_API_ERROR:NETWORK"],
    [() => new Response("<html>", { status: 200 }), "SPOTLOG_API_FORMAT_CHANGED"],
    [() => jsonResponse({ unexpected: true }), "SPOTLOG_API_FORMAT_CHANGED"]
  ];
  for (const [respond, code] of cases) {
    const { calls } = installPage({ respond });
    const result = await collectSpotJobsFromPage();
    assert.equal(result.error, code);
    assert.equal(result.records, null);
    assert.equal(calls.length, 1);
  }
});

test("accepts nested official list payloads", async () => {
  installPage({ respond: () => jsonResponse({ result: { payload: { records: [{ rounderWorkId: "n" }] } } }) });
  const result = await collectSpotJobsFromPage();
  assert.deepEqual(result.records, [{ rounderWorkId: "n" }]);
});

test("a missing auth record or token reports SPOTLOG_AUTH_REQUIRED with zero requests", async () => {
  const variants = [
    { idbRows: null },
    { idbRows: [] },
    { idbRows: [{ fbase_key: "firebase:other", value: authUser() }] },
    { idbRows: [{ fbase_key: SENTINEL_KEY, value: authUser({ accessToken: "" }) }] },
    { withIndexedDb: false }
  ];
  for (const variant of variants) {
    const { calls, consoleCalls } = installPage(variant);
    const result = await collectSpotJobsFromPage();
    assert.equal(result.error, "SPOTLOG_AUTH_REQUIRED");
    assert.equal(calls.length, 0);
    assertNoLeak(result, consoleCalls);
  }
});

test("a missing official database is never created", async () => {
  const { indexedDB } = installPage({ idbRows: null });
  await collectSpotJobsFromPage();
  assert.deepEqual(indexedDB.opened, ["firebaseLocalStorageDb"]);
});

test("an expired token reports SPOTLOG_TOKEN_STALE with zero requests and no refresh", async () => {
  const { calls, consoleCalls } = installPage({
    idbRows: [{ fbase_key: SENTINEL_KEY, value: authUser({ expiresInMs: -60_000 }) }]
  });
  const result = await collectSpotJobsFromPage();
  assert.equal(result.error, "SPOTLOG_TOKEN_STALE");
  assert.equal(result.records, null);
  assert.equal(calls.length, 0);
  assertNoLeak(result, consoleCalls);
});

test("falls back to the localStorage auth record when IndexedDB has none", async () => {
  const { calls, consoleCalls } = installPage({
    idbRows: [],
    localStorageEntries: {
      unrelated: "x",
      [SENTINEL_KEY]: JSON.stringify(authUser())
    }
  });
  const result = await collectSpotJobsFromPage();
  assert.equal(result.error, undefined);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].headers.Authorization === `Bearer ${SENTINEL_TOKEN}`);
  assertNoLeak(result, consoleCalls);
});

test("an expired localStorage token is stale, not sent", async () => {
  const { calls } = installPage({
    withIndexedDb: false,
    localStorageEntries: { [SENTINEL_KEY]: JSON.stringify(authUser({ expiresInMs: -1 })) }
  });
  const result = await collectSpotJobsFromPage();
  assert.equal(result.error, "SPOTLOG_TOKEN_STALE");
  assert.equal(calls.length, 0);
});

test("the serialized function is self-contained", async () => {
  // eslint-disable-next-line no-new-func
  const serialized = new Function(`return (${collectSpotJobsFromPage.toString()});`)();
  const { calls } = installPage();
  const result = await serialized();
  assert.equal(result.error, undefined);
  assert.equal(calls.length, 1);
});
