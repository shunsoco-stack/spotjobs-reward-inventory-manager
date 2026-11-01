import { boot, expect, navigate, noHorizontalOverflow, seedReferenceThroughUI, test } from './helpers';

async function animationProfile(page: import('@playwright/test').Page, selector: string, animationName: string) {
  return page.locator(selector).evaluate((element, expectedName) => {
    const animation = element.getAnimations().find(item => (item as CSSAnimation).animationName === expectedName);
    const effect = animation?.effect as KeyframeEffect | null | undefined;
    const frames = effect?.getKeyframes() ?? [];
    const timing = effect?.getTiming();
    return {
      found: Boolean(animation),
      duration: Number(timing?.duration ?? 0),
      firstTransform: String(frames[0]?.transform ?? 'none'),
    };
  }, animationName);
}

test('dashboard infographics animate exact rewards, progress, and daily counts', async ({ page }) => {
  await boot(page);

  await expect(page.locator('.reward-composition')).toContainText('まだ報酬はありません');
  await expect(page.locator('.next-tier [role="progressbar"]')).toHaveAttribute('aria-valuenow', '0');
  await expect(page.locator('.next-tier [role="progressbar"]')).toHaveAttribute('aria-valuemax', '20');
  await expect(page.locator('.goal-panel [role="progressbar"]')).toHaveAttribute('data-progress', '0');
  await expect(page.locator('.week-chart i[data-count="0"]')).toHaveCount(7);

  await seedReferenceThroughUI(page);

  const composition = page.locator('.reward-hero .reward-composition');
  await expect(composition).toHaveAttribute('aria-label', '報酬内訳。基本報酬2,970円、早期補充540円、本数ボーナス540円');
  await expect(composition.locator('[data-kind="base"]')).toHaveAttribute('data-value', '2970');
  await expect(composition.locator('[data-kind="early"]')).toHaveAttribute('data-value', '540');
  await expect(composition.locator('[data-kind="bonus"]')).toHaveAttribute('data-value', '540');
  const widths = await composition.locator('.reward-segment').evaluateAll(elements => elements.map(element => Number.parseFloat((element as HTMLElement).style.width)));
  expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(100, 3);
  expect(widths).toHaveLength(3);
  expect(widths[0]).toBeCloseTo(73.333, 2);
  expect(widths[1]).toBeCloseTo(13.333, 2);
  expect(widths[2]).toBeCloseTo(13.333, 2);

  const segmentMotion = await animationProfile(page, '.reward-hero .reward-segment.base', 'infographic-segment-grow');
  expect(segmentMotion.found).toBe(true);
  expect(segmentMotion.duration).toBeGreaterThanOrEqual(650);
  expect(segmentMotion.firstTransform).toContain('scaleX(0)');

  const tierProgress = page.locator('.next-tier [role="progressbar"]');
  await expect(tierProgress).toHaveAttribute('aria-valuenow', '54');
  await expect(tierProgress).toHaveAttribute('aria-valuemax', '100');
  await expect(tierProgress).toHaveAttribute('data-progress', '54');
  await expect(tierProgress.locator('.infographic-progress-fill')).toHaveAttribute('style', /width:\s*54%/);
  const progressMotion = await animationProfile(page, '.next-tier .infographic-progress-fill', 'infographic-progress-grow');
  expect(progressMotion.found).toBe(true);
  expect(progressMotion.duration).toBeGreaterThanOrEqual(750);
  expect(progressMotion.firstTransform).toContain('scaleX(0)');

  const goalProgress = page.locator('.goal-panel [role="progressbar"]');
  await expect(goalProgress).toHaveAttribute('aria-valuenow', '4050');
  await expect(goalProgress).toHaveAttribute('aria-valuemax', '10000');
  await expect(goalProgress).toHaveAttribute('data-progress', '40.5');

  const activeBar = page.locator('.week-chart i[data-count="54"]');
  await expect(activeBar).toHaveCount(1);
  await expect(activeBar).toHaveAttribute('style', /height:\s*80px/);
  const barMotion = await animationProfile(page, '.week-chart i[data-count="54"]', 'infographic-bar-grow');
  expect(barMotion.found).toBe(true);
  expect(barMotion.duration).toBeGreaterThanOrEqual(640);
  expect(barMotion.firstTransform).toContain('scaleY(0)');

  await page.setViewportSize({ width: 320, height: 844 });
  await noHorizontalOverflow(page);
  await navigate(page, '取出');
  await expect(page.getByRole('heading', { name: '取出入力', exact: true })).toBeVisible();
});

test('reduced motion keeps every infographic complete and readable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await seedReferenceThroughUI(page);

  const selectors = [
    '.reward-hero .reward-segment.base',
    '.next-tier .infographic-progress-fill',
    '.goal-panel .infographic-progress-fill',
    '.week-chart i[data-count="54"]',
  ];
  for (const selector of selectors) {
    const style = await page.locator(selector).evaluate(element => {
      const computed = getComputedStyle(element);
      return { animationName: computed.animationName, transform: computed.transform, opacity: computed.opacity };
    });
    expect(style.animationName).toBe('none');
    expect(style.transform).toBe('none');
    expect(Number(style.opacity)).toBeGreaterThan(0);
  }

  const tierRatio = await page.locator('.next-tier .infographic-progress-fill').evaluate(element => {
    const fill = element.getBoundingClientRect();
    const track = element.parentElement!.getBoundingClientRect();
    return fill.width / track.width;
  });
  expect(tierRatio).toBeCloseTo(.54, 2);
  await expect(page.locator('.week-chart i[data-count="54"]')).toHaveCSS('height', '80px');
  await expect(page.locator('.reward-hero .hero-breakdown')).toContainText('¥2,970');
  await expect(page.locator('.reward-hero .hero-breakdown')).toContainText('¥540');

  await page.setViewportSize({ width: 320, height: 844 });
  await noHorizontalOverflow(page);
});
