import { test, expect } from '@playwright/test';
import { launchApp } from './helpers';

test('app launches, shows the level test, then onboarding, then the library', async () => {
  const { app, page } = await launchApp({ levelTest: true });
  await expect(page.getByTestId('level-intro')).toBeVisible();
  await page.getByTestId('level-skip').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.getByTestId('finish-onboarding').click();
  await expect(page.getByTestId('library')).toBeVisible();
  const diag = await app.evaluate(async ({ app }) => ({ name: app.getName(), version: app.getVersion() }));
  expect(diag.name).toBe('Dream Read');
  await app.close();
});
