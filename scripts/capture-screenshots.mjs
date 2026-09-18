/**
 * Capture the deployed application's actual UI using isolated demo browser sessions.
 * Usage: node scripts/capture-screenshots.mjs https://confirmed-production.example
 * Requires the Chromium browser installed by `npx playwright install chromium`.
 * No application state, styles, clock, API responses, or screenshots are fabricated.
 */
import { chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const suppliedURL = process.argv[2] ?? process.env.SCREENSHOT_BASE_URL;
if (!suppliedURL) throw new Error('Pass the confirmed deployment URL: node scripts/capture-screenshots.mjs <url>');
const target = new URL(suppliedURL);
if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname))) {
  throw new Error('Use an HTTPS deployment URL or a local test server.');
}
if (target.username || target.password || target.search || target.hash) throw new Error('Use a deployment URL without credentials, query parameters, or fragments.');

const output = new URL('../docs/screenshots/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const contexts = [];
const captures = [];
const runtimeErrors = [];
const mobile = { width: 390, height: 844 };
const desktop = { width: 1440, height: 1000 };

async function closeNotice(page) {
  const close = page.getByRole('button', { name: '通知を閉じる', exact: true });
  if (await close.isVisible()) await close.click();
}

async function demoPage(viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    isMobile: viewport.width < 600,
    hasTouch: viewport.width < 600,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'allow',
  });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.setDefaultTimeout(15_000);
  const response = await page.goto(target.href, { waitUntil: 'networkidle', timeout: 60_000 });
  if (!response?.ok()) throw new Error(`Deployment did not return success: ${response?.status()}`);
  if (new URL(page.url()).origin !== target.origin) {
    throw new Error('The deployment redirected away from the application. Verify anonymous public access before capturing.');
  }
  await expect(page).toHaveTitle('SPOTJOBS報酬・在庫管理アプリ');
  await page.getByRole('button', { name: 'デモデータで試す', exact: true }).click();
  await expect(page.locator('.demo-banner')).toContainText('デモデータでお試し中');
  await expect(page.locator('.hero-amount')).toHaveText('¥3,010');
  await expect(page.locator('.stats-grid .stat').nth(0)).toContainText('43本');
  await expect(page.locator('.stock-stat')).toContainText('14本');
  await expect(page.locator('.next-tier .next-number')).toHaveText('あと 7 本');
  await closeNotice(page);
  return page;
}

async function capture(page, filename, description, checks, fullPage = false) {
  await closeNotice(page);
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('Control+Home');
  const interactionViewport = page.viewportSize();
  // A real taller viewport keeps the mobile fixed save/navigation controls at the
  // bottom of the complete form, instead of obscuring fields halfway down a
  // full-page capture. This changes only the browser viewport, never the DOM.
  if (fullPage && interactionViewport.width < 600) {
    const body = await page.locator('body').boundingBox();
    await page.setViewportSize({
      width: interactionViewport.width,
      height: Math.max(interactionViewport.height, Math.ceil(body.height)),
    });
  }
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('Control+Home');
  await expect(page.locator('.demo-banner')).toBeVisible();
  await page.screenshot({ path: fileURLToPath(new URL(filename, output)), fullPage });
  const image = await readFile(new URL(filename, output));
  captures.push({
    filename,
    description,
    capturedAt: new Date().toISOString(),
    sourceURL: page.url(),
    title: await page.title(),
    interactionViewport,
    viewport: page.viewportSize(),
    imageSize: { width: image.readUInt32BE(16), height: image.readUInt32BE(20) },
    fullPage,
    mode: 'Demo explicitly selected through the application UI',
    verifiedUI: checks,
    sha256: createHash('sha256').update(image).digest('hex'),
  });
  console.log(`Captured ${filename}`);
}

try {
  const home = await demoPage(mobile);
  await capture(home, '01-dashboard.png', '週間報酬・週間補充・現在庫・次のボーナスを確認するホーム', {
    weeklyReward: 3010, weeklyRefills: 43, inventory: 14, remainingToNextTier: 7,
  });

  const refill = await demoPage(mobile);
  await refill.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByRole('button', { name: '補充', exact: true }).click();
  await refill.getByRole('textbox', { name: '本数', exact: true }).fill('7');
  await refill.locator('.area-options').getByRole('button', { name: 'A 55円', exact: true }).click();
  await refill.getByRole('button', { name: '自動判定', exact: true }).click();
  await expect(refill.getByRole('textbox', { name: '本数', exact: true })).toHaveValue('7');
  await expect(refill.getByRole('button', { name: '7本を補充として保存', exact: true })).toBeVisible();
  await capture(refill, '02-replenishment.png', '7本・エリアA・早期自動判定を入力した補充画面（保存前）', {
    quantity: 7, area: 'A', earlyMode: 'auto', saved: false,
  }, true);

  const weekly = await demoPage(desktop);
  await weekly.getByRole('navigation', { name: 'メインナビゲーション' }).getByRole('button', { name: '週次報酬', exact: true }).click();
  await expect(weekly.locator('.reward-total')).toContainText('¥3,010');
  await expect(weekly.locator('.weekly-table tfoot')).toContainText('43');
  await expect(weekly.locator('.weekly-table tfoot')).toContainText('¥3,010');
  await capture(weekly, '03-weekly-reward.png', '週次の報酬内訳・日別実績・地域別補充の集計', {
    weeklyReward: 3010, weeklyRefills: 43, dailyTable: true, regionalTable: true,
  }, true);

  const inventory = await demoPage(mobile);
  await inventory.getByRole('button', { name: '現在庫', exact: false }).first().click();
  await expect(inventory.locator('.inventory-count')).toHaveText('14本');
  await inventory.getByRole('button', { name: '棚卸を記録する', exact: true }).click();
  const stocktake = inventory.getByRole('dialog', { name: '棚卸', exact: true });
  await stocktake.getByRole('textbox', { name: '本数', exact: true }).fill('12');
  await expect(stocktake.getByRole('checkbox', { name: '棚卸数を在庫に反映する', exact: true })).not.toBeChecked();
  await stocktake.getByRole('button', { name: '12本を棚卸として保存', exact: true }).click();
  await expect(stocktake).not.toBeVisible();
  await expect(inventory.locator('.inventory-count')).toHaveText('14本');
  await expect(inventory.locator('.stocktake-list')).toContainText('差異 -2本');
  await expect(inventory.locator('.stocktake-list')).toContainText('確認記録のみ');
  await expect(inventory.locator('.stocktake-list')).toContainText('在庫差異あり');
  await capture(inventory, '04-inventory.png', '現在庫14本、実棚卸12本を確認記録として保存した在庫・棚卸画面', {
    inventory: 14, countedStock: 12, difference: -2, adjustmentApplied: false,
  }, true);

  const simulator = await demoPage(desktop);
  await simulator.getByRole('navigation', { name: 'メインナビゲーション' }).getByRole('button', { name: 'シミュレーター', exact: true }).click();
  await simulator.getByRole('spinbutton', { name: '追加する補充本数', exact: false }).fill('20');
  await simulator.getByRole('combobox', { name: '追加分の地域', exact: true }).selectOption('A');
  await simulator.getByRole('checkbox', { name: '追加分をすべて早期補充として試算', exact: true }).check();
  await expect(simulator.locator('.result-amount')).toHaveText('¥4,725');
  await expect(simulator.locator('.difference-pill')).toContainText('＋¥1,715');
  await capture(simulator, '05-simulator.png', 'エリアA・早期対象20本を追加した報酬シミュレーション', {
    additional: 20, area: 'A', allEarly: true, projectedCount: 63, projectedReward: 4725, increase: 1715,
  });

  if (runtimeErrors.length) throw new Error(`Browser runtime errors: ${runtimeErrors.join('; ')}`);
  await writeFile(new URL('capture.json', output), JSON.stringify({
    capturedAt: new Date().toISOString(),
    deploymentURL: target.href,
    browser: 'Playwright Chromium in isolated headless contexts',
    browserVersion: browser.version(),
    locale: 'ja-JP',
    timezone: 'Asia/Tokyo',
    colorScheme: 'light',
    deviceScaleFactor: 1,
    source: 'Actual deployed application UI; no DOM/style changes, data injection, clock mocking, image generation, cropping, or retouching.',
    runtimeErrors,
    captures,
  }, null, 2) + '\n', 'utf8');
  console.log(`Saved five screenshots and capture.json to ${fileURLToPath(output)}`);
} finally {
  await Promise.all(contexts.map(context => context.close()));
  await browser.close();
}
