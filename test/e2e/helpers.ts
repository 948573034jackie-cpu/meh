import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function launchApp(): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-read-e2e-'));
  const app = await electron.launch({
    args: ['--no-sandbox', '--disable-gpu', path.resolve(__dirname, '../../dist/main/index.js')],
    env: { ...process.env, READALONG_USER_DATA: userData, READALONG_E2E: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userData };
}
