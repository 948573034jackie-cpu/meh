import { test, expect } from '@playwright/test';
import { launchApp } from './helpers';

test('app launches, shows onboarding, then the library', async () => {
  const { app, page } = await launchApp();
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.getByTestId('finish-onboarding').click();
  await expect(page.getByTestId('library')).toBeVisible();
  const diag = await app.evaluate(async ({ app }) => ({ name: app.getName(), version: app.getVersion() }));
  expect(diag.name).toBe('ReadAlong');
  await app.close();
});
