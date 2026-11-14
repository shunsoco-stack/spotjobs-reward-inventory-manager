import { deriveSyncCredentials, encryptSyncSnapshot, generateSyncCode } from '../src/lib/sync/protocol';
import { test, expect, boot, closeNotice, jstDate, navigate, noHorizontalOverflow, pickup } from './helpers';

// Playwright cannot route requests initiated through an active Service Worker.
// Offline behavior has dedicated coverage; this spec isolates the bridge flow.
test.use({ serviceWorkers: 'block' });

test('encrypted SPOTJOBS sync imports once, clears review, and honors delete tombstones', async ({ page }) => {
  const syncCode = generateSyncCode();
  const credentials = await deriveSyncCredentials(syncCode);
  const date = jstDate();
  const collectedAt = new Date(`${date}T12:00:00+09:00`).toISOString();
  const snapshot = {
    version: 1 as const,
    collectedAt,
    sourceVersion: 'spotlog-edge/0.1.0' as const,
    records: [
      {
        externalId: 'official-pickup-1',
        workType: 'BATTERY_EJECT' as const,
        completedAt: new Date(`${date}T09:00:00+09:00`).toISOString(),
        quantity: 2,
        storeName: '同期テスト取出店',
        earlyRefill: null,
      },
      {
        externalId: 'official-refill-1',
        workType: 'BATTERY_INSERT' as const,
        completedAt: new Date(`${date}T10:00:00+09:00`).toISOString(),
        quantity: 1,
        storeName: '同期テスト補充店',
        estimatedReward: 65,
        earlyRefill: true,
      },
    ],
  };
  const envelope = await encryptSyncSnapshot(snapshot, credentials);
  await page.route(`https://spotjobs-reward-inventory-sync.vercel.app/api/v1/refresh/${credentials.channelId}`, async route => {
    const requestedAt = new Date().toISOString();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ requestId: 'e71f0f26-ddb7-4bd6-905c-dc229a12da03', requestedAt, expiresAt: new Date(Date.now() + 120_000).toISOString(), status: 'succeeded', completedAt: requestedAt }) });
  });
  let pulls = 0;
  await page.route(`https://spotjobs-reward-inventory-sync.vercel.app/api/v1/snapshot/${credentials.channelId}`, async route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${credentials.bearerToken}`);
    pulls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': 'http://localhost:3059',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Vary': 'Origin',
      },
      body: JSON.stringify({
        envelope,
        storedAt: new Date().toISOString(),
        expiresAt: new Date(new Date(`${date}T12:01:00+09:00`).getTime() + 90 * 86_400_000).toISOString(),
      }),
    });
  });

  await boot(page);
  await navigate(page, '設定');
  await page.setViewportSize({ width: 320, height: 844 });
  await noHorizontalOverflow(page);
  const panel = page.locator('.auto-sync-panel');
  await expect(panel.getByRole('heading', { name: 'SPOTJOBS自動取り込み', exact: true })).toBeVisible();
  await panel.getByLabel('同期コード', { exact: true }).fill(syncCode);
  await panel.getByRole('button', { name: 'このコードで接続', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('2件を自動取り込みしました');
  await expect(panel.getByText('自動同期 ON', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: /補充 1件の地域・早期対象を確認/ })).toBeVisible();
  const devicePairing = panel.locator('.sync-device-pairing');
  await devicePairing.getByText('スマホ・別端末を接続', { exact: true }).click();
  const qrCanvas = devicePairing.locator('canvas[aria-label="スマホ接続用QRコード"]');
  await expect(qrCanvas).toBeVisible();
  await expect.poll(() => qrCanvas.evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0);
  await noHorizontalOverflow(page);
  await closeNotice(page);

  await panel.getByRole('button', { name: /補充 1件の地域・早期対象を確認/ }).click();
  await expect(page.getByRole('heading', { name: '履歴', exact: true })).toBeVisible();
  await expect(page.locator('.record-row')).toHaveCount(2);
  await expect(page.locator('.record-list')).toContainText('自動同期 · 同期テスト補充店');
  await page.locator('.record-row').filter({ hasText: '補充' }).click();
  const editor = page.getByRole('dialog', { name: '記録を編集', exact: true });
  await editor.getByRole('button', { name: '変更を保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await closeNotice(page);
  await navigate(page, '設定');
  await expect(panel.getByRole('button', { name: /地域・早期対象を確認/ })).toHaveCount(0);

  await navigate(page, '履歴');
  await page.locator('.record-row').filter({ hasText: '補充' }).click();
  await editor.getByRole('button', { name: 'この記録を削除', exact: true }).click();
  await editor.getByRole('button', { name: '削除する', exact: true }).click();
  await expect(page.locator('.record-row')).toHaveCount(1);
  await closeNotice(page);
  await navigate(page, '設定');
  await panel.getByRole('button', { name: '今すぐ同期', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('PCから最新の履歴を取得し、反映しました');
  await closeNotice(page);
  await navigate(page, '履歴');
  await expect(page.locator('.record-row')).toHaveCount(1);
  expect(pulls).toBeGreaterThanOrEqual(2);
});

test('mobile pairing strips the secret fragment, requires an import range, and can backfill older history', async ({ page }) => {
  const syncCode = generateSyncCode();
  const credentials = await deriveSyncCredentials(syncCode);
  const collectedAt = new Date().toISOString();
  const historicalCompletedAt = new Date(Date.now() - 86_400_000).toISOString();
  const snapshot = {
    version: 1 as const,
    collectedAt,
    sourceVersion: 'spotlog-edge/0.1.0' as const,
    records: [{
      externalId: 'mobile-pairing-pickup-1',
      workType: 'BATTERY_EJECT' as const,
      completedAt: historicalCompletedAt,
      quantity: 2,
      storeName: 'モバイル接続テスト店',
      earlyRefill: null,
    }],
  };
  const envelope = await encryptSyncSnapshot(snapshot, credentials);
  await page.route(`https://spotjobs-reward-inventory-sync.vercel.app/api/v1/snapshot/${credentials.channelId}`, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': 'http://localhost:3059',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Vary': 'Origin',
      },
      body: JSON.stringify({
        envelope,
        storedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      }),
    });
  });

  await boot(page);
  await pickup(page, 1);
  await page.goto(`/#spotjobs-sync=${syncCode}`);
  await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  expect(page.url()).not.toContain(syncCode);

  const panel = page.locator('.auto-sync-panel');
  await expect(panel.getByText('スマホ接続コードを受け取りました', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('同期コード', { exact: true })).toHaveValue(syncCode);
  const connect = panel.getByRole('button', { name: 'このコードで接続', exact: true });
  await expect(connect).toBeDisabled();
  await panel.getByRole('radio', { name: /今後の履歴だけ/ }).check();
  await expect(connect).toBeEnabled();
  await connect.click();
  await expect(panel.getByText('現在は今後の履歴だけを同期', { exact: true })).toBeVisible();
  await navigate(page, '履歴');
  await expect(page.locator('.record-row')).toHaveCount(1);

  await navigate(page, '設定');
  await panel.getByRole('button', { name: '過去履歴も取り込む', exact: true }).click();
  const confirmation = panel.locator('.sync-backfill-confirm');
  await expect(confirmation).toContainText('手入力した同じ作業がある場合は重複する可能性があります');
  await confirmation.getByRole('button', { name: '過去履歴を取り込む', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('1件を自動取り込みしました');
  await closeNotice(page);
  await navigate(page, '履歴');
  await expect(page.locator('.record-row')).toHaveCount(2);
});
