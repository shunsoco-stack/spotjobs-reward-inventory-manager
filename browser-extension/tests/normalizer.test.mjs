import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeSnapshots,
  normalizeSpotJobsItem,
  normalizeSpotJobsItems
} from "../lib/normalizer.js";

test("normalizes replenish and pickup records", () => {
  const replenish = normalizeSpotJobsItem({
    rounderWorkId: 42,
    workType: "BATTERY_INSERT",
    endTime: "2026-09-17T11:41:25+09:00",
    score: "3",
    expectedReward: 180,
    spotDetail: { spotName: "テスト店舗" },
    isEarlyRefill: true
  });
  assert.equal(replenish.externalId, "42");
  assert.equal(replenish.workType, "BATTERY_INSERT");
  assert.equal(replenish.quantity, 3);
  assert.equal(replenish.earlyRefill, true);

  const pickup = normalizeSpotJobsItem({
    rounderWorkId: "43",
    workType: "BL_BATTERY_EJECT",
    endTime: 1_789_577_410,
    score: 1,
    spotDetail: { spotName: "別の店舗" }
  });
  assert.equal(pickup.workType, "BL_BATTERY_EJECT");
  assert.equal(pickup.earlyRefill, null);
});

test("filters unsupported and malformed records", () => {
  assert.equal(normalizeSpotJobsItem({ workType: "UNKNOWN" }), null);
  assert.equal(
    normalizeSpotJobsItem({
      rounderWorkId: "x",
      workType: "BATTERY_INSERT",
      endTime: "invalid",
      score: 3
    }),
    null
  );
  assert.equal(
    normalizeSpotJobsItem({
      rounderWorkId: "future",
      workType: "BATTERY_INSERT",
      endTime: "2999-01-01T00:00:00Z",
      score: 1
    }),
    null
  );
});

test("interprets timezone-less timestamps as JST", () => {
  const record = normalizeSpotJobsItem({
    rounderWorkId: "jst",
    workType: "BATTERY_INSERT",
    endTime: "2026-09-17 11:41:25",
    score: 1
  });
  assert.equal(record.completedAt, "2026-09-17T02:41:25.000Z");
});

test("deduplicates and sorts oldest first", () => {
  const items = normalizeSpotJobsItems([
    {
      rounderWorkId: "new",
      workType: "BATTERY_EJECT",
      endTime: "2026-09-18T00:00:00Z",
      score: 1
    },
    {
      rounderWorkId: "old",
      workType: "BATTERY_INSERT",
      endTime: "2026-09-17T00:00:00Z",
      score: 2
    },
    {
      rounderWorkId: "new",
      workType: "BATTERY_EJECT",
      endTime: "2026-09-18T00:00:00Z",
      score: 1
    }
  ]);
  assert.deepEqual(items.map((item) => item.externalId), ["old", "new"]);

  const merged = mergeSnapshots([items[0]], [items[0], items[1]]);
  assert.deepEqual(merged.map((item) => item.externalId), ["old", "new"]);
});

test("keeps a bounded rolling window of the newest 500 jobs", () => {
  const existing = Array.from({ length: 510 }, (_, index) => ({
    externalId: `job-${index}`,
    completedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
  }));
  const merged = mergeSnapshots(existing, []);
  assert.equal(merged.length, 500);
  assert.equal(merged[0].externalId, "job-10");
  assert.equal(merged.at(-1).externalId, "job-509");
});
