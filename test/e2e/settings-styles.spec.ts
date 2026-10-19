import { test, expect } from '@playwright/test';
import { launchApp } from './helpers';

const EDITED_PROMPT = 'Teach the word {{word}} in this sentence: {{sentence}} Keep it very simple.';

test.describe('explanation styles editor', () => {
  test('pick Teacher Style, edit its word prompt, duplicate it, set the copy to short, and everything survives a reload', async () => {
    const { app, page } = await launchApp();
    await page.getByTestId('nav-ai').click();
    const editor = page.getByTestId('styles-editor');
    await expect(editor).toBeVisible();
    // the ten built-in styles are listed, the custom one is active by default
    await expect(page.locator('[data-testid^="style-card-"]')).toHaveCount(10);
    await expect(page.getByTestId('style-card-custom').getByTestId('style-active-badge')).toBeVisible();

    // pick Teacher Style and make it the active one
    await page.getByTestId('style-card-teacher').click();
    await expect(page.getByTestId('style-name')).toHaveValue('Teacher Style');
    await page.getByTestId('style-use').click();
    await expect(page.getByTestId('style-card-teacher').getByTestId('style-active-badge')).toBeVisible();
    await expect(page.getByTestId('style-card-custom').getByTestId('style-active-badge')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.readalong.getSettings().then((s) => s.ai.activeStyle))).toBe('teacher');

    // edit the word prompt: saved 300 ms after the last keystroke (no blur, no save button)
    const wordPrompt = page.getByTestId('style-word-prompt');
    await wordPrompt.fill(EDITED_PROMPT);
    await expect.poll(() => page.evaluate(() => window.readalong.getSettings().then((s) => s.ai.styles.teacher?.wordPrompt)), { timeout: 5000 }).toBe(EDITED_PROMPT);
    // the sentence prompt and the shape are untouched (the patch carried only the changed field)
    const afterEdit = await page.evaluate(() => window.readalong.getSettings());
    expect(afterEdit.ai.styles.teacher?.sentencePrompt).toBeUndefined();

    // the preview shows exactly what is sent: the edited prompt, filled in, plus the knob sentences and the shared rules
    await page.getByTestId('style-preview').click();
    const user = page.getByTestId('preview-user');
    await expect(user).toContainText('Teach the word sanguine in this sentence: Mr. Darcy remained sanguine about the weather. Keep it very simple.');
    await expect(user).toContainText('about one hundred and thirty words');
    await expect(page.getByTestId('preview-system')).toContainText('The learner\'s first language is Chinese');
    await page.getByTestId('preview-sentence').click();
    await expect(user).toContainText('The sentence to teach is: Mr. Darcy remained sanguine about the weather.');

    // duplicate: a learner-made copy with the edited prompt, selected for editing but not active
    await page.getByTestId('style-duplicate').click();
    const copy = page.getByTestId('style-card-my-teacher-style-1');
    await expect(copy).toBeVisible();
    await expect(copy).toHaveClass(/selected/);
    await expect(copy).toContainText('Teacher Style (copy)');
    await expect(page.getByTestId('style-name')).toHaveValue('Teacher Style (copy)');
    await expect(page.getByTestId('style-word-prompt')).toHaveValue(EDITED_PROMPT);
    await expect(page.getByTestId('style-delete')).toBeVisible();
    await expect(page.getByTestId('style-reset')).toHaveCount(0);

    // set the copy's length to short, and its script shape
    await page.getByTestId('knob-length-short').click();
    await expect(page.getByTestId('knob-length-short')).toHaveClass(/on/);
    await page.getByTestId('shape-wordAfter').fill('1');
    await expect.poll(() => page.evaluate(() => window.readalong.getSettings().then((s) => s.ai.styles['my-teacher-style-1']?.length))).toBe('short');

    // shared context rules
    await page.getByTestId('context-before').fill('350');
    await page.getByTestId('scene-picture').check();
    await expect.poll(() => page.evaluate(() => window.readalong.getSettings().then((s) => s.ai.contextWordsBefore))).toBe(350);

    // reload the renderer: settings come back from disk through the main process
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByTestId('settings')).toBeVisible();
    const saved = await page.evaluate(() => window.readalong.getSettings());
    expect(saved.ai.activeStyle).toBe('teacher');
    expect(saved.ai.styles.teacher?.wordPrompt).toBe(EDITED_PROMPT);
    expect(saved.ai.styles['my-teacher-style-1']?.length).toBe('short');
    expect(saved.ai.styles['my-teacher-style-1']?.userMade).toBe(true);
    expect(saved.ai.styles['my-teacher-style-1']?.wordPrompt).toBe(EDITED_PROMPT);
    expect(saved.ai.styles['my-teacher-style-1']?.shape?.wordAfter).toBe(1);
    expect(saved.ai.contextWordsBefore).toBe(350);
    expect(saved.ai.contextWordsAfter).toBe(200);
    expect(saved.ai.generateScenePicture).toBe(true);

    // and the UI shows the same after the reload
    await page.getByTestId('nav-ai').click();
    await expect(page.getByTestId('style-card-teacher').getByTestId('style-active-badge')).toBeVisible();
    await expect(page.locator('[data-testid^="style-card-"]')).toHaveCount(11);
    await page.getByTestId('style-card-teacher').click();
    await expect(page.getByTestId('style-word-prompt')).toHaveValue(EDITED_PROMPT);
    await expect(page.getByTestId('style-use')).toBeDisabled();

    // reset the built-in: the prompt goes back to the default, the copy keeps the edit
    await page.getByTestId('style-reset').click();
    await expect(page.getByTestId('style-word-prompt')).not.toHaveValue(EDITED_PROMPT);
    await expect(page.getByTestId('style-word-prompt')).toHaveValue(/skilled English teacher/);
    await page.getByTestId('style-card-my-teacher-style-1').click();
    await expect(page.getByTestId('style-word-prompt')).toHaveValue(EDITED_PROMPT);

    // hide a built-in, restore it from the collapsed list; delete the copy
    await page.getByTestId('style-card-poetry').click();
    await page.getByTestId('style-hide').click();
    await expect(page.getByTestId('style-card-poetry')).toHaveCount(0);
    await expect(page.getByTestId('hidden-styles')).toContainText('Hidden styles (1)');
    await page.getByTestId('hidden-styles').locator('summary').click();
    await page.getByTestId('style-restore-poetry').click();
    await expect(page.getByTestId('style-card-poetry')).toBeVisible();
    await expect(page.getByTestId('hidden-styles')).toHaveCount(0);
    await page.getByTestId('style-card-my-teacher-style-1').click();
    await page.getByTestId('style-delete').click();
    await expect(page.getByTestId('style-card-my-teacher-style-1')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.readalong.getSettings().then((s) => s.ai.styles['my-teacher-style-1'] ?? null))).toBeNull();
    // new style from the custom defaults
    await page.getByTestId('style-new').click();
    await expect(page.getByTestId('style-card-my-style-1')).toHaveClass(/selected/);
    await expect(page.getByTestId('style-word-prompt')).toHaveValue(/Teach it like this, in one smooth spoken flow/);
    await app.close();
  });
});
