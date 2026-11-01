import { boot, closeNotice, expect, navigate, noHorizontalOverflow, simulatorView, test } from './helpers';

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

async function motionProfile(page: import('@playwright/test').Page, selector: string, animationName: string) {
  return page.locator(selector).evaluate((element, expectedName) => {
    const animation = element.getAnimations().find(item => (item as CSSAnimation).animationName === expectedName);
    const effect = animation?.effect as KeyframeEffect | null | undefined;
    const frames = effect?.getKeyframes() ?? [];
    const timing = effect?.getTiming();
    return {
      found: Boolean(animation),
      duration: Number(timing?.duration ?? 0),
      firstOpacity: Number(frames[0]?.opacity ?? 1),
      firstTransform: String(frames[0]?.transform ?? 'none'),
    };
  }, animationName);
}

test('UI motion gives immediate feedback without blocking navigation or sheets', async ({ page }) => {
  await boot(page);

  const homeMotion = await motionStyle(page, '.view-motion-stage');
  expect(homeMotion.animationName).toContain('view-enter');
  const homeProfile = await motionProfile(page, '.view-motion-stage', 'view-enter');
  expect(homeProfile.found).toBe(true);
  expect(homeProfile.duration).toBeGreaterThanOrEqual(320);
  expect(homeProfile.firstOpacity).toBeLessThanOrEqual(.2);
  expect(homeProfile.firstTransform).toContain('22px');

  await navigate(page, '取出');
  await expect(page.locator('.view-motion-stage')).toHaveAttribute('data-view', 'pickup');
  const desktopNavigation = await page.evaluate(() => window.innerWidth >= 1000);
  const navProfile = await motionProfile(page, desktopNavigation ? '.desktop-sidebar nav > button.active' : '.bottom-nav button.active > span', desktopNavigation ? 'sidebar-item-activate' : 'nav-pill-activate');
  expect(navProfile.found).toBe(true);
  expect(navProfile.duration).toBeGreaterThanOrEqual(320);
  const quantity = page.getByRole('textbox', { name: '本数', exact: true });
  await page.locator('.quick-amounts').getByRole('button', { name: '+1', exact: true }).click();
  await expect(quantity).toHaveValue('2');
  await page.getByRole('button', { name: '2本を取出として保存', exact: true }).click();
  const savedToast = page.locator('.toast');
  await expect(savedToast).toContainText('2本を取出として登録しました');
  const savedToastProfile = await motionProfile(page, '.toast', 'toast-enter');
  expect(savedToastProfile.duration).toBeGreaterThanOrEqual(400);
  expect(savedToastProfile.firstTransform).toContain('52px');
  const checkProfile = await motionProfile(page, '.toast-check', 'toast-check-pop');
  expect(checkProfile.found).toBe(true);
  expect(checkProfile.duration).toBeGreaterThanOrEqual(340);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(savedToast).toContainText('操作を元に戻しました');
  await closeNotice(page);

  await navigate(page, 'ホーム');
  await page.getByRole('button', { name: '成績をXで共有', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '成績をXで共有', exact: true });
  await expect(dialog).toBeVisible();
  const sheetMotion = await motionStyle(page, '.sheet[open]');
  expect(sheetMotion.animationName).toMatch(/sheet-(enter|pop-enter)/);
  const sheetAnimationName = await page.evaluate(() => window.innerWidth < 600 ? 'sheet-enter' : 'sheet-pop-enter');
  const sheetProfile = await motionProfile(page, '.sheet[open]', sheetAnimationName);
  expect(sheetProfile.duration).toBeGreaterThanOrEqual(400);
  expect(sheetProfile.firstTransform).toContain(await page.evaluate(() => window.innerWidth < 600 ? '72px' : '28px'));
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');

  await simulatorView(page);
  const simulatorInput = page.locator('.simulator-number input');
  await expect(simulatorInput).toHaveValue('20');
  await page.locator('.simulator-input .quick-amounts').getByRole('button', { name: '+20', exact: true }).click();
  await expect(simulatorInput).toHaveValue('40');
  const resultProfile = await motionProfile(page, '.simulation-result', 'result-update');
  expect(resultProfile.found).toBe(true);
  expect(resultProfile.duration).toBeGreaterThanOrEqual(440);
  expect(resultProfile.firstOpacity).toBeLessThanOrEqual(.2);
  expect(resultProfile.firstTransform).toContain('18px');

  await navigate(page, 'ホーム');
  await page.getByRole('button', { name: 'デモデータで試す', exact: true }).click();
  const toast = page.locator('.toast');
  await expect(toast).toContainText('デモデータを表示しています');
  const toastMotion = await motionStyle(page, '.toast');
  expect(toastMotion.animationName).toContain('toast-enter');
  expect(toastMotion.animationDuration).toBe('0.42s');
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
  await page.getByRole('button', { name: '11本を取出として保存', exact: true }).click();
  const savedToast = page.locator('.toast');
  await expect(savedToast).toContainText('11本を取出として登録しました');
  expect((await motionStyle(page, '.toast-check')).animationName).toBe('none');
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(savedToast).toContainText('操作を元に戻しました');
  await closeNotice(page);

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

  await simulatorView(page);
  await page.locator('.simulator-input .quick-amounts').getByRole('button', { name: '+20', exact: true }).click();
  expect((await motionStyle(page, '.simulation-result')).animationName).toBe('none');

  await navigate(page, 'ホーム');
  await page.getByRole('button', { name: 'デモデータで試す', exact: true }).click();
  const toast = page.locator('.toast');
  await expect(toast).toContainText('デモデータを表示しています');
  const toastMotion = await motionStyle(page, '.toast');
  expect(toastMotion.animationName).toBe('none');
  expect(toastMotion.animationDuration).toBe('0s');
  await expect(page.locator('.hero-amount .kinetic-readable')).not.toHaveText('0円');
  await noHorizontalOverflow(page);
});
