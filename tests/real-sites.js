// Runs the YouTube extension against the REAL youtube.com / chatgpt.com / claude.ai pages (from a GitHub server).
// It never presses Send: chat pages are only checked with a "dry run".
const { chromium } = require('playwright');
const path = require('path');

const EXT = path.resolve(__dirname, '../youtube-to-claude');
const VIDEOS = [
  'https://www.youtube.com/watch?v=iG9CE55wbtY',   // TED talk with typed English captions
  'https://www.youtube.com/watch?v=jNQXAC9IVRw',   // first YouTube video (auto captions)
];
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const limit = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error('timed out: ' + what); })]);
setTimeout(() => { console.log('HARD STOP after 4 minutes'); process.exit(0); }, 240000);

(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/real-profile', {
    headless: false,
    args: ['--headless=new', '--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
           '--autoplay-policy=no-user-gesture-required', '--lang=en-US'],
    locale: 'en-US', viewport: { width: 1280, height: 800 }
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  log('extension loaded:', sw.url());

  // ------------- YouTube -------------
  for (const url of VIDEOS) {
    log('\n=== YouTube:', url);
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(6000);
      const consent = await page.$('button[aria-label*="Accept"], button:has-text("Accept all")');
      if (consent) { await consent.click().catch(() => {}); await page.waitForTimeout(3000); }
      log('title:', await page.title());
      const info = await limit(sw.evaluate(async () => {
        const [t] = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
        try { return await chrome.tabs.sendMessage(t.id, { type: 'yt-get' }); } catch (e) { return { error: e.message }; }
      }), 40000, 'yt-get');
      log('transcript result:', JSON.stringify({ title: info.title, lines: info.lines, source: info.source, errors: info.errors, error: info.error }));
      if (info.transcript) log('first lines:\n' + info.transcript.split('\n').slice(0, 4).join('\n'));

      // pause -> subtitles on the real player
      const state = await page.evaluate(async () => {
        const v = document.querySelector('video');
        if (!v) return { noVideo: true };
        v.muted = true;
        try { await Promise.race([v.play(), new Promise((r) => setTimeout(r, 4000))]); } catch (e) {}
        await new Promise((r) => setTimeout(r, 1500));
        v.currentTime = Math.min(60, (v.duration || 100) / 3);
        await new Promise((r) => setTimeout(r, 1500));
        v.pause();
        return { t: v.currentTime, paused: v.paused, duration: v.duration };
      });
      log('video state:', JSON.stringify(state));
      await page.waitForTimeout(2500);
      const ov = await page.evaluate(() => {
        const e = document.getElementById('yt2c-overlay');
        const p = document.getElementById('movie_player');
        if (!e) return null;
        const b = document.getElementById('yt2c-body');
        const r = e.getBoundingClientRect(), pr = p ? p.getBoundingClientRect() : null;
        return { text: (b ? b.innerText : '').slice(0, 300), font: b ? getComputedStyle(b).fontSize : null,
                 overlay: [Math.round(r.width), Math.round(r.height)], player: pr && [Math.round(pr.width), Math.round(pr.height)] };
      });
      log('overlay on the real page:', JSON.stringify(ov));
      await page.screenshot({ path: '/tmp/yt-' + VIDEOS.indexOf(url) + '.png' });
    } catch (e) { log('YouTube step failed:', e.message); }
    await page.close();
  }

  // ------------- ChatGPT / Claude (logged out, dry run) -------------
  for (const [name, url] of [['ChatGPT', 'https://chatgpt.com/'], ['Claude', 'https://claude.ai/new']]) {
    log('\n=== ' + name + ':', url);
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(7000);
      log('landed on:', page.url(), '| title:', await page.title());
      const res = await limit(sw.evaluate(async (pattern) => {
        const [t] = await chrome.tabs.query({ url: pattern });
        if (!t) return { error: 'no tab' };
        try { return await chrome.tabs.sendMessage(t.id, { type: 'chat-send', text: 'dry run test message', dryRun: true }); }
        catch (e) { return { error: e.message }; }
      }, url.replace(/\/new$/, '/') .replace(/\/$/, '/*')), 40000, 'chat dry run');
      log('dry run result:', JSON.stringify(res));
      await page.screenshot({ path: '/tmp/chat-' + name + '.png' });
    } catch (e) { log(name + ' step failed:', e.message); }
    await page.close();
  }
  await ctx.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
