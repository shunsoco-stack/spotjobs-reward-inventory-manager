import { test, expect, boot, chooseFile, closeNotice, downloadText, homeTotals, inventoryView, jstDate, navigate, noHorizontalOverflow, pickup, refill, seedReferenceThroughUI, simulatorView } from './helpers';

test('fresh dashboard, explicit demo separation, and responsive screens', async ({ page }) => {
  await boot(page);
  await expect(page.locator('.hero-amount')).toHaveText('¥0');
  await expect(page.getByRole('heading', { name: '今日の1本から、はじめよう。' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: 'デモデータで試す', exact: true }).click();
  await expect(page.getByText('デモデータでお試し中', { exact: true })).toBeVisible();
  await expect(page.locator('.hero-amount')).not.toHaveText('¥0');
  await page.locator('.demo-banner').getByRole('button', { name: '終了', exact: true }).click();
  await homeTotals(page, 0, 0);
  await closeNotice(page);

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await noHorizontalOverflow(page);
    await navigate(page, '補充');
    await expect(page.getByRole('textbox', { name: '本数', exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.getByLabel('作業日', { exact: false }).fill('');
    await expect(page.getByRole('button', { name: /本を補充として保存$/ })).toBeDisabled();
    await navigate(page, 'ホーム');
    await inventoryView(page);
    await noHorizontalOverflow(page);
    await simulatorView(page);
    await noHorizontalOverflow(page);
    await navigate(page, '設定');
    await noHorizontalOverflow(page);
    await navigate(page, 'ホーム');
  }
});

test('reference rewards, simulator, editing, delete undo, stocktake, snapshots and themes', async ({ page }) => {
  await boot(page);
  await seedReferenceThroughUI(page);
  await expect(page.locator('.next-tier .pill')).toContainText('＋10円');
  await expect(page.locator('.next-tier .next-number')).toContainText('46');
  await simulatorView(page);
  await expect(page.locator('.result-amount')).toHaveText('¥5,550');
  await expect(page.locator('.goal-panel .next-number')).toContainText('71');
  await expect(page.locator('.tier-list')).toContainText('達成済み');
  await expect(page.locator('.tier-list')).toContainText('20本');

  await test.step('edit and delete recalculate; undo restores the deleted record', async () => {
    await navigate(page, '履歴');
    await page.locator('.record-row').filter({ hasText: '補充' }).first().click();
    let editor = page.getByRole('dialog', { name: '記録を編集', exact: true });
    await editor.getByRole('textbox', { name: '本数', exact: true }).fill('50');
    await editor.getByRole('button', { name: 'すべて対象', exact: true }).click();
    await editor.getByRole('button', { name: '変更を保存', exact: true }).click();
    await expect(editor).not.toBeVisible();
    await homeTotals(page, 3750, 10);
    await navigate(page, '履歴');
    await page.locator('.record-row').filter({ hasText: '補充' }).first().click();
    editor = page.getByRole('dialog', { name: '記録を編集', exact: true });
    await editor.getByRole('button', { name: 'この記録を削除', exact: true }).click();
    await editor.getByRole('button', { name: '削除する', exact: true }).click();
    await expect(page.locator('.record-row')).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(page.locator('.record-row')).toHaveCount(2);
    await homeTotals(page, 3750, 10);
    await navigate(page, '履歴');
    await page.locator('.record-row').filter({ hasText: '補充' }).first().click();
    editor = page.getByRole('dialog', { name: '記録を編集', exact: true });
    await editor.getByRole('textbox', { name: '本数', exact: true }).fill('54');
    await editor.getByRole('button', { name: 'すべて対象', exact: true }).click();
    await editor.getByRole('button', { name: '変更を保存', exact: true }).click();
    await expect(editor).not.toBeVisible();
    await closeNotice(page);
    await homeTotals(page, 4050, 6);
  });

  await test.step('stocktake remains an observation until explicitly confirmed', async () => {
    await inventoryView(page);
    await page.getByRole('button', { name: '棚卸を記録する', exact: true }).click();
    const stocktake = page.getByRole('dialog', { name: '棚卸', exact: true });
    await stocktake.getByRole('textbox', { name: '本数', exact: true }).fill('4');
    await expect(stocktake.locator('.stocktake-preview')).toContainText('-2');
    await stocktake.getByRole('button', { name: '4本を棚卸として保存', exact: true }).click();
    await expect(stocktake).not.toBeVisible();
    await expect(page.locator('.inventory-count')).toHaveText('6本');
    await page.locator('.stocktake-list button').first().click();
    const editor = page.getByRole('dialog', { name: '記録を編集', exact: true });
    await editor.getByRole('checkbox', { name: '棚卸数を在庫に反映する' }).check();
    await editor.getByRole('button', { name: '変更を保存', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '棚卸数を在庫に反映しますか？', exact: true });
    await expect(confirmation).toContainText('6本 → 4本');
    await confirmation.getByRole('button', { name: '確認して反映する', exact: true }).click();
    await expect(editor).not.toBeVisible();
    await expect(page.locator('.inventory-count')).toHaveText('4本');
    await expect(page.locator('.stocktake-list')).toContainText('在庫へ反映済み');
    await closeNotice(page);
  });

  await test.step('saved rates remain frozen while new records use changed rates', async () => {
    await navigate(page, '設定');
    await page.locator('#region-rate-A').fill('100');
    await page.getByRole('button', { name: '設定を保存する', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('設定を保存しました');
    await closeNotice(page);
    await homeTotals(page, 4050, 4);
    await refill(page, 1, '対象外');
    await homeTotals(page, 4160, 3);
    await navigate(page, '履歴');
    await expect(page.locator('.record-row').filter({ hasText: '補充' }).first()).toContainText('¥110');
  });

  await test.step('dark and device themes survive reload and follow system appearance', async () => {
    await navigate(page, '設定');
    await page.getByRole('button', { name: 'ダーク', exact: true }).click();
    await page.getByRole('button', { name: '設定を保存する', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'ホーム', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await homeTotals(page, 4160, 3);
    await navigate(page, '設定');
    await page.getByRole('button', { name: '端末に合わせる', exact: true }).click();
    await page.getByRole('button', { name: '設定を保存する', exact: true }).click();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await noHorizontalOverflow(page);
  });
});

test('JSON downloads and confirmed restore, UTF-8 CSV preview and invalid-row protection', async ({ page }, testInfo) => {
  await boot(page);
  await seedReferenceThroughUI(page);
  await navigate(page, '設定');
  const backup = await downloadText(page, 'バックアップを保存（JSON）', testInfo, 'backup.json');
  const json = JSON.parse(backup.text);
  expect(json.format).toBe('spotjobs-backup');
  expect(json.data.version).toBe(2);
  expect(json.data.records).toHaveLength(2);
  expect(Number.isNaN(Date.parse(json.exportedAt))).toBe(false);
  for (const record of json.data.records) expect(Number.isNaN(Date.parse(record.createdAt))).toBe(false);
  expect(json.data.records.find((record: { type: string }) => record.type === 'refill').snapshot.regionRate).toBe(55);
  await closeNotice(page);
  await pickup(page, 2);
  await homeTotals(page, 4050, 8);
  await navigate(page, '設定');
  await chooseFile(page, 'バックアップを復元（JSON）', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup.text) });
  const restore = page.getByRole('dialog', { name: 'バックアップを復元', exact: true });
  await expect(restore).toContainText('作成日時');
  await expect(restore).toContainText('2件');
  await expect(restore).toContainText('3件の記録と設定が置き換わります');
  await restore.getByRole('button', { name: '確認して上書き復元', exact: true }).click();
  await expect(restore).not.toBeVisible();
  await closeNotice(page);
  await homeTotals(page, 4050, 6);
  await navigate(page, '設定');
  const csv = await downloadText(page, '作業記録を出力（CSV）', testInfo, 'records.csv');
  expect(csv.text).toContain('記録データ（JSON）');
  expect(csv.text).toContain('createdAt');
  await closeNotice(page);

  const date = jstDate();
  const custom = `日付,作業,本数,エリア,早期対象本数,メモ\r\n${date},取出,7,,,CSV取出\r\n${date},補充,3,B,3,CSV補充\r\n`;
  await chooseFile(page, '作業記録を取り込む（CSV）', { name: 'custom-utf8.csv', mimeType: 'text/csv', buffer: Buffer.from(custom, 'utf8') });
  const importer = page.getByRole('dialog', { name: 'CSVから記録を取り込む', exact: true });
  await expect(importer.getByRole('heading', { name: '取り込みプレビュー · 2件' })).toBeVisible();
  await expect(importer.locator('.import-preview-list')).toContainText('7本');
  await expect(importer.locator('.import-preview-list')).toContainText('3本');
  await importer.getByRole('button', { name: '2件を取り込む', exact: true }).click();
  await expect(importer).not.toBeVisible();
  await closeNotice(page);
  await homeTotals(page, 4290, 10);
  await navigate(page, '履歴');
  await expect(page.locator('.record-row')).toHaveCount(4);
  await expect(page.locator('.record-row').filter({ hasText: 'CSV補充' })).toHaveCount(1);

  await navigate(page, '設定');
  const invalid = `日付,作業,本数,エリア\n${date},補充,abc,A\n2026-02-30,補充,1,A\n`;
  await chooseFile(page, '作業記録を取り込む（CSV）', { name: 'invalid.csv', mimeType: 'text/csv', buffer: Buffer.from(invalid, 'utf8') });
  await expect(importer.getByRole('alert')).toContainText('2件のエラー');
  await expect(importer.getByRole('button', { name: '0件を取り込む', exact: true })).toBeDisabled();
  await importer.getByRole('button', { name: '閉じる', exact: true }).click();
  await navigate(page, '履歴');
  await expect(page.locator('.record-row')).toHaveCount(4);
});

test('PWA assets and offline entry persist after reconnecting', async ({ page, context, request }) => {
  await boot(page);
  const manifestResponse = await request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  expect(manifest.icons).toHaveLength(2);
  for (const icon of manifest.icons) {
    const response = await request.get(icon.src);
    expect(response.ok()).toBe(true);
    expect((await response.body()).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  }
  const worker = await request.get('/sw.js');
  expect(worker.ok()).toBe(true);
  expect(await worker.text()).toContain('spotjobs-worker-');
  await navigate(page, '設定');
  await expect(page.getByText('オフラインで使う準備ができています。', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await context.setOffline(true);
  await expect(page.locator('.connection-status')).toContainText('オフライン');
  await pickup(page, 5);
  await refill(page, 2, '自動判定');
  await homeTotals(page, 130, 3);
  await context.setOffline(false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await homeTotals(page, 130, 3);
  await navigate(page, '履歴');
  await expect(page.locator('.record-row')).toHaveCount(2);
  await expect(page.locator('.record-row').filter({ hasText: '補充' })).toContainText('早期 2本');
  await noHorizontalOverflow(page);
});

test('service worker reloads offline and retains offline entries and history', async ({ page, context, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright supports service-worker automation only in Chromium. Windows WebKit offline navigation raises an engine internal error; physical iPhone Safari offline restart is not verified. https://playwright.dev/docs/service-workers');
  await boot(page);
  await navigate(page, '設定');
  await expect(page.getByText('オフラインで使う準備ができています。', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'ホーム', exact: true })).toBeVisible();
  await expect(page.locator('.connection-status')).toContainText('オフライン');
  await pickup(page, 5);
  await refill(page, 2, '自動判定');
  await homeTotals(page, 130, 3);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await homeTotals(page, 130, 3);
  await navigate(page, '履歴');
  await expect(page.locator('.record-row')).toHaveCount(2);
  await expect(page.locator('.record-row').filter({ hasText: '補充' })).toContainText('早期 2本');
  await noHorizontalOverflow(page);
});
