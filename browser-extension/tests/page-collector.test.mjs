import test from "node:test";
import assert from "node:assert/strict";
import { collectSpotJobsFromPage } from "../lib/page-collector.js";

globalThis.location = { origin: "https://app.spot.jobs" };

function jsonResponse(payload, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "application/json; charset=utf-8" },
    json: async () => payload
  };
}

test("paginates until a short page", async () => {
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    const page = Number(url.searchParams.get("pageNum"));
    return jsonResponse({
      data: {
        result: {
          list:
            page === 1
              ? Array.from({ length: 10 }, (_, index) => ({ rounderWorkId: `a-${index}` }))
              : [{ rounderWorkId: "last" }]
        }
      }
    });
  };
  const result = await collectSpotJobsFromPage({ pageSize: 10, maxRecords: 50 });
  assert.equal(requested.length, 2);
  assert.equal(result.records.length, 11);
  assert.equal(new URL(requested[0]).searchParams.get("taskStatus"), "FINISHED");
});

test("refreshes the full recent window even if a prior ID is supplied", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse([
      { rounderWorkId: "new-2" },
      { rounderWorkId: "new-1" },
      { rounderWorkId: "known" },
      { rounderWorkId: "old" }
    ]);
  };
  const result = await collectSpotJobsFromPage({
    knownIds: ["known"],
    pageSize: 10,
    maxRecords: 50
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    result.records.map((record) => record.rounderWorkId),
    ["new-2", "new-1", "known", "old"]
  );
});

test("reports an authentication-required sentinel", async () => {
  globalThis.fetch = async () => jsonResponse({}, 401);
  await assert.rejects(
    () => collectSpotJobsFromPage({ pageSize: 10, maxRecords: 50 }),
    /SPOTLOG_AUTH_REQUIRED/u
  );
});
