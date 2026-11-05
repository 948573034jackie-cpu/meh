// Safari (iPhone/iPad): My tutor's buttons at the bottom of the YouTube page. There is no keyboard on the phone, so this
// bar does what the tutor's keyboard shortcuts do on a Mac (the same bar as in the YT Learn app). It runs after
// dream/dream-yt.js in the same content-script world and drives it through window.__ytcDream.action(id).
(function () {
  if (window.__ytcTutorBar) return;
  window.__ytcTutorBar = true;

  // A very simple bar. With the tutor's own switch, the first four are in view on an iPhone (375 px wide): play / stop,
  // explain the last N seconds, explain the last sentence, call the tutor. Swipe the bar sideways for the rest.
  const BUTTONS = [
    ['stop', '⏯', 'Play / stop'],
    ['explainLast', '💬', 'Explain 20 s'],
    ['explainSentence', '↩', 'Sentence'],
    ['talk', '📞', 'Call'],
    ['voiceMode', '🎤', 'Voice'],
    ['sleep', '🌙', 'Sleep'],
    ['vocab', '📒', 'Words'],
    ['quick', '⚙', 'Settings'],
  ];
  let tutorOn = true;
  let explainSeconds = 20; // the tutor's part length (drSettings.listen.lastSecondsWindow)
  let bar = null;
  let barH = -1; // the bar's height as last published (--yt2c-bar-h)

  // iOS Safari speaks only after a speech that started from a tap: the first tap on the bar says nothing, silently,
  // so the tutor can speak by itself later (when the video stops at a word)
  let voiceReady = false;
  function wakeVoice() {
    if (voiceReady) return;
    voiceReady = true;
    try { if (!speechSynthesis.speaking) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch (e) { /* no speech here */ }
  }

  // any first tap wakes it (the Level Check buttons, the page itself), not only this bar: the default way into a video
  // never touches the bar. (Capture: the Level Check screen stops its clicks before they bubble.)
  document.addEventListener('click', wakeVoice, true);
  document.addEventListener('touchend', wakeVoice, true);

  function act(id) {
    wakeVoice();
    const d = window.__ytcDream;
    try { return !!(d && d.action && d.action(id)); } catch (e) { return false; }
  }

  function build() {
    const b = document.createElement('div');
    b.id = 'yt2c-tutor-bar';
    b.setAttribute('role', 'toolbar');
    b.setAttribute('aria-label', 'My tutor');
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147482600;display:flex;gap:4px;align-items:center;overflow-x:auto;-webkit-overflow-scrolling:touch;' +
      'padding:6px 8px calc(6px + env(safe-area-inset-bottom));background:rgba(32,33,36,.96);color:#fff;font:12px/1.2 -apple-system,system-ui,sans-serif;box-shadow:0 -2px 10px rgba(0,0,0,.3)';
    const on = document.createElement('button');
    on.id = 'yt2c-tb-tutor';
    on.style.cssText = 'flex:none;border:0;border-radius:14px;padding:7px 10px;white-space:nowrap;font:600 13px -apple-system,system-ui,sans-serif;color:#fff';
    on.addEventListener('click', () => { act('tutor'); });
    b.appendChild(on);
    for (const [id, icon, label] of BUTTONS) {
      const x = document.createElement('button');
      x.dataset.act = id;
      x.setAttribute('aria-label', label);
      x.style.cssText = 'flex:none;min-width:50px;border:0;background:none;color:#fff;padding:2px 3px;display:flex;flex-direction:column;align-items:center;gap:2px;white-space:nowrap;font:10px -apple-system,system-ui,sans-serif';
      x.innerHTML = '<span style="font-size:18px;line-height:20px"></span><span></span>';
      x.firstChild.textContent = icon;
      x.lastChild.textContent = label;
      x.addEventListener('click', () => { act(id); });
      b.appendChild(x);
    }
    return b;
  }

  // the bar's real height, for the page (My tutor keeps clear of it): 0px when there is no bar
  function publishHeight() {
    const h = bar && bar.isConnected ? bar.offsetHeight : 0;
    if (h === barH) return;
    barH = h;
    document.documentElement.style.setProperty('--yt2c-bar-h', h + 'px');
  }

  function paint() {
    const want = location.pathname === '/watch';
    if (!want) { if (bar) { bar.remove(); bar = null; document.documentElement.classList.remove('yt2c-tutor-bar'); } publishHeight(); return; }
    if (!bar || !bar.isConnected) { bar = build(); document.body.appendChild(bar); document.documentElement.classList.add('yt2c-tutor-bar'); }
    const on = bar.querySelector('#yt2c-tb-tutor');
    const text = tutorOn ? 'Tutor ● on' : 'Tutor ○ off';
    if (on.textContent !== text) on.textContent = text;
    on.style.background = tutorOn ? '#1e8e3e' : '#d93025';
    for (const x of bar.querySelectorAll('[data-act]')) x.style.display = tutorOn ? 'flex' : 'none';
    const last = bar.querySelector('[data-act="explainLast"]');
    const label = 'Explain ' + explainSeconds + ' s';
    if (last && last.lastChild.textContent !== label) { last.lastChild.textContent = label; last.setAttribute('aria-label', label); }
    publishHeight();
  }

  // (room under the page for the bar)
  const style = document.createElement('style');
  style.textContent = 'html.yt2c-tutor-bar body{padding-bottom:calc(64px + env(safe-area-inset-bottom)) !important}';
  (document.head || document.documentElement).appendChild(style);

  // (on unless you turned it off: the same default as the tutor itself)
  const read = (x) => { tutorOn = !x || x.tutorOn !== false; paint(); };
  chrome.storage.local.get('drExtras').then((o) => read(o && o.drExtras), () => paint());
  // "Explain N s": the part length you chose in the tutor's settings (20 when nothing is saved)
  const readSettings = (x) => { const n = Number(x && x.listen && x.listen.lastSecondsWindow); explainSeconds = n > 0 ? n : 20; paint(); };
  chrome.storage.local.get('drSettings').then((o) => readSettings(o && o.drSettings), () => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.drExtras) read(ch.drExtras.newValue);
    if (ch.drSettings) readSettings(ch.drSettings.newValue);
  });
  // YouTube is a single-page app: the bar comes and goes with the video page
  document.addEventListener('yt-navigate-finish', paint);
  // (the phone was turned, the page's size changed: the bar's height may be another)
  window.addEventListener('resize', paint);
  window.addEventListener('orientationchange', () => { paint(); setTimeout(paint, 400); });
  setInterval(paint, 1500);
})();
