import { defineConfig, devices, chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Chromium this Playwright version expects, or else any Chromium already installed under
 * PLAYWRIGHT_BROWSERS_PATH (machines where the browsers were installed by another Playwright version).
 */
function chromiumExecutable(): string | undefined {
  try { if (fs.existsSync(chromium.executablePath())) return undefined; } catch { /* not installed */ }
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!dir || !fs.existsSync(dir)) return undefined;
  for (const name of fs.readdirSync(dir).filter((n) => /^chromium(-\d+)?$/.test(n)).sort().reverse()) {
    for (const rel of ['', 'chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(dir, name, rel);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
  }
  return undefined;
}

/**
 * Smoke test of the web (iPad) build in Chromium with an iPad-sized touch viewport.
 * Run: npx playwright test -c test/web/playwright.config.ts  (builds dist/web first, see smoke.spec.ts)
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: '../../test-results/web',
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    viewport: { width: 1024, height: 1366 },
    hasTouch: true,
    deviceScaleFactor: 2,
    trace: 'retain-on-failure',
    launchOptions: { executablePath: chromiumExecutable() },
  },
});
