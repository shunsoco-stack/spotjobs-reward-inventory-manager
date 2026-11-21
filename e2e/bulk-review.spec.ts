import { defaultSettings } from '../src/lib/core';
import { mergeSpotJobsSnapshot } from '../src/lib/sync/import';
import { generateSyncCode } from '../src/lib/sync/protocol';
import { type AppData, DATABASE_NAME } from '../src/lib/storage';
import { test, expect, boot, closeNotice, jstDate, navigate, noHorizontalOverflow } from './helpers';

test('bulk refill review confirms the count, allows cancellation, and preserves saved history', async ({ page }) => {
  const date = jstDate();
  const completedAt = new Date(`${date}T10:00:00+09:00`).toISOString();
  const data = mergeSpotJobsSnapshot({ version: 2, records: [], settings: structuredClone(defaultSettings), lastArea: 'omitted' }, {
    version: 1, collectedAt: completedAt, sourceVersion: 'spotlog-edge/0.3.0',
    records: [
      { externalId: 'bulk-pickup', workType: 'BATTERY_EJECT', completedAt, quantity: 5, storeName: '取出店', earlyRefill: null },
      { externalId: 'bulk-refill-1', workType: 'BATTERY_INSERT', completedAt, quantity: 2, storeName: '補充店1', earlyRefill: true },
      { externalId: 'bulk-refill-2', workType: 'BATTERY_INSERT', completedAt, quantity: 1, storeName: '補充店2', earlyRefill: null },
    ],
  }).data;
  await boot(page);
  await page.evaluate(async ({ data, databaseName, syncCode }) => {
    localStorage.setItem('spotlog-sync-preferences-v1', JSON.stringify({ enabled: false, syncCode, lastStatus: 'success', lastMessage: '3件を自動取り込みしました（要確認 2件）' }));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('app', 'readwrite');
        tx.objectStore('app').put(data, 'current');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }, { data, databaseName: DATABASE_NAME, syncCode: generateSyncCode() });
  await page.reload();
  await navigate(page, '設定');
  const panel = page.locator('.auto-sync-panel');
  const bulk = panel.getByRole('button', { name: '補充をまとめて確認済みにする', exact: true });
  await expect(bulk).toBeVisible();
  await expect(panel).toContainText('要確認 2件');
  await noHorizontalOverflow(page);

  const cancelled = page.waitForEvent('dialog').then(async dialog => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('補充 2件');
    expect(dialog.message()).toContain('地域・早期対象の値は変わりません');
    expect(dialog.message()).toContain('あとから履歴で個別に修正できます');
    await dialog.dismiss();
  });
  await bulk.click();
  await cancelled;
  await expect(panel).toContainText('要確認 2件');
  await expect(bulk).toBeEnabled();

  const readData = () => page.evaluate(async databaseName => new Promise<AppData>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('app', 'readonly').objectStore('app').get('current');
      read.onsuccess = () => { db.close(); resolve(read.result as AppData); };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  }), DATABASE_NAME);
  expect(await readData()).toEqual(data);

  const accepted = page.waitForEvent('dialog').then(async dialog => {
    expect(dialog.message()).toContain('補充 2件');
    await dialog.accept();
  });
  await bulk.click();
  await accepted;
  await expect(page.getByRole('status')).toContainText('補充 2件を確認済みにしました');
  await expect(bulk).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /地域・早期対象を確認/ })).toHaveCount(0);
  await expect(panel).not.toContainText('要確認');
  const expected = structuredClone(data);
  expected.sync!.recordSources.forEach(source => { source.needsReview = false; });
  expect(await readData()).toEqual(expected);
  await closeNotice(page);
  await navigate(page, '履歴');
  await expect(page.locator('.record-row')).toHaveCount(3);
  await expect(page.locator('.record-list')).toContainText('補充店1');
  await expect(page.locator('.record-list')).toContainText('補充店2');
  await page.reload();
  await navigate(page, '設定');
  await expect(bulk).toHaveCount(0);
  await expect(panel).not.toContainText('要確認');
  await navigate(page, 'ホーム');
  await expect(page.locator('.home-sync')).not.toContainText('要確認');
});
