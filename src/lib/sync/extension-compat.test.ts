import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mergeSnapshots, normalizeSpotJobsItems } from "../../../browser-extension/lib/normalizer.js";
import { defaultSettings } from "../core";
import type { AppData } from "../storage";
import { mergeSpotJobsSnapshot, validateSpotJobsSnapshot } from "./import";

// background.js depends on chrome.* APIs, so read its version constant as text instead of importing it.
const extensionRoot = new URL("../../../browser-extension/", import.meta.url);
const backgroundSource = readFileSync(fileURLToPath(new URL("background.js", extensionRoot)), "utf8");
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("manifest.json", extensionRoot)), "utf8")) as { version: string };
const SOURCE_VERSION = /const\s+SOURCE_VERSION\s*=\s*"([^"]+)"/.exec(backgroundSource)?.[1];

function emptyData(): AppData {
  return { version: 2, records: [], settings: structuredClone(defaultSettings), lastArea: "omitted" };
}

// Fake official history items shaped like the SPOTJOBS completed-work API.
const officialItems = [
  { rounderWorkId: 900001, workType: "BATTERY_INSERT", endTime: "2026-09-17T11:41:25+09:00", score: "3", expectedReward: 180, spotDetail: { spotName: "テスト駅前店" }, isEarlyRefill: true },
  { rounderWorkId: "900002", workType: "BATTERY_EJECT", endTime: "2026-09-17 12:05:00", score: 4, spotDetail: { spotName: "テスト中央店" } },
  { rounderWorkId: "900003", workType: "BL_BATTERY_EJECT", endTime: 1_789_577_410, score: 1, spotName: "テスト公園店" },
  { rounderWorkId: "900004", workType: "UNKNOWN_WORK", endTime: "2026-09-17T13:00:00+09:00", score: 2 },
];

describe("Edge extension snapshot compatibility", () => {
  it("reads a SOURCE_VERSION that matches the extension manifest", () => {
    expect(SOURCE_VERSION).toMatch(/^spotlog-edge\/\d+\.\d+\.\d+$/);
    expect(SOURCE_VERSION).toBe(`spotlog-edge/${manifest.version}`);
  });

  it("accepts and imports the snapshot the current extension uploads", () => {
    const records = mergeSnapshots([], normalizeSpotJobsItems(officialItems));
    expect(records).toHaveLength(3);
    // Mirrors uploadSnapshot's plaintext; the JSON round-trip mirrors encrypt/decrypt transport.
    const plaintext = { version: 1, collectedAt: "2026-09-17T04:00:00.000Z", sourceVersion: SOURCE_VERSION, records };
    const transported: unknown = JSON.parse(JSON.stringify(plaintext));

    const validated = validateSpotJobsSnapshot(transported);
    expect(validated.sourceVersion).toBe(SOURCE_VERSION);
    expect(validated.records.map(record => record.workType).sort()).toEqual(["BATTERY_EJECT", "BATTERY_INSERT", "BL_BATTERY_EJECT"]);

    const result = mergeSpotJobsSnapshot(emptyData(), transported, "2026-09-17T05:00:00.000Z");
    expect(result).toMatchObject({ imported: 3, duplicates: 0, ignored: 0, needsReview: 1 });
    expect(result.data.records.map(record => record.id).sort()).toEqual(["spotjobs:900001", "spotjobs:900002", "spotjobs:900003"]);
    expect(result.data.records.find(record => record.id === "spotjobs:900001")).toMatchObject({ type: "refill", quantity: 3, earlyMode: "manual", manualEarly: 3 });
    expect(result.data.records.find(record => record.id === "spotjobs:900002")).toMatchObject({ type: "pickup", quantity: 4, note: "自動同期 · テスト中央店" });

    const again = mergeSpotJobsSnapshot(result.data, transported, "2026-09-17T06:00:00.000Z");
    expect(again).toMatchObject({ imported: 0, duplicates: 3 });
  });
});
