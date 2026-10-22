import { test, expect } from '@playwright/test';
import { launchApp } from './helpers';

// Reading aloud behind another window (App Nap) and the speed facts of the Diagnostics screen (PLAN phases 0 and 4).

const TEXT = `# Chapter 1: The Cat\n\n${Array.from({ length: 12 }, (_, i) => `The cat sat on the mat number ${i + 1}. It was a warm day and the sun was out.`).join('\n\n')}`;

test('App Nap blocker: held while Listening mode reads aloud, given back on pause and in Reading mode; Diagnostics shows the speed facts', async () => {
  test.setTimeout(90_000);
  const { app, page } = await launchApp();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.getByTestId('finish-onboarding').click();

  // the real handler starts a power-save blocker and stops it again
  const blockers = () => app.evaluate(({ powerSaveBlocker }) => Array.from({ length: 16 }, (_, i) => i).filter((i) => powerSaveBlocker.isStarted(i)).length);
  await page.evaluate(() => window.readalong.keepAwake(true));
  expect(await blockers()).toBe(1);
  await page.evaluate(() => window.readalong.keepAwake(true));
  expect(await blockers()).toBe(1);
  await page.evaluate(() => window.readalong.keepAwake(false));
  expect(await blockers()).toBe(0);

  // from here on the page's calls are recorded
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __keep: boolean[] };
    g.__keep = [];
    ipcMain.removeHandler('app:keepAwake');
    ipcMain.handle('app:keepAwake', (_e, on: boolean) => { g.__keep.push(on); });
  });
  const keep = () => app.evaluate(() => (globalThis as unknown as { __keep: boolean[] }).__keep);

  await page.getByTestId('paste-text').click();
  await page.getByTestId('paste-title').fill('The Cat');
  await page.getByTestId('paste-body').fill(TEXT);
  await page.getByTestId('paste-import').click();
  await expect(page.getByTestId('reader')).toBeVisible({ timeout: 20000 });

  // Reading mode reads aloud without it
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveAttribute('aria-label', 'Pause');
  await page.waitForTimeout(500);
  expect(await keep()).toEqual([]);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('play')).toHaveAttribute('aria-label', 'Play');

  // Listening mode: held while it plays, given back on pause
  await page.keyboard.press('KeyL');
  await expect(page.getByTestId('listening')).toBeVisible();
  await page.getByTestId('play').click();
  await expect.poll(keep).toEqual([true]);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('play')).toHaveAttribute('aria-label', 'Play');
  await expect.poll(keep).toEqual([true, false]);
  // playing, then Reading mode (the voice reads on there): given back
  await page.getByTestId('play').click();
  await expect.poll(keep).toEqual([true, false, true]);
  await page.keyboard.press('KeyL');
  await expect(page.getByTestId('listening')).toHaveCount(0);
  await expect.poll(keep).toEqual([true, false, true, false]);
  await page.keyboard.press('Space');

  // Diagnostics: the voice's settings, the CPU and threads, the AI timings (none yet), and the copy button
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'diagnostics'));
  const speed = page.getByTestId('diagnostics-speed');
  await expect(speed).toContainText(/Dream voice: \w+, fp\d+, \d+ threads?, spinning on/);
  await expect(speed).toContainText(/CPU: .+; \d+ logical CPUs?; speech recognition \d+ threads?/);
  await expect(speed).toContainText('AI first words: no timed explanation yet');
  await expect(page.getByTestId('diagnostics-text')).toContainText('platform: ');
  await page.getByTestId('diagnostics-copy').click();
  await expect(page.getByText(/^(Copied|Could not copy)/)).toBeVisible();
  if (await page.getByText(/^Copied/).isVisible()) {
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toContain('Dream voice: ');
    expect(copied).toContain('platform: ');
  }
  await app.close();
});
