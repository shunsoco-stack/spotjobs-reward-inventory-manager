import { test, expect, boot, navigate, pickup, noHorizontalOverflow } from '../e2e/helpers';

test('release keeps personal sync hidden and makes no sync requests, including with saved preferences', async ({ page }) => {
  const syncRequests: string[] = [];
  await page.route('https://spotjobs-reward-inventory-sync.vercel.app/**', async route => {
    syncRequests.push(route.request().url());
    await route.fulfill({ status: 503, body: 'Unexpected sync request in release build' });
  });
  // A previous personal build's saved opt-in must not enable release sync.
  await page.addInitScript(() => localStorage.setItem('spotlog-sync-preferences-v1', JSON.stringify({ enabled: true, syncCode: 'e2e-disabled-sync' })));
  await boot(page);
  await expect(page.getByText('今日の1本から、はじめよう。', { exact: true })).toBeVisible();
  await expect(page.locator('.home-sync')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'PCの履歴をこの端末へ', exact: true })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await navigate(page, '設定');
  await expect(page.locator('.auto-sync-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'バックアップを保存（JSON）', exact: true })).toBeVisible();
  await pickup(page, 1);
  await page.reload();
  await expect(page.locator('.stock-stat strong')).toHaveText('1本');
  await expect(page.locator('.home-sync')).toHaveCount(0);
  expect(syncRequests).toEqual([]);
});
