import { describe, expect, it } from "vitest";
import { addDays, adjacentWeekStart, calculate, createDemoRecords, createRewardSnapshot, defaultSettings, goalAdditional, inventoryDays, isValidDate, simulateAdditional, tierProjections, todayLocal, weekStartFor } from "./core";
import type { Area, Settings, WorkRecord } from "./core";

const monday = "2026-09-14";
const sunday = "2026-09-20";
function refill(quantity: number, date = monday, area: Area = "A", manualEarly = quantity): WorkRecord {
  return { id: `refill-${date}-${quantity}-${area}`, type: "refill", quantity, date, area,
    earlyMode: "manual", manualEarly, createdAt: `${date}T10:00:00+09:00` };
}
function pickup(quantity: number, date: string, id = `pickup-${date}`): WorkRecord {
  return { id, type: "pickup", quantity, date, createdAt: `${date}T08:00:00+09:00` };
}
const result = (records: WorkRecord[]) => calculate(records, defaultSettings, monday, sunday);
function savedRefill(quantity: number, date = monday, area: Area = "A", settings = defaultSettings, records: WorkRecord[] = []): WorkRecord {
  return { ...refill(quantity, date, area), type: "refill", area, earlyMode: "manual",
    snapshot: createRewardSnapshot(date, area, settings, records) };
}

describe("weekly reward estimates", () => {
  it.each< [Area, number] >([["A", 55], ["B", 60], ["C", 65], ["D", 70], ["omitted", 55]])(
    "uses the requested %s area rate of %i yen", (area, rate) => {
      expect(result([refill(1, monday, area, 0)]).base).toBe(rate);
      expect(result([refill(1, monday, area, 0)]).days[0].regionCounts[area]).toBe(1);
    },
  );
  it("reproduces the user's 54-unit reference: 2970 + 540 + 540 = 4050 yen", () => {
    const summary = result([refill(54)]);
    expect(summary).toMatchObject({ base: 2970, earlyBonus: 540, countBonus: 540, total: 4050, earlyCount: 54 });
    expect(summary.inventory.total).toBe(-54);
    expect(summary.records[0].untrackedCount).toBe(54);
    expect(summary.errors).toHaveLength(1);
  });

  it.each([[0, 0], [1, 0], [19, 0], [20, 5], [49, 5], [50, 10], [99, 10], [100, 15], [149, 15], [150, 20], [99999, 20]])(
    "applies the %i-unit tier (%i yen) to every refill in the week", (quantity, rate) => {
      const summary = result(quantity === 0 ? [] : [refill(quantity, monday, "A", 0)]);
      expect(summary.countRate).toBe(rate);
      expect(summary.countBonus).toBe(quantity * rate);
      expect(summary.total).toBe(quantity * (55 + rate));
    },
  );

  it("retroactively upgrades all days while respecting their individual areas", () => {
    const summary = result([refill(19, monday, "A", 0), refill(1, addDays(monday, 1), "B", 0)]);
    expect(summary.base).toBe(19 * 55 + 60);
    expect(summary.countBonus).toBe(100);
    expect(summary.days[0].countBonus).toBe(95);
    expect(summary.days[1].countBonus).toBe(5);
    expect(summary.nextTier).toEqual({ count: 50, rate: 10, remaining: 30, bonusIncrease: 400 });
  });

  it("does not carry the prior week's quantity tier into the selected week", () => {
    const summary = result([refill(150, addDays(monday, -1), "D"), refill(4, monday, "C", 0)]);
    expect(summary.refillCount).toBe(4);
    expect(summary.base).toBe(260);
    expect(summary.countBonus).toBe(0);
    expect(summary.records[0].countBonus).toBe(3000);
    expect(summary.nextTier?.remaining).toBe(16);
  });

  it("keeps every historical record's own-week reward unchanged when navigating weeks", () => {
    const records = [refill(150, addDays(monday, -1), "D"),
      refill(19, monday, "A", 0), refill(1, addDays(monday, 1), "B", 0)];
    const current = result(records);
    const previous = calculate(records, defaultSettings, addDays(monday, -7), sunday);
    expect(current.records.map((record) => record.total)).toEqual([15000, 1140, 65]);
    expect(previous.records.map((record) => record.total)).toEqual([15000, 1140, 65]);
    expect(previous.total).toBe(15000);
    expect(current.total).toBe(1205);
  });

  it("uses edited settings rather than hardcoded reward rates", () => {
    const summary = calculate([refill(8, monday, "D", 3)], {
      ...defaultSettings, regionRates: { A: 1, B: 2, C: 3, D: 100, omitted: 4 }, earlyRate: 12,
      thresholds: [{ count: 8, rate: 6 }, { count: 0, rate: 0 }],
    }, monday, sunday);
    expect(summary).toMatchObject({ base: 800, earlyBonus: 36, countBonus: 48, total: 884, nextTier: null });
  });
});

describe("FIFO inventory and inclusive early days", () => {
  it("repays untracked inventory debt before creating newly available FIFO batches", () => {
    const summary = result([refill(5), pickup(3, addDays(monday, 1)), pickup(6, addDays(monday, 2)),
      { ...refill(2, addDays(monday, 2)), earlyMode: "auto" }]);
    expect(summary.records.map((record) => record.stockAfter)).toEqual([-5, -2, 4, 2]);
    expect(summary.inventory.batches).toHaveLength(1);
    expect(summary.inventory.batches[0]).toMatchObject({ pickupDate: addDays(monday, 2), remaining: 2 });
    expect(summary.records.at(-1)?.earlyCount).toBe(2);
  });

  it("keeps an unapplied stocktake as an observation, then applies it explicitly", () => {
    const records: WorkRecord[] = [pickup(10, monday),
      { id: "observation", type: "adjustment", date: monday, quantity: 7, createdAt: `${monday}T09:00:00+09:00` }];
    const observed = result(records);
    expect(observed.inventory.total).toBe(10);
    expect(observed.records[1]).toMatchObject({ expectedStock: 10, discrepancy: -3, applied: false, stockAfter: 10 });
    expect(observed.days[0]).toMatchObject({ stocktakeCount: 1, stocktakeDifference: -3 });
    const applied = result([records[0], { ...records[1], type: "adjustment", applied: true }]);
    expect(applied.inventory.total).toBe(7);
    expect(applied.records[1]).toMatchObject({ discrepancy: -3, applied: true, stockAfter: 7 });
  });

  it("retains the stocktake's saved audit values if earlier records are edited", () => {
    const records: WorkRecord[] = [pickup(12, monday),
      { id: "audit", type: "adjustment", date: monday, quantity: 7, expectedStock: 10, difference: -3,
        applied: true, createdAt: `${monday}T09:00:00+09:00` }];
    expect(result(records).records[1]).toMatchObject({ expectedStock: 10, discrepancy: -3, stockAfter: 7 });
  });

  it("an applied stocktake can reconcile negative stock without inventing pickup ages", () => {
    const summary = result([refill(5), { id: "reconcile", type: "adjustment", date: addDays(monday, 1),
      quantity: 3, applied: true, createdAt: `${addDays(monday, 1)}T09:00:00+09:00` }]);
    expect(summary.records[1]).toMatchObject({ expectedStock: -5, discrepancy: 8, stockAfter: 3 });
    expect(summary.inventory).toMatchObject({ total: 3, unknownAgeCount: 3 });
    expect(summary.inventory.batches[0].remaining).toBe(3);
  });

  it("calculates a stocktake preview from inventory immediately before it, even while applying it", () => {
    const date = addDays(monday, 1);
    const summary = result([pickup(10, monday), refill(3, date), {
      id: "preview", type: "adjustment", date, quantity: 5, applied: true,
      createdAt: `${date}T11:00:00+09:00`,
    }]);
    const own = summary.records.find((record) => record.id === "preview")!;
    expect(own).toMatchObject({ expectedStock: 7, discrepancy: -2, stockAfter: 5, applied: true });
    expect(own.quantity - own.discrepancy!).toBe(7);
  });

  it("derives a new audit when a stocktake date changes and saved audit values are intentionally removed", () => {
    const observations: WorkRecord = {
      id: "dated-audit", type: "adjustment", date: monday, quantity: 8, expectedStock: 10, difference: -2,
      createdAt: `${monday}T11:00:00+09:00`,
    };
    const records = [pickup(10, monday), refill(3, addDays(monday, 1))];
    const original = result([...records, observations]);
    expect(original.records.find((record) => record.id === "dated-audit")).toMatchObject({ expectedStock: 10, discrepancy: -2 });
    const moved: WorkRecord = {
      id: observations.id, type: "adjustment", date: addDays(monday, 2), quantity: 8, createdAt: observations.createdAt,
    };
    const recomputed = result([...records, moved]);
    expect(recomputed.records.find((record) => record.id === "dated-audit")).toMatchObject({ expectedStock: 7, discrepancy: 1, stockAfter: 7 });
    expect(recomputed.inventory.total).toBe(7);
  });
  it("includes pickup day plus two calendar days, and excludes the fourth day", () => {
    const early = result([pickup(4, monday), { ...refill(4, addDays(monday, 2)), earlyMode: "auto" }]);
    const late = result([pickup(4, monday), { ...refill(4, addDays(monday, 3)), earlyMode: "auto" }]);
    expect(early.earlyCount).toBe(4);
    expect(late.earlyCount).toBe(0);
  });

  it("consumes expired stock before fresh stock and never invents early eligibility", () => {
    const summary = result([
      pickup(3, addDays(monday, -1)), pickup(5, addDays(monday, 1)),
      { ...refill(6, addDays(monday, 2)), earlyMode: "auto" },
    ]);
    expect(summary.earlyCount).toBe(3);
    expect(summary.inventory.total).toBe(2);
    expect(summary.inventory.batches[0]).toMatchObject({ pickupDate: addDays(monday, 1), remaining: 2 });
  });

  it("preserves negative theoretical stock and reports untracked units", () => {
    const summary = result([pickup(2, monday), { ...refill(7), earlyMode: "auto" }]);
    expect(summary).toMatchObject({ refillCount: 7, earlyCount: 2, base: 385 });
    expect(summary.inventory.total).toBe(-5);
    expect(summary.records[1]).toMatchObject({ trackedCount: 2, untrackedCount: 5, stockAfter: -5 });
    expect(summary.errors).toHaveLength(1);
  });

  it("accepts a manually entered early count without requiring pickup records", () => {
    const summary = result([refill(10, monday, "A", 4)]);
    expect(summary).toMatchObject({ earlyCount: 4, earlyBonus: 40, base: 550 });
    expect(summary.inventory.total).toBe(-10);
    expect(summary.errors).toHaveLength(1);
  });

  it("stocktakes adjust absolute stock, with unknown-age additions excluded from auto early bonuses", () => {
    const summary = result([
      pickup(5, monday),
      { id: "stocktake", type: "adjustment", applied: true, quantity: 8, date: monday, createdAt: `${monday}T09:00:00+09:00` },
      { ...refill(7), earlyMode: "auto" },
    ]);
    expect(summary.earlyCount).toBe(5);
    expect(summary.inventory).toMatchObject({ total: 1, eligibleCount: 0, unknownAgeCount: 1 });
    expect(summary.inventory.batches[0].pickupDate).toBeNull();
  });

  it("reduces oldest stock on a downward stocktake, and permits a stocktake of zero", () => {
    const records: WorkRecord[] = [pickup(10, monday),
      { id: "stocktake", type: "adjustment", applied: true, quantity: 3, date: monday, createdAt: `${monday}T11:00:00+09:00` }];
    expect(result(records).inventory.total).toBe(3);
    expect(result([...records, { id: "zero", type: "adjustment", applied: true, quantity: 0, date: monday, createdAt: `${monday}T12:00:00+09:00` }]).inventory.total).toBe(0);
  });

  it("recalculates FIFO consistently after editing or deleting a historical refill", () => {
    const records = [pickup(10, monday), { ...refill(6), earlyMode: "auto" as const }];
    expect(result(records).inventory.total).toBe(4);
    expect(result([records[0], { ...records[1], quantity: 3 }]).inventory.total).toBe(7);
    expect(result([records[0]]).inventory.total).toBe(10);
  });

  it("carries stock from the previous week through empty days, refills and stocktakes", () => {
    const summary = result([
      pickup(10, addDays(monday, -1)),
      { ...refill(3, addDays(monday, 1)), earlyMode: "auto" },
      { id: "stocktake", type: "adjustment", applied: true, quantity: 2, date: addDays(monday, 3), createdAt: "2026-09-17T09:00:00Z" },
      pickup(6, addDays(monday, 5)),
    ]);
    expect(summary.days.map((day) => day.closingStock)).toEqual([10, 7, 7, 2, 2, 8, 8]);
    expect(summary.inventory.total).toBe(8);
  });

  it("shows zero stock before the first record, and historical stock independently of current inventory", () => {
    const records = [pickup(5, addDays(monday, 2)), refill(2, addDays(monday, 5)),
      pickup(4, addDays(monday, 8))];
    const summary = calculate(records, defaultSettings, monday, addDays(monday, 8));
    expect(summary.days.map((day) => day.closingStock)).toEqual([0, 0, 5, 5, 5, 3, 3]);
    expect(summary.inventory.total).toBe(7);
  });

  it("sorts same-day ISO timestamps by instant when JST and UTC offsets are mixed", () => {
    const summary = result([
      { ...refill(3), earlyMode: "auto", createdAt: `${monday}T00:00:00Z` },
      { ...pickup(5, monday), createdAt: `${monday}T08:00:00+09:00` },
    ]);
    expect(summary.earlyCount).toBe(3);
    expect(summary.inventory.total).toBe(2);
    expect(summary.errors).toEqual([]);
  });

  it("replays a large history of depleted batches and preserves remaining FIFO order", () => {
    const cycles = 6000;
    const records: WorkRecord[] = [];
    const midnight = new Date(`${monday}T00:00:00+09:00`).getTime();
    for (let index = 0; index < cycles; index++) {
      records.push({ ...pickup(2, monday, `bulk-pickup-${index}`),
        createdAt: new Date(midnight + index * 2).toISOString() });
      records.push({ ...refill(2), id: `bulk-refill-${index}`, earlyMode: "auto",
        createdAt: new Date(midnight + index * 2 + 1).toISOString() });
    }
    records.push({ ...pickup(3, monday, "remaining-known"),
      createdAt: new Date(midnight + cycles * 2).toISOString() });
    records.push({ id: "remaining-unknown", type: "adjustment", applied: true, date: monday, quantity: 8,
      createdAt: new Date(midnight + cycles * 2 + 1).toISOString() });
    const summary = calculate(records, defaultSettings, monday, monday);
    expect(summary).toMatchObject({ refillCount: cycles * 2, earlyCount: cycles * 2, total: cycles * 2 * 85 });
    expect(summary.records).toHaveLength(cycles * 2 + 2);
    expect(summary.records.filter((record) => record.type === "refill").every((record) => record.stockAfter === 0 && record.earlyCount === 2)).toBe(true);
    expect(summary.inventory).toMatchObject({ total: 8, eligibleCount: 3, unknownAgeCount: 5 });
    expect(summary.inventory.batches.map((batch) => [batch.id, batch.remaining])).toEqual([
      ["remaining-known", 3], ["remaining-unknown", 5],
    ]);
    expect(summary.errors).toEqual([]);
  });
});

describe("saved reward conditions and frozen bonus weeks", () => {
  it("preserves recorded region and early rates, early-day boundary, and tiers after settings change", () => {
    const date = addDays(monday, 2);
    const saved = { ...savedRefill(20, date), earlyMode: "auto" as const };
    const changed: Settings = {
      ...defaultSettings, regionRates: { ...defaultSettings.regionRates, A: 999 }, earlyRate: 99, earlyDays: 1,
      thresholds: [{ count: 0, rate: 88 }], weekStartsOn: 0,
    };
    const summary = calculate([pickup(20, monday), saved], changed, monday, sunday);
    expect(summary).toMatchObject({ refillCount: 20, earlyCount: 20, base: 1100, earlyBonus: 200, countBonus: 100, total: 1400 });
    expect(summary.thresholds).toEqual(defaultSettings.thresholds);
  });

  it("reuses an existing bonus week's anchor and tiers after changing the start weekday", () => {
    const first = savedRefill(19);
    const changed: Settings = { ...defaultSettings, weekStartsOn: 0, thresholds: [{ count: 0, rate: 0 }, { count: 1, rate: 500 }] };
    const next = createRewardSnapshot(addDays(monday, 2), "B", changed, [first]);
    expect(next.weekStart).toBe(monday);
    expect(next.thresholds).toEqual(defaultSettings.thresholds);
    expect(next.regionRate).toBe(60);
    const future = createRewardSnapshot(addDays(monday, 8), "B", changed, [first]);
    expect(future.weekStart).toBe(addDays(monday, 6));
    expect(future.thresholds).toEqual(changed.thresholds);
  });

  it("uses the chronologically first snapshot policy even if input order is reversed", () => {
    const first = savedRefill(19);
    const conflicting = { ...savedRefill(1, addDays(monday, 1)), snapshot: {
      ...createRewardSnapshot(monday, "A", defaultSettings, []), thresholds: [{ count: 0, rate: 999 }],
    } };
    const summary = result([conflicting, first]);
    expect(summary.countBonus).toBe(100);
    expect(createRewardSnapshot(addDays(monday, 4), "A", defaultSettings, [conflicting, first]).thresholds).toEqual(defaultSettings.thresholds);
  });

  it("applies updated per-unit rates only to new records while retaining the week's old tiers", () => {
    const first = savedRefill(19);
    const changed = { ...defaultSettings, regionRates: { ...defaultSettings.regionRates, A: 100 }, earlyRate: 20,
      thresholds: [{ count: 0, rate: 0 }, { count: 1, rate: 999 }] };
    const next = savedRefill(1, addDays(monday, 1), "A", changed, [first]);
    const summary = calculate([first, next], changed, monday, sunday);
    expect(summary).toMatchObject({ base: 1145, earlyBonus: 210, countBonus: 100, total: 1455 });
    expect(summary.records.map((record) => record.earlyBonus)).toEqual([190, 20]);
  });

  it("recalculates tiers after editing or deleting a record while preserving its snapshot", () => {
    const first = savedRefill(19);
    const second = savedRefill(1, addDays(monday, 1), "A", defaultSettings, [first]);
    expect(result([first, second]).countRate).toBe(5);
    expect(result([first]).countRate).toBe(0);
    expect(result([{ ...first, quantity: 49, manualEarly: 49 }, second]).countRate).toBe(10);
  });

  it("copies tiers so later settings mutations cannot change a saved snapshot", () => {
    const settings = structuredClone(defaultSettings);
    const snapshot = createRewardSnapshot(monday, "omitted", settings, []);
    settings.thresholds[1].rate = 999;
    settings.regionRates.omitted = 999;
    expect(snapshot.regionRate).toBe(55);
    expect(snapshot.thresholds[1].rate).toBe(5);
  });

  it("keeps the first anchor on an overlapping boundary after changing the start weekday", () => {
    const first = savedRefill(19);
    const changed: Settings = { ...defaultSettings, weekStartsOn: 0, thresholds: [{ count: 0, rate: 0 }, { count: 2, rate: 30 }] };
    const followingMonday = addDays(monday, 7);
    const nextWeek = savedRefill(2, followingMonday, "A", changed, [first]);
    const overlap = createRewardSnapshot(sunday, "A", changed, [nextWeek, first]);
    expect(overlap.weekStart).toBe(monday);
    expect(overlap.thresholds).toEqual(defaultSettings.thresholds);
    const mondaySnapshot = createRewardSnapshot(followingMonday, "A", changed, [nextWeek, first]);
    expect(mondaySnapshot.weekStart).toBe(sunday);
    expect(mondaySnapshot.thresholds).toEqual(changed.thresholds);
    const previous = calculate([first, nextWeek], changed, monday, followingMonday);
    const current = calculate([first, nextWeek], changed, sunday, followingMonday);
    expect(previous.refillCount).toBe(19);
    expect(current.refillCount).toBe(2);
    expect(previous.records.map((record) => record.countBonus)).toEqual([0, 60]);
    expect(current.records.map((record) => record.countBonus)).toEqual([0, 60]);
  });
});

describe("additional-work and goal projections", () => {
  it("includes the retroactive tier jump when moving from 49 to 50 units", () => {
    const summary = result([savedRefill(49)]);
    expect(simulateAdditional(summary, defaultSettings, 1, "A", true)).toMatchObject({
      additional: 1, count: 50, rate: 10, base: 2750, earlyBonus: 500, countBonus: 500, total: 3750, difference: 320,
    });
    expect(goalAdditional(summary, defaultSettings, 3600, "A", true)?.additional).toBe(1);
  });

  it("distinguishes early/non-early projections and lists future tier totals", () => {
    const summary = result([savedRefill(19)]);
    const early = simulateAdditional(summary, defaultSettings, 1, "D", true);
    const ordinary = simulateAdditional(summary, defaultSettings, 1, "D", false);
    expect(early.total - ordinary.total).toBe(10);
    expect(tierProjections(summary, defaultSettings, "A", false).map((tier) => [tier.threshold, tier.additional, tier.rate]))
      .toEqual([[20, 1, 5], [50, 31, 10], [100, 81, 15], [150, 131, 20]]);
  });

  it("uses frozen quantity tiers but current rates for the additional work", () => {
    const changed = { ...defaultSettings, regionRates: { ...defaultSettings.regionRates, A: 100 }, earlyRate: 20,
      thresholds: [{ count: 0, rate: 900 }] };
    const summary = calculate([savedRefill(49)], changed, monday, sunday);
    expect(simulateAdditional(summary, changed, 1, "A", true)).toMatchObject({ rate: 10, base: 2795, earlyBonus: 510, countBonus: 500, total: 3805 });
  });

  it("retains reached tiers with their original tier rates and the current earned total", () => {
    const summary = result([savedRefill(100)]);
    const tiers = tierProjections(summary, defaultSettings);
    expect(tiers.map((tier) => [tier.threshold, tier.thresholdRate, tier.additional])).toEqual([
      [20, 5, 0], [50, 10, 0], [100, 15, 0], [150, 20, 50],
    ]);
    for (const tier of tiers.slice(0, 3)) expect(tier).toMatchObject({ total: summary.total, difference: 0, count: 100, rate: 15 });
    expect(tiers[3]).toMatchObject({ total: 12750, difference: 4750, rate: 20 });
  });

  it("returns zero additional when already at the goal and null when the goal is unreachable", () => {
    const summary = result([savedRefill(20)]);
    expect(goalAdditional(summary, defaultSettings, 100, "A", false)?.additional).toBe(0);
    const zero = { ...defaultSettings, regionRates: { A: 0, B: 0, C: 0, D: 0, omitted: 0 }, earlyRate: 0, thresholds: [{ count: 0, rate: 0 }] };
    expect(goalAdditional(calculate([], zero, monday, sunday), zero, 1, "omitted", false)).toBeNull();
    expect(goalAdditional(summary, defaultSettings, Number.NaN)).toBeNull();
    expect(simulateAdditional(result([]), defaultSettings, 100001, "A", false)).toMatchObject({ count: 100001, total: 100001 * 75 });
  });

  it("does not mutate history or snapshots during simulation", () => {
    const summary = result([savedRefill(49)]);
    const before = JSON.stringify(summary);
    simulateAdditional(summary, defaultSettings, 10, "A", true);
    goalAdditional(summary, defaultSettings, 10000, "A", true);
    tierProjections(summary, defaultSettings);
    expect(JSON.stringify(summary)).toBe(before);
  });
});

describe("inventory-day windows", () => {
  it("shows the last three physical inventory days even across the selected week's boundary", () => {
    const saturday = addDays(monday, -2);
    const previousSunday = addDays(monday, -1);
    const records: WorkRecord[] = [pickup(10, saturday), refill(3, previousSunday),
      { id: "observe", type: "adjustment", date: monday, quantity: 5, createdAt: `${monday}T09:00:00+09:00` }];
    const rows = inventoryDays(calculate(records, defaultSettings, monday, monday), monday);
    expect(rows).toEqual([
      { date: saturday, pickupCount: 10, refillCount: 0, closingStock: 10, stocktake: null, discrepancy: null, applied: false },
      { date: previousSunday, pickupCount: 0, refillCount: 3, closingStock: 7, stocktake: null, discrepancy: null, applied: false },
      { date: monday, pickupCount: 0, refillCount: 0, closingStock: 7, stocktake: 5, discrepancy: -2, applied: false },
    ]);
  });
});

describe("date and input integrity", () => {
  it("navigates adjacent saved bonus weeks after a weekday change, with seven-day fallback", () => {
    const older = savedRefill(3, addDays(monday, -7));
    const first = savedRefill(5, monday);
    const changed: Settings = { ...defaultSettings, weekStartsOn: 0 };
    const following = savedRefill(10, addDays(monday, 7), "A", changed, [older, first]);
    const records = [following, first, older];
    expect(adjacentWeekStart(sunday, -1, records, changed)).toBe(monday);
    expect(adjacentWeekStart(monday, 1, records, changed)).toBe(sunday);
    expect(adjacentWeekStart(monday, -1, records, changed)).toBe(addDays(monday, -7));
    expect(adjacentWeekStart(sunday, 1, records, changed)).toBe(addDays(sunday, 7));
    expect(adjacentWeekStart(addDays(monday, -7), -1, records, changed)).toBe(addDays(monday, -14));
    expect(adjacentWeekStart(monday, 1, [], changed)).toBe(addDays(monday, 7));
  });

  it("uses configured weekdays for legacy records without a snapshot during week navigation", () => {
    const settings: Settings = { ...defaultSettings, weekStartsOn: 0 };
    expect(adjacentWeekStart(monday, -1, [refill(1, monday)], settings)).toBe(addDays(monday, -1));
  });

  it("does not skip empty weeks to reach a distant historical or future snapshot", () => {
    const records = [savedRefill(1, "2026-01-05"), savedRefill(1, "2026-12-07")];
    expect(adjacentWeekStart(monday, -1, records, defaultSettings)).toBe(addDays(monday, -7));
    expect(adjacentWeekStart(monday, 1, records, defaultSettings)).toBe(addDays(monday, 7));
  });

  it("honors a nearby changed-weekday snapshot whose interval contains the nominal target", () => {
    const sundaySettings: Settings = { ...defaultSettings, weekStartsOn: 0 };
    const previous = savedRefill(1, addDays(monday, -8), "A", sundaySettings);
    expect(adjacentWeekStart(monday, -1, [previous], defaultSettings)).toBe(addDays(monday, -8));
  });
  it("uses Monday weeks across year boundaries and Japan's date", () => {
    expect(weekStartFor("2027-01-01")).toBe("2026-12-28");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(todayLocal(new Date("2026-09-17T15:01:00Z"))).toBe("2026-09-18");
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(weekStartFor(monday, 0)).toBe("2026-09-13");
    expect(weekStartFor(monday, 3)).toBe("2026-09-09");
  });

  it("ignores invalid, duplicate, and future records while retaining their error messages", () => {
    const original = refill(4);
    const summary = result([original, original, refill(-5), refill(3, "2026-02-30"), refill(8, "2026-09-21")]);
    expect(summary.refillCount).toBe(4);
    expect(summary.errors).toHaveLength(5);
  });

  it("does not mutate source records or settings", () => {
    const records = [pickup(4, monday), refill(2)];
    const before = JSON.stringify({ records, settings: defaultSettings });
    result(records);
    expect(JSON.stringify({ records, settings: defaultSettings })).toBe(before);
  });

  it.each(Array.from({ length: 7 }, (_, day) => addDays(monday, day)))(
    "sample stays valid on %s with six units expiring today and frozen snapshots", (today) => {
      const demo = createDemoRecords(today);
      const summary = calculate(demo, defaultSettings, weekStartFor(today), today);
      const day = Math.round((new Date(today).getTime() - new Date(monday).getTime()) / 86400000);
      const count = [3, 8, 18, 28, 43, 51, 61][day];
      expect(summary).toMatchObject({ refillCount: count, earlyCount: count });
      expect(demo.filter((record) => record.type === "refill").every((record) => record.snapshot !== undefined)).toBe(true);
      expect(summary.inventory).toMatchObject({ total: 14, eligibleCount: 14, expiringToday: 6 });
      expect(summary.errors).toEqual([]);
      expect(demo.every((record) => record.date <= today)).toBe(true);
      expect(demo.every((record) => new Date(record.createdAt).getTime() <= new Date(`${today}T00:00:00.010+09:00`).getTime())).toBe(true);
    },
  );
});
