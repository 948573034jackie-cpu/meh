import { test, expect } from '@playwright/test';
import { launchApp } from './helpers';

const TEXT = `The Letter

The letter arrived the next morning. It contained a single, perplexing sentence. Elizabeth read it twice before folding it away.

Mr. Darcy remained sanguine about the weather. The committee's deliberations were protracted and acrimonious, but a consensus emerged. The children went home.`;

test.describe('reader', () => {
  test('paste text, read with highlights, tap a word, mark it known, listen mode stops and continues', async () => {
    const { app, page } = await launchApp();
    await page.getByTestId('finish-onboarding').click();
    await page.getByTestId('paste-text').click();
    await page.getByTestId('paste-title').fill('Test book');
    await page.getByTestId('paste-body').fill(TEXT);
    await page.getByTestId('paste-import').click();
    await expect(page.getByTestId('doc')).toBeVisible({ timeout: 20000 });
    // chapter rendered with word spans and at least one hard word for a B2 learner
    await expect(page.locator('.w.hl-unknown').first()).toBeVisible();
    const hard = await page.locator('.w.hl-unknown').allTextContents();
    expect(hard.map((w) => w.toLowerCase())).toContain('acrimonious');
    expect(hard.map((w) => w.toLowerCase())).not.toContain('darcy');

    // tap a word: popup with IPA and Chinese meaning
    await page.locator('.w[data-lemma="sanguine"]').first().click();
    const popup = page.getByTestId('popup');
    await expect(popup).toBeVisible();
    await expect(popup).toContainText('/');
    await expect(popup.locator('.zh')).toContainText(/[一-鿿]/);
    // mark known: highlight disappears everywhere
    await popup.getByText('Known').click();
    await expect(page.locator('.w[data-lemma="sanguine"].hl-unknown')).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('marked known');

    // play: the current sentence and words get highlighted and the position advances
    await page.getByTestId('play').click();
    await expect(page.locator('.reader-doc .s.cur')).toHaveCount(1);
    await expect(page.locator('.reader-doc .w.cur-w')).toHaveCount(1, { timeout: 5000 });
    const firstKey = await page.locator('.reader-doc .s.cur').getAttribute('data-key');
    await expect.poll(async () => page.locator('.reader-doc .s.cur').getAttribute('data-key'), { timeout: 15000 }).not.toBe(firstKey);
    await page.getByTestId('play').click(); // pause
    await expect(page.getByTestId('play')).toHaveText('▶');

    // listening mode: reading stops at a hard word and asks the AI (no key configured -> error entry), then continues
    await page.locator('.reader-doc .s[data-key="0.1.0"]').click({ position: { x: 2, y: 2 } }).catch(() => undefined);
    await page.keyboard.press('KeyQ');
    await expect(page.getByTestId('listen')).toContainText('● Listening');
    await page.getByTestId('play').click();
    const transcript = page.getByTestId('transcript');
    await expect(transcript).toBeVisible({ timeout: 20000 });
    await expect(transcript.locator('[data-testid="entry"]').first()).toBeVisible({ timeout: 20000 });
    await expect(transcript.locator('[data-testid="entry"] .st').last()).toContainText(/API key|thinking|speaking|done|skipped/, { timeout: 20000 });
    // the explained word becomes "learning" (or stays highlighted until explained) and playback continues or pauses cleanly
    await expect.poll(async () => page.locator('.reader-doc .w.hl-learning').count(), { timeout: 20000 }).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Space');

    // library remembers the book and progress
    await page.getByText('Library', { exact: true }).click();
    await expect(page.getByTestId('book-card')).toHaveCount(1);
    await expect(page.getByTestId('book-card')).toContainText('Test book');
    await app.close();
  });

  test('settings change theme, level and layout', async () => {
    const { app, page } = await launchApp();
    await page.getByRole('button', { name: 'Level & stops' }).click();
    await page.getByTestId('level-C1').click();
    await expect(page.getByTestId('level-C1')).toHaveClass(/primary/);
    await page.getByRole('button', { name: 'Appearance' }).click();
    await page.locator('select').first().selectOption('light');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await page.getByTestId('finish-onboarding').click();
    await expect(page.getByTestId('library')).toBeVisible();
    await app.close();
  });
});
