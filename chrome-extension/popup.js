const statusEl = document.getElementById('status');
const bar = document.getElementById('bar');
const openBtn = document.getElementById('open');
const quitBtn = document.getElementById('quit');
const errEl = document.getElementById('err');

let port = null;

function render(listening, error) {
  statusEl.textContent = listening ? '● Listening' : 'Off';
  statusEl.style.color = listening ? '#188038' : '';
  openBtn.textContent = listening ? 'Stop' : 'Open';
  openBtn.classList.toggle('on', listening);
  errEl.textContent = error || '';
  if (!listening) bar.style.width = '0';
  if (listening && !port) {
    port = chrome.runtime.connect({ name: 'level' });
    port.onMessage.addListener((m) => { bar.style.width = Math.round(m.level * 100) + '%'; });
    port.onDisconnect.addListener(() => { port = null; });
  }
}

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  render(s.listening, s.error);
  return s;
}

openBtn.addEventListener('click', async () => {
  const s = await refresh();
  if (s.listening) {
    await chrome.runtime.sendMessage({ type: 'stop' });
    if (port) { port.disconnect(); port = null; }
    return refresh();
  }
  const perm = await navigator.permissions.query({ name: 'microphone' });
  if (perm.state !== 'granted') {
    chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
    window.close();
    return;
  }
  await chrome.runtime.sendMessage({ type: 'start' });
  setTimeout(refresh, 300);
});

quitBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop' });
  window.close();
});

refresh();
