import test from "node:test";
import assert from "node:assert/strict";
import { collectSpotJobsFromPage } from "../lib/page-collector.js";

const originalWindow = globalThis.window;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function installPage(fetchImplementation, requestOverrides = {}) {
  let officialFetchCalls = 0;
  const unfinishedButton = { textContent: "未完了", click() {} };
  const finishedButton = {
    textContent: "完了",
    click() {
      officialFetchCalls += 1;
      void globalThis.window.fetch(
        requestOverrides.url || "https://prod.spotapi.jp/api/v1/rounder/work?lat=0&lng=0&pageNum=1&pageSize=10&taskStatus=FINISHED&workTypes=BATTERY_INSERT%2CBATTERY_EJECT",
        {
          method: requestOverrides.method || "GET",
          headers: { Authorization: "Bearer test-only-token" }
        }
      );
    }
  };
  const page = {
    fetch: fetchImplementation,
    setTimeout,
    clearTimeout,
    document: {
      querySelectorAll(selector) {
        assert.equal(selector, "button");
        return [unfinishedButton, finishedButton];
      }
    }
  };
  globalThis.window = page;
  return { page, officialFetchCalls: () => officialFetchCalls };
}

test.afterEach(() => {
  globalThis.window = originalWindow;
});

test("captures the official authenticated request, paginates, and restores fetch", async () => {
  const requests = [];
  const originalFetch = async (input, init) => {
    const officialRequest = !(input instanceof Request);
    const request = input instanceof Request && init === undefined
      ? input
      : new Request(input, init);
    requests.push(request);
    const pageNum = Number(new URL(request.url).searchParams.get("pageNum"));
    assert.equal(request.headers.get("Authorization"), "Bearer test-only-token");
    if (officialRequest) {
      return jsonResponse(Array.from({ length: 10 }, (_, index) => ({ rounderWorkId: `official-${index}` })));
    }
    return jsonResponse(
      pageNum === 1
        ? Array.from({ length: 10 }, (_, index) => ({ rounderWorkId: `page-${index}` }))
        : []
    );
  };
  const { page, officialFetchCalls } = installPage(originalFetch);

  const result = await collectSpotJobsFromPage({ pageSize: 10, maxRecords: 50 });

  assert.equal(result.error, undefined);
  assert.equal(result.records.length, 10);
  assert.equal(officialFetchCalls(), 1);
  assert.equal(requests.length, 3);
  assert.match(requests[0].url, /^https:\/\/prod\.spotapi\.jp\/api\/v1\/rounder\/work/u);
  assert.equal(new URL(requests[1].url).searchParams.get("pageNum"), "1");
  assert.equal(new URL(requests[2].url).searchParams.get("pageNum"), "2");
  assert.equal(page.fetch, originalFetch);
});

test("accepts a nested official response payload", async () => {
  const originalFetch = async (input, init) => {
    const request = input instanceof Request && init === undefined
      ? input
      : new Request(input, init);
    const pageSize = Number(new URL(request.url).searchParams.get("pageSize"));
    return jsonResponse({
      data: {
        result: {
          list: pageSize === 10
            ? [{ rounderWorkId: "captured" }]
            : [{ rounderWorkId: "manual" }]
        }
      }
    });
  };
  const { page } = installPage(originalFetch);

  const result = await collectSpotJobsFromPage({ pageSize: 50, maxRecords: 50 });

  assert.deepEqual(result.records.map((record) => record.rounderWorkId), ["manual"]);
  assert.equal(page.fetch, originalFetch);
});

test("serializes authentication errors and restores fetch", async () => {
  const originalFetch = async () => jsonResponse({}, 401);
  const { page } = installPage(originalFetch);

  const result = await collectSpotJobsFromPage({ pageSize: 10, maxRecords: 50 });

  assert.equal(result.error, "SPOTLOG_AUTH_REQUIRED");
  assert.equal(result.records, null);
  assert.equal(page.fetch, originalFetch);
});

test("serializes changed payload formats and restores fetch", async () => {
  const originalFetch = async () => jsonResponse({ unexpected: true });
  const { page } = installPage(originalFetch);

  const result = await collectSpotJobsFromPage({ pageSize: 10, maxRecords: 50 });

  assert.equal(result.error, "SPOTLOG_API_FORMAT_CHANGED");
  assert.equal(page.fetch, originalFetch);
});

test("ignores lookalike history requests outside the official API host", async () => {
  const originalFetch = async () => jsonResponse([]);
  const { page } = installPage(originalFetch, {
    url: "https://example.com/api/v1/rounder/work?pageNum=1&pageSize=10&taskStatus=FINISHED"
  });

  const result = await collectSpotJobsFromPage({
    pageSize: 10,
    maxRecords: 50,
    captureTimeoutMs: 500
  });

  assert.equal(result.error, "SPOTLOG_API_CAPTURE_TIMEOUT");
  assert.equal(result.records, null);
  assert.equal(page.fetch, originalFetch);
});
