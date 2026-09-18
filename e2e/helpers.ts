import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';

export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [async ({ page }, use, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    await use(errors);
    await testInfo.attach('browser-console', { body: errors.join('\n') || 'No console errors or page errors.', contentType: 'text/plain' });
    expect(errors, 'The real browser should not emit application errors').toEqual([]);
  }, { auto: true }],
});
export { expect };

test.afterEach(async ({ page }, testInfo) => {
  if (!page.isClosed()) {
    const file = testInfo.outputPath('final.png');
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
    await testInfo.attach('final-screen', { path: file, contentType: 'image/png' });
  }
});

export async function boot(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ホーム', exact: true })).toBeVisible();
}

export async function navigate(page: Page, label: 'ホーム' | '補充' | '抜取' | '履歴' | '設定') {
  await expect(page.locator('.app-shell')).toBeVisible();
  const mobile = page.getByRole('navigation', { name: 'モバイルナビゲーション' });
  const navigation = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'メインナビゲーション' });
  await navigation.getByRole('button', { name: label, exact: true }).click();
}

export async function closeNotice(page: Page) {
  const close = page.getByRole('button', { name: '通知を閉じる', exact: true });
  if (await close.isVisible()) await close.click();
}

export async function pickup(page: Page, quantity: number) {
  await navigate(page, '抜取');
  await page.getByRole('textbox', { name: '本数', exact: true }).fill(String(quantity));
  await page.getByRole('button', { name: `${quantity}本を抜取として保存`, exact: true }).click();
  await expect(page.getByRole('status')).toContainText(`${quantity}本を抜取として登録しました`);
  await closeNotice(page);
}

export async function refill(page: Page, quantity: number, early: 'すべて対象' | '対象外' | '自動判定' = 'すべて対象', area = 'A') {
  await navigate(page, '補充');
  await page.getByRole('textbox', { name: '本数', exact: true }).fill(String(quantity));
  await page.locator('.area-options').getByRole('button', { name: new RegExp(`^${area}\\s*\\d+円$`) }).click();
  await page.getByRole('button', { name: early, exact: true }).click();
  await page.getByRole('button', { name: `${quantity}本を補充として保存`, exact: true }).click();
  await expect(page.getByRole('status')).toContainText(`${quantity}本を補充として登録しました`);
  await closeNotice(page);
}

export async function seedReferenceThroughUI(page: Page) {
  await pickup(page, 60);
  await refill(page, 54);
  await homeTotals(page, 4050, 6);
}

export async function homeTotals(page: Page, reward: number, inventory: number) {
  await navigate(page, 'ホーム');
  await expect(page.locator('.hero-amount')).toContainText(reward.toLocaleString('ja-JP'));
  await expect(page.locator('.stock-stat strong')).toHaveText(`${inventory.toLocaleString('ja-JP')}本`);
}

export async function inventoryView(page: Page) {
  await navigate(page, 'ホーム');
  await page.locator('.home-tools').getByRole('button', { name: '在庫・棚卸', exact: true }).click();
  await expect(page.getByRole('heading', { name: '在庫・棚卸', exact: true })).toBeVisible();
}

export async function simulatorView(page: Page) {
  await navigate(page, 'ホーム');
  await page.locator('.home-tools').getByRole('button', { name: '報酬シミュレーター', exact: true }).click();
  await expect(page.getByRole('heading', { name: '報酬シミュレーター', exact: true })).toBeVisible();
}

export async function downloadText(page: Page, button: string, testInfo: TestInfo, filename: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const download = await pending;
  const path = testInfo.outputPath(filename);
  await download.saveAs(path);
  expect(await download.failure()).toBeNull();
  return { text: await readFile(path, 'utf8'), path, suggestedFilename: download.suggestedFilename() };
}

export async function chooseFile(page: Page, button: string, file: { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: button, exact: true }).click();
  await (await chooser).setFiles(file);
}

export function jstDate() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export async function noHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: window.innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(dimensions.html, 'Document should fit the viewport').toBeLessThanOrEqual(dimensions.width + 1);
  expect(dimensions.body, 'Body should fit the viewport').toBeLessThanOrEqual(dimensions.width + 1);
}
