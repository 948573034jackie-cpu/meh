// Recolors the page with two full-screen overlays placed in the browser's top layer:
//   lift  (mix-blend-mode: screen)   raises pure black up to the mode's text/background color
//   tint  (mix-blend-mode: multiply) lowers pure white down to the mode's paper color
// Together they map every pixel — text, images, videos, canvases — onto the mode's palette.
// Dark modes also invert light pages with a CSS filter first (see content.css).
(() => {
  if (window.top !== window || window.__eyecareLoaded) return;
  window.__eyecareLoaded = true;

  const root = document.documentElement;
  const host = location.hostname;
  let settings = { ...EYECARE_DEFAULTS };
  let pageIsDark = false; // the site already has a dark theme, so do not invert it

  const overlays = ['screen', 'multiply'].map((blend) => {
    const el = document.createElement('eyecare-overlay');
    el.setAttribute('popover', 'manual');
    el.setAttribute('aria-hidden', 'true');
    const style = {
      position: 'fixed', inset: '0', width: '100vw', height: '100vh', margin: '0', padding: '0',
      border: '0', 'max-width': 'none', 'max-height': 'none', overflow: 'hidden', opacity: '1',
      'pointer-events': 'none', 'mix-blend-mode': blend, background: 'transparent',
      transition: 'none', 'z-index': '2147483647'
    };
    for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v, 'important');
    return el;
  });
  const [lift, tint] = overlays;

  const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const css = (rgb) => `rgb(${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v)))).join(',')})`;

  function enabledMode() {
    if (settings.disabledSites.includes(host)) return eyecareMode('original');
    return eyecareMode(settings.mode);
  }

  function apply() {
    const mode = enabledMode();
    const invert = mode.dark && !pageIsDark && !document.fullscreenElement;
    if (invert) root.setAttribute('data-eyecare-invert', '');
    else root.removeAttribute('data-eyecare-invert');

    if (mode.id === 'original') {
      overlays.forEach(hide);
      return;
    }
    // Light pages map white -> top color and black -> bottom color.
    const top = hexToRgb(mode.dark ? mode.fg : mode.bg);
    const bottom = hexToRgb(mode.dark ? mode.bg : mode.fg);
    const b = settings.brightness / 100;
    const liftRgb = top.map((t, i) => (t ? (bottom[i] / t) * 255 : 0));
    const tintRgb = top.map((t) => t * b);

    lift.style.setProperty('background', css(liftRgb), 'important');
    tint.style.setProperty('background', css(tintRgb), 'important');
    const needLift = liftRgb.some((v) => v > 0);
    const needTint = tintRgb.some((v) => v < 255);
    // The lift layer must sit below the tint layer; reopen the tint so it lands on top.
    if (needLift && !shown.has(lift) && shown.has(tint)) { try { tint.hidePopover(); } catch (e) {} }
    needLift ? show(lift) : hide(lift);
    needTint ? show(tint) : hide(tint);
  }

  const shown = new Set();
  const isOpen = (el) => el.matches(':popover-open');
  function show(el) {
    shown.add(el);
    if (el.parentNode !== root) root.appendChild(el);
    try { if (!isOpen(el)) el.showPopover(); } catch (e) {}
  }
  function hide(el) {
    shown.delete(el);
    try { if (isOpen(el)) el.hidePopover(); } catch (e) {}
    el.remove();
  }
  // Fullscreen players and page dialogs join the top layer above us; move back on top.
  function raise() {
    for (const el of overlays) {
      if (!shown.has(el)) continue;
      try { if (isOpen(el)) el.hidePopover(); } catch (e) {}
    }
    apply();
  }

  // ---- Is the site already dark? (Then dark modes only warm/dim it.) ----
  function lum(color) {
    const m = color.match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    const a = m.length > 3 ? parseFloat(m[3]) : 1;
    if (a < 0.5) return null;
    const [r, g, bl] = m.slice(0, 3).map((v) => {
      const c = parseFloat(v) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  }
  function detectDark() {
    if (!document.body) return;
    const points = [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.25, 0.75], [0.75, 0.75]];
    const values = points.map(([x, y]) => {
      let el = document.elementFromPoint(innerWidth * x, innerHeight * y);
      for (; el; el = el.parentElement) {
        const l = lum(getComputedStyle(el).backgroundColor);
        if (l !== null) return l;
      }
      return 1; // nothing painted: the browser's default white canvas
    }).sort((a, b) => a - b);
    const dark = values[2] < 0.18; // median darker than roughly #777
    if (dark !== pageIsDark) {
      pageIsDark = dark;
      chrome.storage.local.set({ ['dark:' + host]: dark });
      apply();
    }
  }

  // ---- Wiring ----
  chrome.storage.local.get('dark:' + host, (r) => {
    pageIsDark = !!r['dark:' + host];
    chrome.storage.sync.get(null, (s) => {
      settings = { ...EYECARE_DEFAULTS, ...s };
      apply();
    });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue ?? EYECARE_DEFAULTS[k];
    apply();
    if (enabledMode().dark) detectDark();
  });

  const check = () => { if (enabledMode().dark) detectDark(); };
  document.addEventListener('DOMContentLoaded', check);
  window.addEventListener('load', () => { check(); setTimeout(check, 1500); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });

  document.addEventListener('fullscreenchange', raise);
  document.addEventListener('toggle', (e) => { if (e.target.localName !== 'eyecare-overlay' && e.newState === 'open') raise(); }, true);

  // Some sites rewrite <html>; put our attribute and overlays back if they vanish.
  new MutationObserver(() => {
    const mode = enabledMode();
    const wantInvert = mode.dark && !pageIsDark && !document.fullscreenElement;
    if (wantInvert !== root.hasAttribute('data-eyecare-invert') ||
        [...shown].some((el) => el.parentNode !== root || !isOpen(el))) {
      apply();
    }
  }).observe(root, { attributes: true, attributeFilter: ['data-eyecare-invert'], childList: true });
})();
