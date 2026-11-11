import { boot, expect, noHorizontalOverflow, seedReferenceThroughUI, test } from './helpers';

test('top dashboard shows weekly, monthly and yearly earnings together', async ({ page }) => {
  await boot(page);

  const overview = page.getByRole('group', { name: '今月と今年の報酬', exact: true });
  const month = overview.locator('[data-period="month"]');
  const year = overview.locator('[data-period="year"]');
  await expect(overview).toBeVisible();
  await expect(page.locator('.hero-amount .kinetic-readable')).toHaveText('0円');
  await expect(month.locator('.kinetic-readable')).toHaveText('0円');
  await expect(year.locator('.kinetic-readable')).toHaveText('0円');
  await expect(month).toContainText('今月');
  await expect(year).toContainText('今年');

  await seedReferenceThroughUI(page);
  await expect(page.locator('.hero-amount .kinetic-readable')).toHaveText('4,050円');
  await expect(month).toHaveAttribute('data-value', '4,050円');
  await expect(year).toHaveAttribute('data-value', '4,050円');
  await expect(month.locator('.kinetic-readable')).toHaveText('4,050円');
  await expect(year.locator('.kinetic-readable')).toHaveText('4,050円');
  await expect(month.locator('.kinetic-readable')).toHaveCount(1);
  await expect(year.locator('.kinetic-readable')).toHaveCount(1);
  await expect(month.locator('.kinetic-glyphs')).toHaveAttribute('aria-hidden', 'true');
  await expect(year.locator('.kinetic-glyphs')).toHaveAttribute('aria-hidden', 'true');
  await expect(month.locator('.kinetic-glyphs')).toHaveAttribute('data-text', '¥4,050');
  await expect(year.locator('.kinetic-glyphs')).toHaveAttribute('data-text', '¥4,050');

  await page.setViewportSize({ width: 320, height: 844 });
  await noHorizontalOverflow(page);
  const box = await overview.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(321);
});

test('reduced motion keeps monthly and yearly earnings complete and static', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await seedReferenceThroughUI(page);

  const overview = page.locator('.period-earnings');
  await expect(overview.locator('[data-period="month"] .kinetic-readable')).toHaveText('4,050円');
  await expect(overview.locator('[data-period="year"] .kinetic-readable')).toHaveText('4,050円');
  const glyphStyles = await overview.locator('.kinetic-glyph').evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { animationName: style.animationName, transform: style.transform, opacity: style.opacity };
  }));
  expect(glyphStyles.length).toBeGreaterThan(0);
  expect(glyphStyles.every(style => style.animationName === 'none')).toBe(true);
  expect(glyphStyles.every(style => style.transform === 'none')).toBe(true);
  expect(glyphStyles.every(style => style.opacity === '1')).toBe(true);
  await page.setViewportSize({ width: 320, height: 844 });
  await noHorizontalOverflow(page);
});
