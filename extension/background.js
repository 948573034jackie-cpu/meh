// Service worker: keeps a connection to the Claude Eyes app on this computer (127.0.0.1 only)
// and, when a picture arrives, attaches it to the claude.ai / chatgpt.com tab in the background.
importScripts('attach.js');

const PORTS = [47613, 47614, 47615, 47616, 47617];
const PATTERNS = ['https://claude.ai/*', 'https://chatgpt.com/*', 'https://chat.openai.com/*'];
let ws = null;
let connecting = false;
let retryTimer = null;

function badge(on) {
  chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
  chrome.action.setTitle({ title: on ? 'Claude Eyes: connected to the app' : 'Claude Eyes: waiting for the Claude Eyes app' });
}

// Knock on every possible port at once; the first one that answers is the app.
function connect() {
  if (ws && ws.readyState !== WebSocket.OPEN) ws = null; // stale
  if (ws || connecting) return;
  clearTimeout(retryTimer);
  connecting = true;
  const socks = [];
  let pending = PORTS.length;
  const oneFailed = () => { if (--pending === 0 && !ws) { connecting = false; schedule(); } };
  for (const port of PORTS) {
    let sock;
    try { sock = new WebSocket('ws://127.0.0.1:' + port); } catch (_) { oneFailed(); continue; }
    socks.push(sock);
    sock.onerror = () => {};
    sock.onclose = () => { if (sock !== ws) oneFailed(); };
    sock.onopen = () => {
      if (ws) { try { sock.close(); } catch (_) {} return; }
      ws = sock;
      connecting = false;
      for (const other of socks) if (other !== sock) { try { other.close(); } catch (_) {} }
      badge(true);
      sock.onmessage = (ev) => { handle(sock, ev.data).catch(() => {}); };
      sock.onclose = () => { if (ws === sock) { ws = null; badge(false); schedule(); } };
    };
  }
}
function schedule() { clearTimeout(retryTimer); retryTimer = setTimeout(connect, 1000); }

async function pickTab() {
  const tabs = await chrome.tabs.query({ url: PATTERNS });
  if (!tabs.length) return null;
  // the tab that is talking right now first, then the one used most recently
  tabs.sort((a, b) => (Number(!!b.audible) - Number(!!a.audible)) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
  return tabs[0];
}

async function handle(sock, raw) {
  const msg = JSON.parse(raw);
  if (msg.type === 'ping') return sock.send(JSON.stringify({ type: 'pong' }));
  if (msg.type !== 'shot') return;
  const reply = (r) => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ type: 'result', id: msg.id, ...r }));
  const tab = await pickTab();
  if (!tab) return reply({ ok: false, error: 'no-tab' });
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: claudeEyesAttach,
      args: [msg.data, msg.mime, msg.name || 'screenshot.jpg'],
    });
    const r = (res && res.result) || { ok: false, error: 'no-result' };
    reply({ ...r, where: new URL(tab.url).hostname });
  } catch (e) {
    reply({ ok: false, error: String(e && e.message || e) });
  }
}

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
badge(false);
connect();
