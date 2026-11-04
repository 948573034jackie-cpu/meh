// Safari (iPhone/iPad): My tutor's buttons at the bottom of the YouTube page. There is no keyboard on the phone, so this
// bar does what the tutor's keyboard shortcuts do on a Mac (the same bar as in the YT Learn app). It runs after
// dream/dream-yt.js in the same content-script world and drives it through window.__ytcDream.action(id).
(function () {
  if (window.__ytcTutorBar) return;
  window.__ytcTutorBar = true;

  const BUTTONS = [
    ['stop', '⏯', 'Stop / play'],
    ['explainLast', '💬', 'Explain 30 s'],
    ['explainSentence', '↩', 'Last sentence'],
    ['talk', '📞', 'Talk'],
    ['voiceMode', '🎤', 'Voice'],
    ['pageAuto', '📄', 'Page'],
    ['listening', '📖', 'Listening'],
    ['vocab', '📒', 'Words'],
    ['quick', '⚙', 'Settings'],
  ];
  let tutorOn = true;
  let bar = null;

  // iOS Safari speaks only after a speech that started from a tap: the first tap on the bar says nothing, silently,
  // so the tutor can speak by itself later (when the video stops at a word)
  let voiceReady = false;
  function wakeVoice() {
    if (voiceReady) return;
    voiceReady = true;
    try { if (!speechSynthesis.speaking) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch (e) { /* no speech here */ }
  }

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
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147482000;display:flex;gap:4px;align-items:center;overflow-x:auto;-webkit-overflow-scrolling:touch;' +
      'padding:6px 8px calc(6px + env(safe-area-inset-bottom));background:rgba(32,33,36,.96);color:#fff;font:12px/1.2 -apple-system,system-ui,sans-serif;box-shadow:0 -2px 10px rgba(0,0,0,.3)';
    const on = document.createElement('button');
    on.id = 'yt2c-tb-tutor';
    on.style.cssText = 'flex:none;border:0;border-radius:14px;padding:7px 12px;font:600 13px -apple-system,system-ui,sans-serif;color:#fff';
    on.addEventListener('click', () => { act('tutor'); });
    b.appendChild(on);
    for (const [id, icon, label] of BUTTONS) {
      const x = document.createElement('button');
      x.dataset.act = id;
      x.setAttribute('aria-label', label);
      x.style.cssText = 'flex:none;min-width:54px;border:0;background:none;color:#fff;padding:2px 4px;display:flex;flex-direction:column;align-items:center;gap:2px;font:10px -apple-system,system-ui,sans-serif';
      x.innerHTML = '<span style="font-size:18px;line-height:20px"></span><span></span>';
      x.firstChild.textContent = icon;
      x.lastChild.textContent = label;
      x.addEventListener('click', () => { act(id); });
      b.appendChild(x);
    }
    return b;
  }

  function paint() {
    const want = location.pathname === '/watch';
    if (!want) { if (bar) { bar.remove(); bar = null; document.documentElement.classList.remove('yt2c-tutor-bar'); } return; }
    if (!bar || !bar.isConnected) { bar = build(); document.body.appendChild(bar); document.documentElement.classList.add('yt2c-tutor-bar'); }
    const on = bar.querySelector('#yt2c-tb-tutor');
    on.textContent = tutorOn ? 'My tutor ● on' : 'My tutor ○ off';
    on.style.background = tutorOn ? '#1e8e3e' : '#d93025';
    for (const x of bar.querySelectorAll('[data-act]')) x.style.display = tutorOn ? 'flex' : 'none';
  }

  // (room under the page for the bar)
  const style = document.createElement('style');
  style.textContent = 'html.yt2c-tutor-bar body{padding-bottom:calc(64px + env(safe-area-inset-bottom)) !important}';
  (document.head || document.documentElement).appendChild(style);

  // (on unless you turned it off: the same default as the tutor itself)
  const read = (x) => { tutorOn = !x || x.tutorOn !== false; paint(); };
  chrome.storage.local.get('drExtras').then((o) => read(o && o.drExtras), () => paint());
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.drExtras) read(ch.drExtras.newValue); });
  // YouTube is a single-page app: the bar comes and goes with the video page
  document.addEventListener('yt-navigate-finish', paint);
  setInterval(paint, 1500);
})();
