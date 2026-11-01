import { boot, expect, navigate, noHorizontalOverflow, seedReferenceThroughUI, test } from './helpers';

async function glyphProfile(locator: import('@playwright/test').Locator) {
  return locator.evaluate(element => {
    const animation = element.getAnimations().find(item => (item as CSSAnimation).animationName === 'kinetic-glyph-enter');
    const effect = animation?.effect as KeyframeEffect | null | undefined;
    const timing = effect?.getTiming();
    const frames = effect?.getKeyframes() ?? [];
    const firstTransform = String(frames[0]?.transform ?? 'none');
    const translate = firstTransform.match(/translateY\((-?[\d.]+)(px|em)\)/);
    const firstTranslateYPx = translate
      ? Number(translate[1]) * (translate[2] === 'em' ? Number.parseFloat(getComputedStyle(element).fontSize) : 1)
      : 0;
    return {
      found: Boolean(animation),
      duration: Number(timing?.duration ?? 0),
      delay: Number(timing?.delay ?? 0),
      firstOpacity: Number(frames[0]?.opacity ?? 1),
      firstTransform,
      firstTranslateYPx,
    };
  });
}

test('kinetic typography animates titles and exact dashboard values once', async ({ page }) => {
  await boot(page);

  const title = page.locator('.page-heading h1');
  await expect(page.getByRole('heading', { name: 'ホーム', exact: true })).toBeVisible();
  await expect(title.locator('.kinetic-readable')).toHaveText('ホーム');
  await expect(title.locator('.kinetic-glyphs')).toHaveAttribute('aria-hidden', 'true');
  await expect(title.locator('.kinetic-glyph')).toHaveCount(Array.from('ホーム').length);
  expect((await title.locator('.kinetic-glyph').allTextContents()).join('')).toBe('ホーム');
  const titleFirst = await glyphProfile(title.locator('.kinetic-glyph').first());
  const titleLast = await glyphProfile(title.locator('.kinetic-glyph').last());
  expect(titleFirst.found).toBe(true);
  expect(titleFirst.duration).toBeGreaterThanOrEqual(440);
  expect(titleFirst.firstOpacity).toBeLessThanOrEqual(.1);
  expect(titleFirst.firstTranslateYPx).toBeGreaterThanOrEqual(12);
  expect(titleFirst.firstTransform).toContain('rotateX(-62deg)');
  expect(titleLast.delay - titleFirst.delay).toBeGreaterThanOrEqual(80);

  await navigate(page, '補充');
  await navigate(page, '取出');
  await expect(page.getByRole('heading', { name: '取出入力', exact: true })).toHaveCount(1);
  await expect(page.locator('.page-heading h1 .kinetic-glyph')).toHaveCount(Array.from('取出入力').length);

  await seedReferenceThroughUI(page);

  const hero = page.locator('.hero-amount');
  await expect(hero).toHaveAttribute('data-value', '4,050円');
  await expect(hero.locator('.kinetic-readable')).toHaveText('4,050円');
  await expect(hero.locator('.kinetic-glyphs')).toHaveCount(2);
  await expect(hero.locator('.kinetic-glyphs').first()).toHaveAttribute('aria-hidden', 'true');
  await expect(hero.locator('.kinetic-glyph')).toHaveCount(Array.from('¥4,050').length);
  const amountGlyphs = hero.locator('.kinetic-glyphs:not(.hero-currency) .kinetic-glyph');
  const amountFirst = await glyphProfile(amountGlyphs.first());
  const amountLast = await glyphProfile(amountGlyphs.last());
  expect(amountFirst.found).toBe(true);
  expect(amountFirst.duration).toBeGreaterThanOrEqual(540);
  expect(amountLast.delay - amountFirst.delay).toBeGreaterThanOrEqual(200);

  const tier = page.locator('.next-tier .next-number');
  await expect(tier).toHaveAttribute('data-value', 'あと46本');
  await expect(tier.locator('.kinetic-readable')).toHaveText('あと46本');
  await expect(tier.locator('.kinetic-glyphs')).toHaveAttribute('data-text', '46');

  const goal = page.locator('.home-grid > .goal-panel .goal-main > strong');
  await expect(goal).toHaveAttribute('data-value', '40.5%');
  await expect(goal.locator('.kinetic-readable')).toHaveText('40.5%');
  await expect(goal.locator('.kinetic-glyphs')).toHaveAttribute('data-text', '40.5');

  await page.setViewportSize({ width: 320, height: 844 });
  await noHorizontalOverflow(page);
  const heroBox = await hero.boundingBox();
  expect(heroBox).not.toBeNull();
  expect(heroBox!.x + heroBox!.width).toBeLessThanOrEqual(321);
  await page.locator('.quick-actions').getByRole('button', { name: /補充を記録/ }).click();
  await expect(page.getByRole('heading', { name: '補充入力', exact: true })).toBeVisible();
});

test('reduced motion keeps kinetic text complete, readable, and static', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);

  const titleGlyph = page.locator('.page-heading h1 .kinetic-glyph').first();
  const titleStyle = await titleGlyph.evaluate(element => {
    const style = getComputedStyle(element);
    return { animationName: style.animationName, transform: style.transform, opacity: style.opacity };
  });
  expect(titleStyle.animationName).toBe('none');
  expect(titleStyle.transform).toBe('none');
  expect(titleStyle.opacity).toBe('1');

  await seedReferenceThroughUI(page);
  const hero = page.locator('.hero-amount');
  await expect(hero).toHaveAttribute('data-value', '4,050円');
  await expect(hero.locator('.kinetic-readable')).toHaveText('4,050円');
  const glyphStyles = await hero.locator('.kinetic-glyph').evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { animationName: style.animationName, transform: style.transform, opacity: style.opacity };
  }));
  expect(glyphStyles.every(style => style.animationName === 'none')).toBe(true);
  expect(glyphStyles.every(style => style.transform === 'none')).toBe(true);
  expect(glyphStyles.every(style => style.opacity === '1')).toBe(true);
  await expect(page.locator('.next-tier .next-number .kinetic-readable')).toHaveText('あと46本');
  await expect(page.locator('.home-grid > .goal-panel .goal-main > strong .kinetic-readable')).toHaveText('40.5%');

  await page.setViewportSize({ width: 320, height: 844 });
  await noHorizontalOverflow(page);
});
