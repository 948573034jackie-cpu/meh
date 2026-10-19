import { test, expect, type Page } from '@playwright/test';
import { launchApp } from './helpers';

// Voice chat under ?e2e=1: no real microphone; the speech engine is a no-op and transcripts are injected with
// window.__dreamVoice.inject(...). window.__dreamVoice.requests lists every AI request the reader sent.

const PARAS = [
  'The letter arrived the next morning. It contained a single, perplexing sentence. Elizabeth read it twice before folding it away.',
  "Mr. Darcy remained sanguine about the weather. The committee's deliberations were protracted and acrimonious, but a consensus emerged. The children went home.",
  'The old man was thin and gaunt with deep wrinkles in the back of his neck. Everything about him was old except his eyes and they were cheerful and undefeated.',
];
const TEXT = `# Chapter 1: Voices\n\n${Array.from({ length: 3 }, () => PARAS.join('\n\n')).join('\n\n')}`;
const SHOT = process.env.VOICE_SHOT ?? '';

interface Req { kind: string; target: string; question?: string; again?: boolean; history: unknown[] }
const requests = (page: Page) => page.evaluate(() => (window.__dreamVoice?.requests ?? []) as unknown as Req[]);
const line = (page: Page) => page.evaluate(() => window.__dreamVoice?.snapshot().line ?? 'none');
/** the phase of the commands window bar ('before' / 'after'), or null when it is hidden */
const phase = (page: Page) => page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="command-bar"]')?.dataset.phase ?? null);
const inject = (page: Page, text: string, segmentId: string) => page.evaluate(([t, s]) => window.__dreamVoice!.inject({ type: 'final', text: t, segmentId: s }), [text, segmentId] as const);

test('voice chat: the pause window takes "I know", "I don\'t know" and questions; the typed box asks too', async () => {
  test.setTimeout(150_000);
  const { app, page } = await launchApp();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.getByTestId('finish-onboarding').click();
  await page.getByTestId('paste-text').click();
  await page.getByTestId('paste-title').fill('Voices');
  await page.getByTestId('paste-body').fill(TEXT);
  await page.getByTestId('paste-import').click();
  await expect(page.getByTestId('reader')).toBeVisible({ timeout: 20000 });

  // Reading mode has the round mic too (closed)
  await expect(page.getByTestId('mic')).toBeVisible();
  await expect(page.getByTestId('mic')).toHaveAttribute('data-line', 'closed');
  await page.keyboard.press('KeyL');
  await expect(page.getByTestId('listening')).toBeVisible();
  await expect(page.getByTestId('mic')).toBeVisible();

  // 1. listening pauses at a hard word: the word is said, then the 5 s window opens the voice line ("commands")
  //    before any explanation; "I know" = known, no explanation, the sentence is read again
  await page.getByTestId('play').click();
  await expect.poll(() => line(page), { timeout: 30000 }).toBe('window');
  await expect(page.getByTestId('mic')).toHaveAttribute('data-line', 'window');
  await expect(page.getByTestId('command-bar')).toHaveAttribute('data-phase', 'before');
  expect((await requests(page)).filter((r) => r.kind === 'word' || r.kind === 'phrase')).toHaveLength(0);
  const knownBefore = await page.evaluate(() => window.readalong.getVocab().then((v) => Object.keys(v.words).filter((k) => v.words[k] === 'known')));
  await inject(page, 'I know', 'e2e:1');
  // the word of this stop is known now (saved for good)
  await expect.poll(() => page.evaluate((before) => window.readalong.getVocab().then((v) => Object.keys(v.words).filter((k) => v.words[k] === 'known' && !before.includes(k)).length), knownBefore), { timeout: 3000 }).toBe(1);
  const lemma = await page.evaluate((before) => window.readalong.getVocab().then((v) => Object.keys(v.words).find((k) => v.words[k] === 'known' && !before.includes(k))!), knownBefore);
  await expect(page.locator(`.w[data-lemma="${lemma}"].hl-unknown`)).toHaveCount(0);
  await expect(page.getByTestId('command-bar')).toHaveCount(0);
  expect((await requests(page)).some((r) => r.target.toLowerCase() === lemma)).toBe(false);
  await expect(page.getByTestId('play')).toHaveAttribute('aria-label', 'Pause');
  expect(await line(page)).toBe('closed');

  // 2. the next hard word: anything else the learner says in the window is ignored (never sent to the AI);
  //    when the 5 seconds run out the explanation starts on its own
  await expect.poll(async () => (await line(page)) === 'window' && (await phase(page)) === 'before', { timeout: 40000 }).toBe(true);
  await inject(page, 'what is that', 'e2e:2');
  await expect.poll(async () => (await requests(page)).some((r) => r.kind === 'word' || r.kind === 'phrase'), { timeout: 15000 }).toBe(true);
  expect((await requests(page)).some((r) => r.question === 'what is that')).toBe(false);
  const second = (await requests(page)).filter((r) => r.kind === 'word' || r.kind === 'phrase').at(-1)!;

  // 3. after its explanation the window opens again: "I don't know" asks for a second, deeper explanation,
  //    then the window again, where anything else is a question about the sentence
  await expect.poll(async () => (await line(page)) === 'window' && (await phase(page)) === 'after', { timeout: 30000 }).toBe(true);
  await inject(page, "I don't know", 'e2e:3');
  await expect.poll(async () => (await requests(page)).some((r) => r.target === second.target && r.again === true), { timeout: 5000 }).toBe(true);
  await expect.poll(async () => (await line(page)) === 'window' && (await phase(page)) === 'after', { timeout: 30000 }).toBe(true);
  await inject(page, 'what does this mean', 'e2e:4');
  await page.waitForTimeout(500);
  expect((await requests(page)).some((r) => r.question === 'what does this mean')).toBe(false); // the window takes commands only

  // 3b. the keys work in the window too: D before the explanation starts it, Esc after it goes on
  await expect.poll(async () => (await phase(page)) === 'before', { timeout: 60000 }).toBe(true);
  const beforeD = (await requests(page)).length;
  await page.keyboard.press('KeyD');
  await expect.poll(async () => (await requests(page)).length > beforeD, { timeout: 5000 }).toBe(true);
  await expect.poll(async () => phase(page), { timeout: 30000 }).toBe('after');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-bar')).toHaveCount(0);

  // 4. the typed box (no mic needed) sends a question too, and the popover shows both sides
  await page.getByTestId('voice-more').click();
  await expect(page.getByTestId('voice-popover')).toBeVisible();
  await expect(page.getByTestId('voice-popover')).toContainText('Pronunciation does not matter, you can type.');
  await expect(page.getByTestId('voice-popover')).not.toContainText(/\bstop\b/i);
  await page.getByTestId('voice-text').fill('Why is the committee angry?');
  await page.getByTestId('voice-send').click();
  await expect.poll(async () => (await requests(page)).some((r) => r.kind === 'question' && r.question === 'Why is the committee angry?'), { timeout: 5000 }).toBe(true);
  await expect(page.getByTestId('voice-popover')).toContainText('Why is the committee angry?');

  // 5. the explanations drawer shows You / Tutor
  await page.getByTestId('transcript-toggle').click();
  await expect(page.getByTestId('transcript')).toContainText('You');
  await expect(page.getByTestId('transcript')).toContainText('Why is the committee angry?');
  await expect(page.locator('.voice-dock.shifted')).toHaveCount(1);
  await page.getByTestId('transcript-toggle').click();

  // 6. the mic button opens a call (M too); a spoken question in the call; "bye bye" closes it
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // the typed box may still have the focus
  await page.keyboard.press('Space'); // pause the book
  await page.keyboard.press('KeyM');
  await expect(page.getByTestId('mic')).toHaveAttribute('data-line', 'call');
  await page.evaluate(() => window.__dreamVoice!.inject({ type: 'speechStart', segmentId: 'e2e:5' }));
  await inject(page, 'is he happy', 'e2e:5');
  await expect.poll(async () => (await requests(page)).some((r) => r.kind === 'question' && r.question === 'is he happy'), { timeout: 5000 }).toBe(true);
  await page.waitForTimeout(1100); // commands are debounced (1 s)
  await inject(page, 'bye bye', 'e2e:6');
  await expect(page.getByTestId('mic')).toHaveAttribute('data-line', 'closed');

  if (SHOT) {
    await page.getByTestId('mic').click(); // the call is open again: the button pulses
    await expect(page.getByTestId('mic')).toHaveAttribute('data-line', 'call');
    await page.getByTestId('voice-text').fill('What does “acrimonious” mean here?');
    await page.waitForTimeout(400);
    await page.screenshot({ path: SHOT });
  }
  await app.close();
});
