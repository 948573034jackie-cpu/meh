/**
 * Runs before the renderer: installs the browser implementation of window.readalong, registers the service
 * worker (offline app shell + dictionary), asks for persistent storage and, in iPad Safari (not yet on the
 * home screen), shows a one-time hint on how to add the app to the home screen.
 */
import { createWebApi } from './api';
import { requestPersistence } from './idb';

window.readalong = createWebApi();
document.documentElement.dataset.web = '1';

const standalone = (): boolean =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
if (standalone()) document.documentElement.dataset.standalone = '1';

/** iPadOS reports itself as a Mac; touch points tell them apart. */
export function isIpad(): boolean {
  return /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

const E2E = new URLSearchParams(location.search).has('e2e');

if ('serviceWorker' in navigator && window.isSecureContext && !E2E) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[web] service worker not registered', e));
  });
}

void requestPersistence();

const HINT_KEY = 'dream-read:install-hint-dismissed';
function showInstallHint(): void {
  try { if (localStorage.getItem(HINT_KEY)) return; } catch { return; }
  const box = document.createElement('div');
  box.className = 'web-install-hint';
  box.setAttribute('role', 'note');
  const text = document.createElement('span');
  text.textContent = 'To use Dream Read like an app (full screen, works offline), tap the Share button, then "Add to Home Screen".';
  const ok = document.createElement('button');
  ok.textContent = 'OK';
  ok.addEventListener('click', () => { try { localStorage.setItem(HINT_KEY, '1'); } catch { /* private mode */ } box.remove(); });
  box.append(text, ok);
  document.body.appendChild(box);
}
if (isIpad() && !standalone() && !E2E) window.addEventListener('load', () => setTimeout(showInstallHint, 1500));
