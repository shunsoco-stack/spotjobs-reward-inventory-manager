import { boot, expect, navigate, noHorizontalOverflow, test } from './helpers';

async function motionStyle(page: import('@playwright/test').Page, selector: string) {
  return page.locator(selector).evaluate(element => {
    const style = getComputedStyle(element);
    return {
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      transitionDuration: style.transitionDuration,
    };
  });
}

test('UI motion gives immediate feedback without blocking navigation or sheets', async ({ page }) => {
  await boot(page);

  const homeMotion = await motionStyle(page, '.view-motion-stage');
  expect(homeMotion.animationName).toContain('view-enter');
  expect(homeMotion.animationDuration).not.toBe('0s');

  await navigate(page, '補充');
  await expect(page.locator('.view-motion-stage')).toHaveAttribute('data-view', 'refill');
  const quantity = page.getByRole('textbox', { name: '本数', exact: true });
  await page.locator('.quick-amounts').getByRole('button', { name: '+1', exact: true }).click();
  await expect(quantity).toHaveValue('2');

  await navigate(page, 'ホーム');
  await page.getByRole('button', { name: '成績をXで共有', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '成績をXで共有', exact: true });
  await expect(dialog).toBeVisible();
  const sheetMotion = await motionStyle(page, '.sheet[open]');
  expect(sheetMotion.animationName).toMatch(/sheet-(enter|pop-enter)/);
  expect(sheetMotion.animationDuration).not.toBe('0s');
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');

  await page.getByRole('button', { name: 'デモデータで試す', exact: true }).click();
  const toast = page.locator('.toast');
  await expect(toast).toContainText('デモデータを表示しています');
  const toastMotion = await motionStyle(page, '.toast');
  expect(toastMotion.animationName).toContain('toast-enter');
  expect(toastMotion.animationDuration).not.toBe('0s');
  await noHorizontalOverflow(page);
});

test('reduced motion removes transitions while every action remains usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);

  const stageMotion = await motionStyle(page, '.view-motion-stage');
  expect(stageMotion.animationName).toBe('none');
  expect(stageMotion.animationDuration).toBe('0s');

  const navPillMotion = await motionStyle(page, '.bottom-nav button.active > span');
  expect(navPillMotion.transitionDuration).toBe('0s');

  await navigate(page, '取出');
  const quantity = page.getByRole('textbox', { name: '本数', exact: true });
  await page.locator('.quick-amounts').getByRole('button', { name: '+10', exact: true }).click();
  await expect(quantity).toHaveValue('11');

  await navigate(page, 'ホーム');
  await page.getByRole('button', { name: '成績をXで共有', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '成績をXで共有', exact: true });
  await expect(dialog).toBeVisible();
  const sheetMotion = await motionStyle(page, '.sheet[open]');
  expect(sheetMotion.animationName).toBe('none');
  expect(sheetMotion.animationDuration).toBe('0s');
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');

  await page.getByRole('button', { name: 'デモデータで試す', exact: true }).click();
  const toast = page.locator('.toast');
  await expect(toast).toContainText('デモデータを表示しています');
  const toastMotion = await motionStyle(page, '.toast');
  expect(toastMotion.animationName).toBe('none');
  expect(toastMotion.animationDuration).toBe('0s');
  await expect(page.locator('.hero-amount')).not.toHaveText('¥0');
  await noHorizontalOverflow(page);
});
