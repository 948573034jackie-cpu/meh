import { test, expect } from '@playwright/test';
import { launchApp } from './helpers';

/**
 * The level test screen (src/renderer/views/LevelTest.tsx). The app routes to it for view === 'leveltest'
 * (LEVEL_TEST_VIEW_ID); until app.tsx shows it at first start and from Settings → Level, the screen cannot be
 * reached in the built app, so this spec is skipped. Enable it (remove `.skip`) once the route exists and
 * replace `openLevelTest` with the real way in (the first-start screen or the Settings → Level button).
 */
async function openLevelTest(page: import('@playwright/test').Page): Promise<void> {
  // TODO(route): first start should show the test directly; from Settings → Level use the "Test my level" button.
  await page.getByTestId('level-take').click();
}

test.describe('level test', () => {
  test.skip('intro → 2 x 50 words → result → Use this level saves the level and the model', async () => {
    const { app, page } = await launchApp();
    await page.setViewportSize({ width: 1000, height: 760 });
    await openLevelTest(page);

    await expect(page.getByTestId('level-intro')).toBeVisible();
    await page.getByTestId('level-start').click();
    await expect(page.getByTestId('level-word')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('level-stage-text')).toHaveText('Stage 1 of 2');
    await expect(page.getByTestId('level-progress')).toHaveText('1 of 50');

    // stage 1: answer with the keyboard (Y / N) and the buttons
    for (let i = 0; i < 50; i++) {
      await expect(page.getByTestId('level-progress')).toHaveText(`${i + 1} of 50`);
      if (i % 3 === 0) await page.getByTestId('level-yes').click();
      else await page.keyboard.press(i % 2 ? 'KeyN' : 'ArrowLeft');
    }
    await expect(page.getByTestId('level-between')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('level-stage-text')).toHaveText('Stage 2 of 2');
    for (let i = 0; i < 50; i++) {
      await expect(page.getByTestId('level-progress')).toHaveText(`${i + 1} of 50`);
      await page.keyboard.press(i % 2 ? 'KeyY' : 'KeyN');
    }

    const result = page.getByTestId('level-result');
    await expect(result).toBeVisible();
    const level = await result.getAttribute('data-level');
    expect(level).toMatch(/^[ABC][12]$/);
    await page.getByTestId('level-use').click();
    // the level is saved: Settings → Level shows it selected
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: /Level/ }).click();
    await expect(page.getByTestId(`level-${level}`)).toHaveClass(/primary/);
    await app.close();
  });

  test.skip('Skip for now keeps the current level', async () => {
    const { app, page } = await launchApp();
    await openLevelTest(page);
    await page.getByTestId('level-skip').click();
    await expect(page.getByTestId('level-test')).toHaveCount(0);
    await app.close();
  });
});
