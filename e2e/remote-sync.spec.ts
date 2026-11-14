import type { Page } from '@playwright/test';
import { deriveSyncCredentials, encryptSyncSnapshot, generateSyncCode } from '../src/lib/sync/protocol';
import { test, expect, boot, closeNotice, navigate, noHorizontalOverflow, pickup } from './helpers';

test.use({ serviceWorkers: 'block' });

async function setupBridge(page: Page) {
  const syncCode = generateSyncCode();
  const credentials = await deriveSyncCredentials(syncCode);
  const source = 'https://spotjobs-reward-inventory-sync.vercel.app/api/v1';
  const state = { status: 'pending', posts: 0, freshReads: 0, fail: false };
  const request = { requestId: 'e71f0f26-ddb7-4bd6-905c-dc229a12da03', requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const collectedAt = new Date().toISOString();
  const old = await encryptSyncSnapshot({ version: 1, sourceVersion: 'spotlog-edge/0.1.0', collectedAt, records: [] }, credentials);
  const fresh = await encryptSyncSnapshot({ version: 1, sourceVersion: 'spotlog-edge/0.2.0', collectedAt, records: [{
    externalId: 'remote-refresh-pickup', workType: 'BATTERY_EJECT', completedAt: collectedAt, quantity: 5, storeName: '合成テスト店舗', earlyRefill: null,
  }] }, credentials);
  await page.addInitScript(code => localStorage.setItem('spotlog-sync-preferences-v1', JSON.stringify({ enabled: true, syncCode: code })), syncCode);
  await page.route(`${source}/snapshot/${credentials.channelId}`, async route => {
    const updated = state.status === 'succeeded';
    if (updated) state.freshReads++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      envelope: updated ? fresh : old, storedAt: updated ? new Date().toISOString() : new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }) });
  });
  await page.route(`${source}/refresh/${credentials.channelId}**`, async route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${credentials.bearerToken}`);
    expect(route.request().url()).not.toContain(syncCode);
    if (route.request().method() === 'POST') state.posts++;
    else expect(new URL(route.request().url()).searchParams.get('requestId')).toBe(request.requestId);
    const status = state.fail ? 'failed' : state.status;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...request, status, ...(status === 'succeeded' || status === 'failed' ? { completedAt: new Date().toISOString() } : {}), ...(state.fail ? { errorCode: 'page_required' } : {}),
    }) });
  });
  await boot(page);
  await expect(page.locator('.home-sync')).toContainText('PC取得済みの履歴を確認しました');
  await closeNotice(page);
  return state;
}

test('home one-tap sync requests PC, shows progress, and preserves entries made while waiting', async ({ page }, testInfo) => {
  const state = await setupBridge(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const home = page.locator('.home-sync');
  const sync = home.getByRole('button', { name: '今すぐ同期', exact: true });
  const box = await sync.boundingBox();
  expect(box?.y).toBeLessThan(400);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await sync.click();
  await expect(home).toContainText('PCの応答を待っています');
  await expect(home.getByRole('button', { name: '同期中…', exact: true })).toBeDisabled();
  expect(state.posts).toBe(1);
  expect(state.freshReads).toBe(0);
  state.status = 'running';
  await expect(home).toContainText('PCでSPOTJOBSから取得中');
  await noHorizontalOverflow(page);
  await pickup(page, 1);
  state.status = 'succeeded';
  await expect(page.locator('.toast')).toContainText('1件を自動取り込みしました');
  await closeNotice(page);
  await navigate(page, 'ホーム');
  await expect(page.locator('.stock-stat strong')).toHaveText('6本');
  await expect(home.getByRole('button', { name: '今すぐ同期', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('home-sync.png'), animations: 'disabled' });
  await navigate(page, '履歴');
  await expect(page.locator('.record-row')).toHaveCount(2);
  await navigate(page, '設定');
  await page.locator('.auto-sync-panel').getByRole('button', { name: '今すぐ同期', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('PCから最新の履歴を取得し、反映しました');
  expect(state.posts).toBe(2);
});

test('PC unavailable keeps local data and gives actionable status instead of false success', async ({ page }) => {
  const state = await setupBridge(page);
  state.fail = true;
  await page.locator('.home-sync').getByRole('button', { name: '今すぐ同期', exact: true }).click();
  await expect(page.locator('.home-sync-message')).toContainText('ジョブ履歴');
  await expect(page.locator('.home-sync-message')).toHaveClass(/danger/);
  expect(state.freshReads).toBe(0);
  await expect(page.locator('.stock-stat strong')).toHaveText('0本');
  await expect(page.locator('.home-sync').getByRole('button', { name: '今すぐ同期', exact: true })).toBeEnabled();
  await noHorizontalOverflow(page);
});

test('home sync guides unpaired devices to setup and disables while offline', async ({ page, context }) => {
  await boot(page);
  await page.locator('.home-sync').getByRole('button', { name: '今すぐ同期', exact: true }).click();
  await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible();
  await setupBridge(page);
  await context.setOffline(true);
  await expect(page.locator('.home-sync').getByRole('button', { name: '今すぐ同期', exact: true })).toBeDisabled();
  await expect(page.locator('.home-sync')).toContainText('オフラインです');
  await context.setOffline(false);
});
