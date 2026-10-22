import { test, expect, type Page, type ElectronApplication } from '@playwright/test';
import { launchApp } from './helpers';

// Listening stops with the explanation prepared at the pause (docs/RULES.md 1): the main process's ai:explain is
// replaced by a fake that answers like a streaming model (first text after 300 ms), so the timing can be checked.

const PARAS = [
  'The letter arrived the next morning. It contained a single, perplexing sentence. Elizabeth read it twice before folding it away.',
  "Mr. Darcy remained sanguine about the weather. The committee's deliberations were protracted and acrimonious, but a consensus emerged. The children went home.",
  'The old man was thin and gaunt with deep wrinkles in the back of his neck. Everything about him was old except his eyes and they were cheerful and undefeated.',
];
const TEXT = `# Chapter 1: Stops\n\n${Array.from({ length: 3 }, () => PARAS.join('\n\n')).join('\n\n')}`;

interface FakeCall { at: number; kind: string; target: string; streamId: string; question?: string }
interface Marks { barShown: number[]; barGone: number[]; speaking: number[] }

/** Replaces ai:explain / ai:cancel in the main process; every call and cancel is recorded in globalThis.__fakeAi. */
async function installFakeAi(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __fakeAi: { calls: FakeCall[]; cancels: string[]; timers: Record<string, ReturnType<typeof setTimeout>[]> } };
    g.__fakeAi = { calls: [], cancels: [], timers: {} };
    let n = 0;
    ipcMain.removeHandler('ai:explain');
    ipcMain.removeHandler('ai:cancel');
    ipcMain.handle('ai:explain', (e, req: { kind: string; target: string; question?: string }) => {
      const streamId = `fake${++n}`;
      g.__fakeAi.calls.push({ at: Date.now(), kind: req.kind, target: req.target, streamId, question: req.question });
      const first = `${req.target} is a word that matters here. `;
      const reply = `${first}It tells you how the person feels in this moment.`;
      const send = (ev: unknown) => { if (!e.sender.isDestroyed()) e.sender.send('ai:event', ev); };
      g.__fakeAi.timers[streamId] = [
        setTimeout(() => send({ type: 'delta', streamId, text: first }), 300),
        setTimeout(() => send({ type: 'delta', streamId, text: reply.slice(first.length) }), 600),
        setTimeout(() => send({ type: 'done', streamId, text: reply, usage: { inputTokens: 2000, outputTokens: 40, cachedTokens: 1000, usd: 0.01, dailyUsd: 0.01, monthlyUsd: 0.01, model: 'fake' } }), 700),
      ];
      return { streamId };
    });
    // the renderer stops listening to a stream it cancels: nothing more is sent for it
    ipcMain.handle('ai:cancel', (_e, id: string) => {
      g.__fakeAi.cancels.push(id);
      for (const t of g.__fakeAi.timers[id] ?? []) clearTimeout(t);
    });
  });
}

const fakeAi = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __fakeAi: { calls: FakeCall[]; cancels: string[] } }).__fakeAi);

/** Records (Date.now()) when the 'before' command bar appears and goes, and when the card starts speaking. */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const m: Marks = { barShown: [], barGone: [], speaking: [] };
    (window as unknown as { __marks: Marks }).__marks = m;
    let bar = false; let speaking = false;
    new MutationObserver(() => {
      const b = !!document.querySelector('[data-testid="command-bar"][data-phase="before"]');
      if (b !== bar) { bar = b; (b ? m.barShown : m.barGone).push(Date.now()); }
      const s = document.querySelector('[data-testid="card"]')?.getAttribute('data-status') === 'speaking';
      if (s !== speaking) { speaking = s; if (s) m.speaking.push(Date.now()); }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status', 'data-phase'] });
  });
}
const marks = (page: Page) => page.evaluate(() => (window as unknown as { __marks: Marks }).__marks);

test('listening prefetch: asked at the pause, spoken the moment the window ends, the window never restarts, "I know" cancels', async () => {
  test.setTimeout(120_000);
  const { app, page } = await launchApp();
  await page.setViewportSize({ width: 1200, height: 800 });
  await installFakeAi(app);
  await page.getByTestId('finish-onboarding').click();
  await page.getByTestId('paste-text').click();
  await page.getByTestId('paste-title').fill('Stops');
  await page.getByTestId('paste-body').fill(TEXT);
  await page.getByTestId('paste-import').click();
  await expect(page.getByTestId('reader')).toBeVisible({ timeout: 20000 });
  await page.keyboard.press('KeyL');
  await expect(page.getByTestId('listening')).toBeVisible();
  await watch(page);

  // 1. the stop: the explanation is asked for before the window (and its bar) opens
  await page.getByTestId('play').click();
  const bar = page.getByTestId('command-bar');
  await expect(bar).toHaveAttribute('data-phase', 'before', { timeout: 30000 });
  let m = await marks(page);
  let ai = await fakeAi(app);
  const words = ai.calls.filter((c) => c.kind === 'word' || c.kind === 'phrase');
  expect(words).toHaveLength(1);
  expect(words[0].question).toBeUndefined();
  expect(words[0].at).toBeLessThan(m.barShown[0]);

  // 2. the learner starts talking in the window (repeats the word): the bar is not restarted
  const countdown = page.locator('.command-countdown span');
  await countdown.evaluate((el) => { el.setAttribute('data-mark', 'first'); });
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.__dreamVoice!.snapshot().line)).toBe('window'); // the mic listens for commands
  await page.evaluate(() => window.__dreamVoice!.inject({ type: 'speechStart', segmentId: 'e2e:speech' }));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__dreamVoice!.inject({ type: 'speechEnd', segmentId: 'e2e:speech' }));
  await page.waitForTimeout(300);
  await expect(countdown).toHaveAttribute('data-mark', 'first'); // the same countdown element: never restarted
  expect((await fakeAi(app)).calls).toHaveLength(ai.calls.length); // nothing said in the window is sent

  // 3. silence: the prepared explanation starts the moment the window ends
  await expect(bar).toHaveAttribute('data-phase', 'after', { timeout: 20000 });
  m = await marks(page);
  expect(m.barGone).toHaveLength(1);
  expect(m.barGone[0] - m.barShown[0]).toBeGreaterThanOrEqual(4900);
  expect(m.barGone[0] - m.barShown[0]).toBeLessThan(5600); // the speech at about 1 s did not move the end
  expect(m.speaking.length).toBeGreaterThanOrEqual(1);
  expect(m.speaking[0] - m.barGone[0]).toBeLessThan(300);
  ai = await fakeAi(app);
  expect(ai.calls.filter((c) => c.kind === 'word' || c.kind === 'phrase')).toHaveLength(1); // no second request
  await page.keyboard.press('Escape'); // go on
  await expect(bar).toHaveCount(0);

  // 4. the next stop: "I know" (K) drops the prepared request (ai:cancel reaches the main process)
  await expect.poll(async () => (await marks(page)).barShown.length, { timeout: 40000 }).toBe(2);
  ai = await fakeAi(app);
  const second = ai.calls.filter((c) => c.kind === 'word' || c.kind === 'phrase').at(-1)!;
  expect(second.streamId).not.toBe(words[0].streamId);
  expect(ai.cancels).not.toContain(second.streamId);
  await page.keyboard.press('KeyK');
  await expect(bar).toHaveCount(0);
  await expect.poll(async () => (await fakeAi(app)).cancels, { timeout: 5000 }).toContain(second.streamId);
  m = await marks(page);
  expect(m.speaking).toHaveLength(1); // nothing of it was said
  await app.close();
});
