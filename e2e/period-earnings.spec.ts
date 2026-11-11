import { boot, closeNotice, expect, jstDate, navigate, noHorizontalOverflow, seedReferenceThroughUI, test } from './helpers';

test('top dashboard shows weekly, monthly and yearly earnings together', async ({ page }) => {
  await boot(page);

  const overview = page.getByRole('group', { name: '月次と今年の報酬', exact: true });
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

test('past monthly earnings can be browsed without changing the weekly dashboard', async ({ page }) => {
  await boot(page);
  const today = jstDate();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  const previousDate = `${previousYear}-${String(previousMonth).padStart(2, '0')}-15`;
  const currentCaption = `${year}年${month}月`;
  const previousCaption = `${previousYear}年${previousMonth}月`;

  await navigate(page, '取出');
  await page.locator('input[type="date"]').fill(previousDate);
  await page.getByRole('textbox', { name: '本数', exact: true }).fill('20');
  await page.getByRole('button', { name: '20本を取出として保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('20本を取出として登録しました');
  await closeNotice(page);

  await navigate(page, '補充');
  await page.locator('input[type="date"]').fill(previousDate);
  await page.getByRole('textbox', { name: '本数', exact: true }).fill('20');
  await page.locator('.area-options').getByRole('button', { name: /^A\s*55円$/ }).click();
  await page.getByRole('button', { name: '対象外', exact: true }).click();
  await page.getByRole('button', { name: '20本を補充として保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('20本を補充として登録しました');
  await closeNotice(page);
  await seedReferenceThroughUI(page);

  const overview = page.getByRole('group', { name: '月次と今年の報酬', exact: true });
  const monthValue = overview.locator('[data-period="month"] .kinetic-readable');
  const yearValue = overview.locator('[data-period="year"] .kinetic-readable');
  const weeklyValue = page.locator('.hero-amount .kinetic-readable');
  const yearBefore = await yearValue.textContent();
  await expect(monthValue).toHaveText('4,050円');
  await expect(weeklyValue).toHaveText('4,050円');
  await expect(overview.getByRole('button', { name: new RegExp(`^${currentCaption}、今月を表示中$`) })).toBeDisabled();
  await expect(overview.getByRole('button', { name: /^次の月、/ })).toBeDisabled();

  const previousButton = overview.getByRole('button', { name: `前の月、${previousCaption}を表示`, exact: true });
  const touchTarget = await previousButton.boundingBox();
  expect(touchTarget).not.toBeNull();
  expect(touchTarget!.width).toBeGreaterThanOrEqual(44);
  expect(touchTarget!.height).toBeGreaterThanOrEqual(44);
  await previousButton.click();
  await expect(overview.locator('.period-month-label strong')).toHaveText(previousCaption);
  await expect(monthValue).toHaveText('1,200円');
  await expect(overview.getByRole('status')).toContainText(`${previousCaption}の月次報酬は1,200円、補充20本`);
  await expect(weeklyValue).toHaveText('4,050円');
  await expect(yearValue).toHaveText(yearBefore ?? '');
  await expect(overview.getByRole('button', { name: /^次の月、/ })).toBeEnabled();

  await page.setViewportSize({ width: 320, height: 844 });
  await noHorizontalOverflow(page);
  await overview.getByRole('button', { name: '今月へ戻る', exact: true }).click();
  await expect(overview.locator('.period-month-label strong')).toHaveText(currentCaption);
  await expect(monthValue).toHaveText('4,050円');
  await expect(overview.getByRole('button', { name: /^次の月、/ })).toBeDisabled();
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
