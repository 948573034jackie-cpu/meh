import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Launches the built app with a fresh data folder. By default the first-start level test is marked as already
 * taken (so the app opens on the settings tour, as before); pass { levelTest: true } to see the level test first.
 */
export async function launchApp(opts: { levelTest?: boolean } = {}): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-read-e2e-'));
  if (!opts.levelTest) {
    fs.mkdirSync(path.join(userData, 'data'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'data', 'settings.json'), JSON.stringify({ version: 1, level: { model: null, lastResult: null, testedAt: '2026-01-01T00:00:00.000Z' } }));
  }
  const app = await electron.launch({
    args: ['--no-sandbox', '--disable-gpu', path.resolve(__dirname, '../../dist/main/index.js')],
    env: { ...process.env, READALONG_USER_DATA: userData, READALONG_E2E: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userData };
}
