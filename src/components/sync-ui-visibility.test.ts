import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isSyncEnabled } from "../lib/sync/feature";
import HomeSyncAction from "./sync-action";
import SyncPanel from "./sync-panel";
import { HomeView } from "./work-views";
import { calculate, createRewardSnapshot, defaultSettings, type WorkRecord } from "../lib/core";

const SYNC_UI_COPY = /同期コード|今すぐ同期|PCの履歴を同期|自動取り込み|自動同期/;

describe("public build hides personal sync UI", () => {
  it("keeps the sync feature flag off by default", () => {
    expect(process.env.NEXT_PUBLIC_ENABLE_SYNC).toBeUndefined();
    expect(isSyncEnabled()).toBe(false);
  });

  it("renders no home or settings sync controls when the flag is off", () => {
    const home = renderToStaticMarkup(createElement(HomeSyncAction, {
      preferences: { enabled: true, syncCode: "dummy-code-should-not-appear" },
      online: true,
      demo: false,
      syncing: false,
      saving: false,
      phase: "pulling",
      onSync() {},
      onSetup() {},
    }));
    const panel = renderToStaticMarkup(createElement(SyncPanel, {
      preferences: { enabled: true, syncCode: "dummy-code-should-not-appear" },
      online: true,
      demo: false,
      syncing: false,
      syncPhase: "pulling",
      reviewCount: 2,
      recordsSaving: false,
      onReviewAll: async () => {},
      hasExistingRecords: true,
      incomingSyncCode: "dummy-code-should-not-appear",
      onConfigure: async () => {},
      onBackfill: async () => {},
      onToggle: async () => {},
      onSync: async () => {},
      onDisconnect: async () => {},
      onReview() {},
    }));

    expect(home).toBe("");
    expect(panel).toBe("");
    expect(home).not.toMatch(SYNC_UI_COPY);
    expect(panel).not.toMatch(SYNC_UI_COPY);
  });

  it("shows the manual-entry welcome on an empty home, not the PC sync CTA", () => {
    const today = "2026-11-18";
    const settings = structuredClone(defaultSettings);
    const records: WorkRecord[] = [];
    const week = createRewardSnapshot(today, settings.defaultArea, settings, records).weekStart;
    const summary = calculate(records, settings, week, today);
    const html = renderToStaticMarkup(createElement(HomeView, {
      summary,
      settings,
      today,
      week,
      currentWeek: week,
      onWeek() {},
      onView() {},
      onInventoryEdit() {},
      onShare() {},
      onDemo() {},
      empty: true,
    }));

    expect(html).toContain("今日の1本から、はじめよう。");
    expect(html).toContain("デモデータで試す");
    expect(html).not.toMatch(SYNC_UI_COPY);
    expect(html).not.toContain("PCの履歴をこの端末へ");
    expect(html).not.toContain("PCの履歴を同期する");
  });
});
