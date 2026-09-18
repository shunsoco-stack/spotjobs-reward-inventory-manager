/** Civil dates use YYYY-MM-DD; rewards are estimates frozen to their recorded conditions. */
export type Area = "A" | "B" | "C" | "D" | "omitted";
export type RecordType = "pickup" | "refill" | "adjustment";
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export interface BonusTier { count: number; rate: number }
export interface RewardSnapshot {
  regionRate: number;
  earlyRate: number;
  earlyDays: number;
  weekStart: string;
  thresholds: BonusTier[];
}
export type RefillSnapshot = RewardSnapshot;

interface RecordBase {
  id: string;
  date: string;
  quantity: number;
  createdAt: string;
  note?: string;
}
interface OptionalRefillFields { area?: Area; earlyMode?: "auto" | "manual"; manualEarly?: number }
export type WorkRecord = RecordBase & (
  | ({ type: "pickup" } & OptionalRefillFields)
  | ({ type: "adjustment"; applied?: boolean; expectedStock?: number; difference?: number } & OptionalRefillFields)
  | { type: "refill"; area: Area; earlyMode: "auto" | "manual"; manualEarly?: number; snapshot?: RewardSnapshot }
);

export interface Settings {
  regionRates: Record<Area, number>;
  regionNames: Record<Area, string>;
  regionDescriptions: Record<Area, string>;
  defaultArea: Area;
  thresholds: BonusTier[];
  earlyDays: number;
  earlyRate: number;
  weeklyGoal: number;
  weekStartsOn: Weekday;
  theme: "light" | "dark" | "system";
}

export const AREAS: Area[] = ["A", "B", "C", "D", "omitted"];
export const defaultSettings: Settings = {
  regionRates: { A: 55, B: 60, C: 65, D: 70, omitted: 55 },
  regionNames: { A: "A", B: "B", C: "C", D: "D", omitted: "省略" },
  regionDescriptions: { A: "23区内", B: "大都市", C: "都内23区外", D: "その他", omitted: "省略時に選択" },
  defaultArea: "omitted",
  thresholds: [{ count: 0, rate: 0 }, { count: 20, rate: 5 }, { count: 50, rate: 10 }, { count: 100, rate: 15 }, { count: 150, rate: 20 }],
  earlyDays: 3, earlyRate: 10, weeklyGoal: 10000, weekStartsOn: 1, theme: "system",
};

export interface InventoryBatch {
  id: string;
  pickupDate: string | null;
  expiresOn: string | null;
  remaining: number;
  eligible: boolean;
}
export interface StockError { recordId: string; message: string }
export type EnrichedRecord = WorkRecord & {
  base: number;
  earlyBonus: number;
  countBonus: number;
  total: number;
  earlyCount: number;
  trackedCount: number;
  untrackedCount: number;
  stockAfter: number;
  expectedStock: number;
  discrepancy: number | null;
  applied: boolean;
  valid: boolean;
  errors: string[];
};
export interface DaySummary {
  date: string;
  pickupCount: number;
  refillCount: number;
  earlyCount: number;
  base: number;
  earlyBonus: number;
  countBonus: number;
  total: number;
  closingStock: number;
  regionCounts: Record<Area, number>;
  stocktakeCount: number;
  stocktakeDifference: number;
}
export interface Calculation {
  weekStart: string;
  thresholds: BonusTier[];
  total: number;
  base: number;
  earlyBonus: number;
  countBonus: number;
  pickupCount: number;
  refillCount: number;
  earlyCount: number;
  countRate: number;
  nextTier: (BonusTier & { remaining: number; bonusIncrease: number }) | null;
  days: DaySummary[];
  inventory: {
    total: number;
    eligibleCount: number;
    expiringToday: number;
    expiredCount: number;
    unknownAgeCount: number;
    batches: InventoryBatch[];
  };
  records: EnrichedRecord[];
  errors: StockError[];
}
export interface RewardProjection {
  additional: number;
  count: number;
  rate: number;
  total: number;
  difference: number;
  base: number;
  earlyBonus: number;
  countBonus: number;
}
export interface InventoryDay {
  date: string;
  pickupCount: number;
  refillCount: number;
  closingStock: number;
  stocktake: number | null;
  discrepancy: number | null;
  applied: boolean;
}

const DAY_MS = 86400000;
export const MAX_SIMULATION_ADDITIONAL = 100000;
export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
/** UTC is only an arithmetic container: DST cannot shift these civil dates. */
export function addDays(date: string, amount: number): string {
  return new Date(new Date(`${date}T12:00:00Z`).getTime() + amount * DAY_MS).toISOString().slice(0, 10);
}
export function weekStartFor(date: string, weekStartsOn: number = 1): string {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((weekday - weekStartsOn + 7) % 7));
}
export function todayLocal(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function byCreation(a: WorkRecord, b: WorkRecord): number {
  return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) || a.createdAt.localeCompare(b.createdAt);
}
function cleanTiers(tiers: BonusTier[]): BonusTier[] {
  return tiers.filter((tier) => Number.isSafeInteger(tier.count) && tier.count >= 0 && Number.isFinite(tier.rate) && tier.rate >= 0)
    .map((tier) => ({ ...tier })).sort((a, b) => a.count - b.count);
}
function tierRate(quantity: number, thresholds: BonusTier[]): number {
  return thresholds.reduce((rate, tier) => quantity >= tier.count ? tier.rate : rate, 0);
}
function emptyRegions(): Record<Area, number> { return { A: 0, B: 0, C: 0, D: 0, omitted: 0 }; }

/** The first saved snapshot owns its seven-day interval and its quantity tiers. */
export function createRewardSnapshot(date: string, area: Area, settings: Settings, records: WorkRecord[]): RewardSnapshot {
  let owner: (WorkRecord & { type: "refill"; snapshot: RewardSnapshot }) | undefined;
  for (const record of records) {
    if (record.type !== "refill" || !record.snapshot || !isValidDate(record.snapshot.weekStart)) continue;
    if (date < record.snapshot.weekStart || date > addDays(record.snapshot.weekStart, 6)) continue;
    if (!owner || byCreation(record, owner) < 0) owner = record as typeof owner;
  }
  return {
    regionRate: settings.regionRates[area], earlyRate: settings.earlyRate, earlyDays: settings.earlyDays,
    weekStart: owner?.snapshot.weekStart ?? weekStartFor(date, settings.weekStartsOn),
    thresholds: cleanTiers(owner?.snapshot.thresholds ?? settings.thresholds),
  };
}

/** Honor nearby frozen starts while retaining empty weeks during ordinary browsing. */
export function adjacentWeekStart(date: string, direction: -1 | 1, records: WorkRecord[], settings: Settings): string {
  let closest: string | undefined;
  for (const record of records) {
    if (record.type !== "refill" || !isValidDate(record.date)) continue;
    const anchor = record.snapshot?.weekStart ?? weekStartFor(record.date, settings.weekStartsOn);
    if (!isValidDate(anchor) || (direction === -1 ? anchor >= date : anchor <= date)) continue;
    if (!closest || (direction === -1 ? anchor > closest : anchor < closest)) closest = anchor;
  }
  if (closest && closest >= addDays(date, -13) && closest <= addDays(date, 13)) return closest;
  return addDays(date, direction * 7);
}

/**
 * Replay is linear after sorting. Refill-only manual entry is supported without
 * fabricated inventory or early eligibility. A stocktake is an observation until
 * applied explicitly; additions then have unknown ages. Snapshotless legacy data
 * uses current settings, while recorded snapshots preserve historical conditions.
 * weekStart is the explicit beginning of the requested seven-day display window.
 */
export function calculate(records: WorkRecord[], settings: Settings, weekStart: string, today: string): Calculation {
  const start = weekStart;
  const end = addDays(start, 6);
  const currentTiers = cleanTiers(settings.thresholds);
  const weekPolicies = new Map<string, BonusTier[]>();
  const dateOwners = new Map<string, string>();
  for (const record of [...records].sort(byCreation)) {
    if (record.type !== "refill" || !record.snapshot || !isValidDate(record.snapshot.weekStart)) continue;
    const anchor = record.snapshot.weekStart;
    if (!weekPolicies.has(anchor)) weekPolicies.set(anchor, cleanTiers(record.snapshot.thresholds));
    for (let offset = 0; offset < 7; offset++) {
      const date = addDays(anchor, offset);
      if (!dateOwners.has(date)) dateOwners.set(date, anchor);
    }
  }
  const selectedTiers = weekPolicies.get(start) ?? currentTiers;
  const batches: InventoryBatch[] = [];
  let fifoHead = 0;
  let stockCount = 0;
  const enriched: EnrichedRecord[] = [];
  const errors: StockError[] = [];
  const seenIds = new Set<string>();
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date) || byCreation(a, b));
  const effectiveSnapshots = new Map<EnrichedRecord, RewardSnapshot>();
  const receive = (quantity: number, id: string, pickupDate: string | null) => {
    // A later recorded pickup first clears the previously untracked inventory debt.
    const available = Math.max(0, quantity - Math.max(0, -stockCount));
    stockCount += quantity;
    if (available > 0) batches.push({
      id, pickupDate, expiresOn: pickupDate === null ? null : addDays(pickupDate, Math.max(1, settings.earlyDays) - 1),
      remaining: available, eligible: false,
    });
  };
  const consume = (quantity: number, date: string, earlyDays: number) => {
    let remaining = quantity;
    let earlyCount = 0;
    while (remaining > 0 && fifoHead < batches.length) {
      const batch = batches[fifoHead];
      const taken = Math.min(batch.remaining, remaining);
      batch.remaining -= taken;
      remaining -= taken;
      if (batch.pickupDate !== null && date <= addDays(batch.pickupDate, earlyDays - 1)) earlyCount += taken;
      if (batch.remaining === 0) fifoHead++;
    }
    stockCount -= quantity;
    return { earlyCount, trackedCount: quantity - remaining, untrackedCount: remaining };
  };

  for (const record of sorted) {
    const result: EnrichedRecord = {
      ...record, base: 0, earlyBonus: 0, countBonus: 0, total: 0, earlyCount: 0,
      trackedCount: 0, untrackedCount: 0, stockAfter: stockCount, expectedStock: stockCount,
      discrepancy: null, applied: false, valid: false, errors: [],
    };
    const issue = (message: string) => { result.errors.push(message); errors.push({ recordId: record.id, message }); };
    if (seenIds.has(record.id)) issue("記録の ID が重複しています。");
    seenIds.add(record.id);
    if (!isValidDate(record.date)) issue("日付が正しくありません。");
    else if (record.date > today) issue("未来の日付の記録は集計されません。");
    if (!Number.isSafeInteger(record.quantity) || record.quantity < (record.type === "adjustment" ? 0 : 1)) {
      issue(record.type === "adjustment" ? "在庫は 0 以上の整数で入力してください。" : "本数は 1 以上の整数で入力してください。");
    }
    if (!["pickup", "refill", "adjustment"].includes(record.type)) issue("記録の種類が正しくありません。");
    if (record.type === "refill" && !AREAS.includes(record.area)) issue("補充エリアを選択してください。");
    if (record.type === "refill" && !["auto", "manual"].includes(record.earlyMode)) issue("早期補充の計算方法を選択してください。");
    if (result.errors.length > 0) { enriched.push(result); continue; }
    result.valid = true;
    if (record.type === "pickup") {
      receive(record.quantity, record.id, record.date);
    } else if (record.type === "adjustment") {
      result.expectedStock = record.expectedStock ?? stockCount;
      result.discrepancy = record.difference ?? record.quantity - result.expectedStock;
      result.applied = record.applied === true;
      if (result.applied) {
        const difference = record.quantity - stockCount;
        if (difference < 0) consume(-difference, record.date, settings.earlyDays);
        if (difference > 0) receive(difference, record.id, null);
      }
    } else if (record.type === "refill") {
      const anchor = record.snapshot?.weekStart ?? dateOwners.get(record.date) ?? weekStartFor(record.date, settings.weekStartsOn);
      const snapshot: RewardSnapshot = record.snapshot ?? {
        regionRate: settings.regionRates[record.area], earlyRate: settings.earlyRate, earlyDays: settings.earlyDays,
        weekStart: anchor, thresholds: weekPolicies.get(anchor) ?? currentTiers,
      };
      effectiveSnapshots.set(result, snapshot);
      const consumed = consume(record.quantity, record.date, Math.max(1, snapshot.earlyDays));
      result.trackedCount = consumed.trackedCount;
      result.untrackedCount = consumed.untrackedCount;
      result.earlyCount = consumed.earlyCount;
      if (record.earlyMode === "manual") {
        const manual = record.manualEarly ?? 0;
        if (!Number.isSafeInteger(manual) || manual < 0 || manual > record.quantity) issue("早期補充の本数を 0 から補充本数の範囲で確認してください。");
        result.earlyCount = Number.isFinite(manual) ? Math.max(0, Math.min(record.quantity, Math.floor(manual))) : 0;
      }
      if (consumed.untrackedCount > 0) issue(`抜取の記録が ${consumed.untrackedCount} 本不足し、理論在庫は ${stockCount} 本です。${record.earlyMode === "auto" ? "不足分の早期ボーナスは自動判定できません。" : "抜取記録を確認してください。"}`);
      result.base = record.quantity * Math.max(0, snapshot.regionRate || 0);
      result.earlyBonus = result.earlyCount * Math.max(0, snapshot.earlyRate || 0);
    }
    result.stockAfter = stockCount;
    enriched.push(result);
  }

  const weekCounts = new Map<string, number>();
  for (const [record, snapshot] of effectiveSnapshots) weekCounts.set(snapshot.weekStart, (weekCounts.get(snapshot.weekStart) ?? 0) + record.quantity);
  for (const [record, snapshot] of effectiveSnapshots) {
    const thresholds = weekPolicies.get(snapshot.weekStart) ?? cleanTiers(snapshot.thresholds);
    record.countBonus = record.quantity * tierRate(weekCounts.get(snapshot.weekStart) ?? 0, thresholds);
    record.total = record.base + record.earlyBonus + record.countBonus;
  }
  const selected = enriched.filter((record) => record.valid && (record.type === "refill"
    ? effectiveSnapshots.get(record)?.weekStart === start : record.date >= start && record.date <= end));
  const refills = selected.filter((record) => record.type === "refill");
  const sum = (field: "quantity" | "base" | "earlyBonus" | "countBonus" | "total" | "earlyCount") => refills.reduce((value, record) => value + record[field], 0);
  const refillCount = sum("quantity");
  const countRate = tierRate(refillCount, selectedTiers);
  const next = selectedTiers.find((tier) => tier.count > refillCount && tier.rate > countRate);
  const days = Array.from({ length: 7 }, (_, index): DaySummary => {
    const date = addDays(start, index);
    const dayRecords = selected.filter((record) => record.date === date);
    const previous = enriched.filter((record) => record.valid && record.date <= date).at(-1);
    const regionCounts = emptyRegions();
    for (const record of dayRecords) if (record.type === "refill") regionCounts[record.area] += record.quantity;
    return {
      date, regionCounts,
      pickupCount: dayRecords.reduce((sum, record) => sum + (record.type === "pickup" ? record.quantity : 0), 0),
      refillCount: dayRecords.reduce((sum, record) => sum + (record.type === "refill" ? record.quantity : 0), 0),
      earlyCount: dayRecords.reduce((sum, record) => sum + record.earlyCount, 0),
      base: dayRecords.reduce((sum, record) => sum + record.base, 0),
      earlyBonus: dayRecords.reduce((sum, record) => sum + record.earlyBonus, 0),
      countBonus: dayRecords.reduce((sum, record) => sum + record.countBonus, 0),
      total: dayRecords.reduce((sum, record) => sum + record.total, 0), closingStock: previous?.stockAfter ?? 0,
      stocktakeCount: dayRecords.filter((record) => record.type === "adjustment").length,
      stocktakeDifference: dayRecords.reduce((sum, record) => sum + (record.discrepancy ?? 0), 0),
    };
  });
  const liveBatches = batches.slice(fifoHead).map((batch) => ({ ...batch, eligible: batch.expiresOn !== null && today <= batch.expiresOn }));
  return {
    weekStart: start, thresholds: cleanTiers(selectedTiers),
    total: sum("total"), base: sum("base"), earlyBonus: sum("earlyBonus"), countBonus: sum("countBonus"),
    pickupCount: selected.reduce((sum, record) => sum + (record.type === "pickup" ? record.quantity : 0), 0),
    refillCount, earlyCount: sum("earlyCount"), countRate,
    nextTier: next ? { ...next, remaining: next.count - refillCount, bonusIncrease: next.count * next.rate - refillCount * countRate } : null,
    days, records: enriched, errors,
    inventory: {
      total: stockCount,
      eligibleCount: liveBatches.reduce((sum, batch) => sum + (batch.eligible ? batch.remaining : 0), 0),
      expiringToday: liveBatches.reduce((sum, batch) => sum + (batch.expiresOn === today ? batch.remaining : 0), 0),
      expiredCount: liveBatches.reduce((sum, batch) => sum + (batch.expiresOn !== null && batch.expiresOn < today ? batch.remaining : 0), 0),
      unknownAgeCount: liveBatches.reduce((sum, batch) => sum + (batch.pickupDate === null ? batch.remaining : 0), 0), batches: liveBatches,
    },
  };
}

/** Preserves already-earned base/early amounts and reprices the whole week's quantity bonus. */
export function simulateAdditional(calculation: Calculation, settings: Settings, additional: number, area: Area = settings.defaultArea, early = true): RewardProjection {
  const added = Number.isFinite(additional) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(additional))) : 0;
  const count = calculation.refillCount + added;
  const rate = tierRate(count, calculation.thresholds);
  const base = calculation.base + added * settings.regionRates[area];
  const earlyBonus = calculation.earlyBonus + (early ? added * settings.earlyRate : 0);
  const countBonus = count * rate;
  const total = base + earlyBonus + countBonus;
  return { additional: added, count, rate, base, earlyBonus, countBonus, total, difference: total - calculation.total };
}
export function goalAdditional(calculation: Calculation, settings: Settings, goal: number, area: Area = settings.defaultArea, early = true): RewardProjection | null {
  if (!Number.isFinite(goal)) return null;
  for (let additional = 0; additional <= MAX_SIMULATION_ADDITIONAL; additional++) {
    const projection = simulateAdditional(calculation, settings, additional, area, early);
    if (projection.total >= goal) return projection;
  }
  return null;
}
export function tierProjections(calculation: Calculation, settings: Settings, area: Area = settings.defaultArea, early = true): (RewardProjection & { threshold: number; thresholdRate: number })[] {
  return calculation.thresholds.filter((tier) => tier.count > 0)
    .map((tier) => ({ ...simulateAdditional(calculation, settings, Math.max(0, tier.count - calculation.refillCount), area, early), threshold: tier.count, thresholdRate: tier.rate }));
}
export function inventoryDays(calculation: Calculation, today: string, count = 3): InventoryDay[] {
  const length = Math.max(1, Math.min(366, Math.floor(count) || 3));
  const valid = calculation.records.filter((record) => record.valid);
  return Array.from({ length }, (_, index) => {
    const date = addDays(today, index - length + 1);
    const records = valid.filter((record) => record.date === date);
    const closing = valid.filter((record) => record.date <= date).at(-1);
    const stocktake = records.filter((record) => record.type === "adjustment").at(-1);
    return {
      date,
      pickupCount: records.reduce((sum, record) => sum + (record.type === "pickup" ? record.quantity : 0), 0),
      refillCount: records.reduce((sum, record) => sum + (record.type === "refill" ? record.quantity : 0), 0),
      closingStock: closing?.stockAfter ?? 0, stocktake: stocktake?.quantity ?? null,
      discrepancy: stocktake?.discrepancy ?? null, applied: stocktake?.applied ?? false,
    };
  });
}

/** Opt-in example: Monday 3, Tuesday 5, Wednesday 10, Thursday 10, Friday 15. */
export function createDemoRecords(today: string): WorkRecord[] {
  const start = weekStartFor(today);
  const sampleTimestamp = (date: string, order: number) => new Date(new Date(`${date}T00:00:00+09:00`).getTime() + order).toISOString();
  const dayCount = Math.round((new Date(`${today}T12:00:00Z`).getTime() - new Date(`${start}T12:00:00Z`).getTime()) / DAY_MS) + 1;
  const records: WorkRecord[] = [];
  const agingDate = addDays(today, -2);
  let agedStock = 6;
  const daily = [3, 5, 10, 10, 15, 8, 10];
  for (let index = 0; index < dayCount; index++) {
    const date = addDays(start, index);
    const quantity = daily[index];
    if (date < agingDate) records.push({ id: `demo-pickup-${index}`, type: "pickup", date, quantity, createdAt: sampleTimestamp(date, 1), note: "サンプル記録" });
    else agedStock += quantity;
    records.push({ id: `demo-refill-${index}`, type: "refill", date, quantity, area: "A", earlyMode: "auto",
      snapshot: createRewardSnapshot(date, "A", defaultSettings, records),
      createdAt: sampleTimestamp(date, 2), note: index === dayCount - 1 ? "駅前エリアで補充" : "通勤途中に補充" });
  }
  records.push({ id: "demo-aging-stock", type: "pickup", date: agingDate, quantity: agedStock, createdAt: sampleTimestamp(agingDate, 0), note: "早期補充の対象在庫" });
  records.push({ id: "demo-fresh-stock", type: "pickup", date: today, quantity: 8, createdAt: sampleTimestamp(today, 3), note: "次の補充に向けて抜取" });
  return records;
}
