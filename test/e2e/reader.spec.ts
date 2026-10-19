import { test, expect, type Page } from '@playwright/test';
import { launchApp } from './helpers';

const PARAS = [
  'The letter arrived the next morning. It contained a single, perplexing sentence. Elizabeth read it twice before folding it away.',
  "Mr. Darcy remained sanguine about the weather. The committee's deliberations were protracted and acrimonious, but a consensus emerged. The children went home.",
  'He was an old man who fished alone in a skiff in the Gulf Stream and he had gone eighty-four days now without taking a fish. In the first forty days a boy had been with him. But after forty days without a fish the boy\'s parents had told him that the old man was now definitely and finally salao, which is the worst form of unlucky.',
  'The old man was thin and gaunt with deep wrinkles in the back of his neck. The brown blotches of the benevolent skin cancer the sun brings from its reflection on the tropic sea were on his cheeks. Everything about him was old except his eyes and they were the same color as the sea and were cheerful and undefeated.',
];
/** three chapters, each long enough for several pages at 1200x800 */
const TEXT = [1, 2, 3].map((n) => `# Chapter ${n}: Part ${n}\n\n${Array.from({ length: 4 }, () => PARAS.join('\n\n')).join('\n\n')}`).join('\n\n');

async function importBook(page: Page, title = 'Test book'): Promise<void> {
  await page.getByTestId('paste-text').click();
  await page.getByTestId('paste-title').fill(title);
  await page.getByTestId('paste-body').fill(TEXT);
  await page.getByTestId('paste-import').click();
  await expect(page.getByTestId('reader')).toBeVisible({ timeout: 20000 });
}

test.describe('reader', () => {
  test('reading mode: pages, tap zones, hints, card, progress text; listening mode: lines, timeline, card; switching keeps the position', async () => {
    const { app, page } = await launchApp();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.getByTestId('finish-onboarding').click();
    await importBook(page);

    // a new book opens in Reading mode, full screen (no app title bar), with hard words highlighted and hinted
    await expect(page.getByTestId('reading')).toBeVisible();
    await expect(page.locator('.titlebar')).toHaveCount(0);
    await expect(page.locator('.w.hl-unknown').first()).toBeVisible();
    const hard = await page.locator('.w.hl-unknown').allTextContents();
    expect(hard.map((w) => w.toLowerCase())).toContain('acrimonious');
    expect(hard.map((w) => w.toLowerCase())).not.toContain('darcy');
    await expect(page.locator('.w[data-hint]').first()).toBeVisible();
    const hint = await page.locator('.w[data-lemma="acrimonious"][data-hint]').first().getAttribute('data-hint');
    expect(hint).toMatch(/[一-鿿]/);
    expect(hint!.length).toBeLessThanOrEqual(6);

    // progress text cycles on click
    await expect(page.getByTestId('progress-text')).toHaveText(/^Page 1 of \d+$/);
    await page.getByTestId('progress-text').click();
    await expect(page.getByTestId('progress-text')).toHaveText(/left in chapter$/);
    await page.getByTestId('progress-text').click();
    await expect(page.getByTestId('progress-text')).toHaveText(/left in book$/);
    await page.getByTestId('progress-text').click();
    await expect(page.getByTestId('progress-text')).toHaveText(/^\d+%$/);
    await page.getByTestId('progress-text').click();

    // tap the right fifth of the page: page 2 of the chapter
    await expect(page.locator('.page-count')).toHaveText(/^1 \/ \d+ in chapter$/);
    await page.getByTestId('doc').click({ position: { x: 1120, y: 400 } });
    await expect(page.locator('.page-count')).toHaveText(/^2 \/ \d+ in chapter$/);
    await page.getByTestId('doc').click({ position: { x: 60, y: 400 } });
    await expect(page.locator('.page-count')).toHaveText(/^1 \/ \d+ in chapter$/);
    await page.keyboard.press('PageDown');
    await expect(page.locator('.page-count')).toHaveText(/^2 \/ \d+ in chapter$/);

    // tap a word: the card opens under it and the spoken explanation starts at once; it closes by itself after the explanation
    await page.keyboard.press('PageUp');
    await expect(page.locator('.page-count')).toHaveText(/^1 \/ \d+ in chapter$/);
    const word = page.locator('.w[data-lemma="sanguine"]').first();
    await word.click();
    const card = page.getByTestId('card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('/');
    await expect(card.locator('.zh')).toContainText(/[一-鿿]/);
    await expect(card.locator('.lvl').first()).toContainText(/C1|C2|B2/);
    await expect(card).toHaveAttribute('data-status', /thinking|speaking|done|error|skipped/, { timeout: 10000 });
    await expect(card).toHaveCount(0, { timeout: 20000 });
    // in Reading mode the voice stays paused after an explanation
    await expect(page.getByTestId('play')).toHaveAttribute('aria-label', 'Play');

    // "I know" from the card: the highlight and the hint disappear everywhere
    await page.locator('.w[data-lemma="acrimonious"]').first().click();
    await expect(card).toBeVisible();
    await card.getByTestId('card-known').click();
    await expect(page.locator('.w[data-lemma="acrimonious"].hl-unknown')).toHaveCount(0);
    await expect(page.locator('.w[data-lemma="acrimonious"][data-hint]')).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('marked known');

    // play: the sentence is highlighted while the voice reads and the position advances
    await page.getByTestId('play').click();
    await expect(page.locator('.reading.playing .s.cur')).toHaveCount(1);
    await expect(page.locator('.w.cur-w')).toHaveCount(1, { timeout: 5000 });
    const firstKey = await page.locator('.s.cur').getAttribute('data-key');
    await expect.poll(async () => page.locator('.s.cur').getAttribute('data-key'), { timeout: 15000 }).not.toBe(firstKey);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('play')).toHaveAttribute('aria-label', 'Play');
    const keyBefore = await page.locator('.s.cur').getAttribute('data-key');

    // L: Listening mode, same position, the current sentence large
    await page.keyboard.press('KeyL');
    await expect(page.getByTestId('listening')).toBeVisible();
    await expect(page.locator('.listen-lines .s.cur')).toHaveAttribute('data-key', keyBefore!);
    const sizes = await page.evaluate(() => {
      const cur = document.querySelector('.listen-lines .s.cur')!;
      const other = Array.from(document.querySelectorAll('.listen-lines .para.k-p .s')).find((s) => s !== cur)!;
      return [parseFloat(getComputedStyle(cur).fontSize), parseFloat(getComputedStyle(other).fontSize)];
    });
    expect(sizes[0]).toBeGreaterThan(sizes[1] * 1.2);
    // timeline: chapter marks and a total time
    await expect(page.getByTestId('chapter-mark')).toHaveCount(2);
    await expect(page.getByTestId('clock-total')).toHaveText(/^\d+:\d\d$/);
    await expect(page.getByTestId('mic')).toBeEnabled();

    // play: the sentence advances and the text follows
    await page.getByTestId('play').click();
    await expect.poll(async () => page.locator('.listen-lines .s.cur').getAttribute('data-key'), { timeout: 15000 }).not.toBe(keyBefore);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('play')).toHaveAttribute('aria-label', 'Play');

    // tap a word in Listening mode: card, explanation, auto-dismiss
    const w2 = page.locator('.listen-lines .w.hl-unknown').first();
    await w2.scrollIntoViewIfNeeded();
    await w2.click();
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-status', /thinking|speaking|done|error|skipped/, { timeout: 10000 });
    await expect(card).toHaveCount(0, { timeout: 20000 });

    // help sheet
    await page.keyboard.press('Shift+Slash');
    await expect(page.getByTestId('help')).toBeVisible();
    await expect(page.getByTestId('help')).toContainText('Switch between Reading and Listening');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('help')).toHaveCount(0);

    // the switch button goes back to Reading mode at the same sentence
    const keyListen = await page.locator('.listen-lines .s.cur').getAttribute('data-key');
    await page.getByTestId('switch-mode').click();
    await expect(page.getByTestId('reading')).toBeVisible();
    await expect(page.locator('.pages .s.cur')).toHaveAttribute('data-key', keyListen!);

    // the mode is remembered per book: leave in Listening mode, reopen from the library
    await page.getByTestId('switch-mode').click();
    await expect(page.getByTestId('listening')).toBeVisible();
    await page.getByText('Library', { exact: true }).click();
    await expect(page.getByTestId('book-card')).toHaveCount(1);
    await page.getByTestId('book-card').click();
    await expect(page.getByTestId('listening')).toBeVisible();
    const saved = await page.evaluate(() => window.readalong.getSettings());
    expect(saved.lastMode).toBe('listening');
    expect(Object.values(saved.bookModes)).toContain('listening');
    await app.close();
  });

  test('listening mode stops at a hard word, shows the card, and goes on', async () => {
    const { app, page } = await launchApp();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.getByTestId('finish-onboarding').click();
    await importBook(page, 'Stops');
    await page.keyboard.press('KeyL');
    await expect(page.getByTestId('listening')).toBeVisible();
    await page.getByTestId('play').click();
    // the first hard word ("perplexing" or "sanguine") stops the voice: a card appears by itself
    const card = page.getByTestId('card');
    await expect(card).toBeVisible({ timeout: 20000 });
    await expect(card).toHaveAttribute('data-status', /thinking|speaking|done|error|skipped/);
    const stoppedAt = await page.locator('.listen-lines .s.cur').getAttribute('data-key');
    await expect(card).toHaveCount(0, { timeout: 20000 });
    // after the explanation and the short pause the voice carries on with the book
    await expect.poll(async () => page.locator('.listen-lines .s.cur').getAttribute('data-key'), { timeout: 25000 }).not.toBe(stoppedAt);
    await expect(page.getByTestId('play')).toHaveAttribute('aria-label', 'Pause');
    await page.keyboard.press('Space');
    await app.close();
  });

  test('settings change theme, level and layout', async () => {
    const { app, page } = await launchApp();
    await page.getByRole('button', { name: 'Level & stops' }).click();
    await page.getByTestId('level-C1').click();
    await expect(page.getByTestId('level-C1')).toHaveClass(/primary/);
    await page.getByRole('button', { name: 'Reading look' }).click();
    await page.getByTestId('theme-light').click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await page.getByTestId('theme-sepia').click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('sepia');
    // sizes: the slider updates the CSS variables at once and survives a settings round-trip
    await page.getByTestId('size-subtitle').fill('30');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--subtitle-size').trim())).toBe('30px');
    await page.getByTestId('layout').selectOption('scroll');
    const saved = await page.evaluate(() => window.readalong.getSettings());
    expect(saved.appearance.theme).toBe('sepia');
    expect(saved.appearance.subtitleSizePx).toBe(30);
    expect(saved.appearance.layout).toBe('scroll');
    expect(saved.appearance.maxLineChars).toBe(70);
    expect(saved.appearance.showTips).toBe(true);
    expect(saved.appearance.showHints).toBe(true);
    await page.getByTestId('finish-onboarding').click();
    await expect(page.getByTestId('library')).toBeVisible();
    await app.close();
  });
});
