export const SUPPORTED_WORK_TYPES = Object.freeze({
  BATTERY_INSERT: "replenishment",
  BATTERY_EJECT: "pickup",
  BL_BATTERY_EJECT: "pickup"
});

function toIsoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  let candidate = value;
  if (typeof candidate === "number" && candidate < 1_000_000_000_000) {
    candidate *= 1_000;
  }
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (/^\d{10,13}$/u.test(trimmed)) {
      candidate = Number(trimmed);
      if (candidate < 1_000_000_000_000) candidate *= 1_000;
    } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(trimmed)) {
      candidate = `${trimmed.replace(" ", "T")}+09:00`;
    } else {
      candidate = trimmed;
    }
  }
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) return null;
  const earliest = Date.UTC(2020, 0, 1);
  const latest = Date.now() + 24 * 60 * 60 * 1000;
  if (date.getTime() < earliest || date.getTime() > latest) return null;
  return date.toISOString();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true") return true;
    if (value === 0 || value === "0" || value === "false") return false;
  }
  return null;
}

export function normalizeSpotJobsItem(item) {
  if (!item || typeof item !== "object") return null;
  const type = SUPPORTED_WORK_TYPES[item.workType];
  const externalId = String(item.rounderWorkId ?? "").trim();
  const completedAt = toIsoDate(item.endTime);
  const rawCount = finiteNumber(item.score);
  const quantity = rawCount === null ? null : Math.trunc(rawCount);
  if (
    !type ||
    !externalId ||
    !completedAt ||
    quantity === null ||
    quantity <= 0 ||
    quantity > 1_000
  ) {
    return null;
  }

  const estimatedRewardValue = finiteNumber(item.expectedReward);
  const estimatedReward =
    estimatedRewardValue !== null && estimatedRewardValue >= 0
      ? estimatedRewardValue
      : null;
  const earlyRefill =
    type === "replenishment"
      ? firstBoolean(
          item.earlyEligible,
          item.isEarlyEligible,
          item.earlyRefill,
          item.isEarlyRefill,
          item.batteryAdjustmentDetail?.earlyEligible,
          item.batteryAdjustmentDetail?.isEarlyRefill
        )
      : null;
  const storeName = String(
    item.spotDetail?.spotName ?? item.spotName ?? "店舗名未取得"
  ).trim();

  return {
    externalId,
    workType: item.workType,
    completedAt,
    quantity,
    storeName: storeName || "店舗名未取得",
    estimatedReward: estimatedReward === null ? undefined : estimatedReward,
    earlyRefill
  };
}

export function normalizeSpotJobsItems(items) {
  const byId = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeSpotJobsItem(item);
    if (normalized) byId.set(normalized.externalId, normalized);
  }
  const sorted = [...byId.values()].sort(
    (left, right) =>
      new Date(left.completedAt).getTime() - new Date(right.completedAt).getTime()
  );
  // The bridge is a rolling delivery inbox, not the long-term backup. Keeping
  // the newest 500 official jobs bounds encrypted storage while every imported
  // job remains in each device's IndexedDB/JSON backup.
  return sorted.slice(-500);
}

export function mergeSnapshots(existing, incoming) {
  const byId = new Map();
  for (const record of Array.isArray(existing) ? existing : []) {
    if (record?.externalId) byId.set(record.externalId, record);
  }
  for (const record of Array.isArray(incoming) ? incoming : []) {
    if (record?.externalId) byId.set(record.externalId, record);
  }
  const sorted = [...byId.values()].sort(
    (left, right) =>
      new Date(left.completedAt).getTime() - new Date(right.completedAt).getTime()
  );
  return sorted.slice(-500);
}
