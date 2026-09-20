import { describe, expect, it } from "vitest";
import { calculate, defaultSettings, type WorkRecord } from "./core";
import { buildPerformanceShareText, CANONICAL_APP_URL, createXShareUrl, X_WEB_INTENT_URL } from "./share";

const weekStart = "2026-09-14";
const today = "2026-09-17";
const records: WorkRecord[] = [
  {
    id: "pickup",
    type: "pickup",
    date: today,
    quantity: 60,
    createdAt: `${today}T08:00:00+09:00`,
    note: "共有してはいけない店舗名",
  },
  {
    id: "refill",
    type: "refill",
    date: today,
    quantity: 54,
    area: "A",
    earlyMode: "manual",
    manualEarly: 54,
    createdAt: `${today}T09:00:00+09:00`,
    note: "共有してはいけないメモ",
  },
];
const summary = calculate(records, defaultSettings, weekStart, today);

describe("performance sharing", () => {
  it("formats today's aggregate without leaking record details", () => {
    const text = buildPerformanceShareText({ scope: "today", summary, today });

    expect(text).toBe([
      "今日のSPOTJOBS成績（2026/9/17）",
      "補充 54本・取出 60本",
      "早期補充 54本",
      "見込み報酬 4,050円",
      "#SPOTJOBS記録 #SPOTJOBS",
    ].join("\n"));
    expect(text).not.toContain("店舗名");
    expect(text).not.toContain("メモ");
  });

  it("formats the seven-day aggregate and next tier", () => {
    expect(buildPerformanceShareText({ scope: "week", summary, today })).toBe([
      "1週間のSPOTJOBS成績（2026/9/14〜9/20）",
      "補充 54本・取出 60本",
      "早期補充 54本",
      "見込み報酬 4,050円",
      "次の本数ボーナスまであと46本（+15円/本）",
      "#SPOTJOBS記録 #SPOTJOBS",
    ].join("\n"));
  });

  it("marks demo results and handles a day outside the supplied week safely", () => {
    const text = buildPerformanceShareText({ scope: "today", summary, today: "2026-09-21", demo: true });
    expect(text).toContain("【デモ】今日のSPOTJOBS成績");
    expect(text).toContain("補充 0本・取出 0本");
    expect(text).toContain("見込み報酬 0円");
  });

  it("creates an encoded X Web Intent with the canonical app URL", () => {
    const text = buildPerformanceShareText({ scope: "week", summary, today });
    const shareUrl = createXShareUrl(text);
    const parsed = new URL(shareUrl);

    expect(`${parsed.origin}${parsed.pathname}`).toBe(X_WEB_INTENT_URL);
    expect(parsed.searchParams.get("text")).toBe(text);
    expect(parsed.searchParams.get("url")).toBe(CANONICAL_APP_URL);
    expect(shareUrl).toContain("%0A");
    expect(shareUrl).not.toContain("共有してはいけない");
  });
});
