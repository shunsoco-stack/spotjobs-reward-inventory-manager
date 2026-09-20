import { addDays, type Calculation, type DaySummary } from "./core";

export type PerformanceShareScope = "today" | "week";

export const CANONICAL_APP_URL = "https://spotjobs-reward-inventory-manager.vercel.app/";
export const X_WEB_INTENT_URL = "https://x.com/intent/tweet";

export interface PerformanceShareOptions {
  scope: PerformanceShareScope;
  summary: Calculation;
  today: string;
  demo?: boolean;
}

const emptyDay = (date: string): Pick<DaySummary, "date" | "pickupCount" | "refillCount" | "earlyCount" | "total"> => ({
  date,
  pickupCount: 0,
  refillCount: 0,
  earlyCount: 0,
  total: 0,
});

function displayDate(date: string, includeYear = true): string {
  const [year, month, day] = date.split("-").map(Number);
  return includeYear ? `${year}/${month}/${day}` : `${month}/${day}`;
}

function countLine(refillCount: number, pickupCount: number): string {
  return `補充 ${refillCount}本・取出 ${pickupCount}本`;
}

/**
 * Formats aggregate-only performance text for sharing. Store names, notes and
 * individual records are deliberately excluded from this boundary.
 */
export function buildPerformanceShareText({ scope, summary, today, demo = false }: PerformanceShareOptions): string {
  const demoPrefix = demo ? "【デモ】" : "";

  if (scope === "today") {
    const day = summary.days.find((item) => item.date === today) ?? emptyDay(today);
    return [
      `${demoPrefix}今日のSPOTJOBS成績（${displayDate(today)}）`,
      countLine(day.refillCount, day.pickupCount),
      `早期補充 ${day.earlyCount}本`,
      `見込み報酬 ${day.total.toLocaleString("ja-JP")}円`,
      "個人制作の非公式管理ツール",
      "#SPOTJOBS記録",
    ].join("\n");
  }

  const weekEnd = addDays(summary.weekStart, 6);
  const tierLine = summary.nextTier
    ? `次の本数ボーナスまであと${summary.nextTier.remaining}本（+${summary.nextTier.rate}円/本）`
    : `週間ボーナス +${summary.countRate}円/本`;
  return [
    `${demoPrefix}1週間のSPOTJOBS成績（${displayDate(summary.weekStart)}〜${displayDate(weekEnd, false)}）`,
    countLine(summary.refillCount, summary.pickupCount),
    `早期補充 ${summary.earlyCount}本`,
    `見込み報酬 ${summary.total.toLocaleString("ja-JP")}円`,
    tierLine,
    "個人制作の非公式管理ツール",
    "#SPOTJOBS記録",
  ].join("\n");
}

/** Builds an X Web Intent without opening a window or transmitting data. */
export function createXShareUrl(text: string, appUrl = CANONICAL_APP_URL): string {
  const intent = new URL(X_WEB_INTENT_URL);
  intent.searchParams.set("text", text);
  intent.searchParams.set("url", appUrl);
  return intent.toString();
}
