import { defineConfig } from '@playwright/test';
import shared from './playwright.config';

// Additional release checks; the complete existing suite still runs on its
// explicitly enabled personal-sync fixture before the release rebuild.
export default defineConfig({
  ...shared,
  testDir: './e2e-release',
  outputDir: 'test-results/release',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/release', open: 'never' }]],
});
