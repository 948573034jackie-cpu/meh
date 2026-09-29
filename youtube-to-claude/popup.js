const msg = document.getElementById('msg');
const go = document.getElementById('go');
const NAMES = { claude: 'Claude', chatgpt: 'ChatGPT' };
let mode = 'claude';

chrome.storage.local.get('last').then(({ last }) => { if (last) msg.textContent = 'Last: ' + last; });

// ---- mode: Claude or ChatGPT ----
function showMode(m) {
  mode = m;
  document.querySelectorAll('input[name="target"]').forEach((r) => { r.checked = r.value === m; });
  document.getElementById('lbl-claude').className = m === 'claude' ? 'on-claude' : '';
  document.getElementById('lbl-chatgpt').className = m === 'chatgpt' ? 'on-chatgpt' : '';
  go.className = m === 'chatgpt' ? 'chatgpt' : '';
  go.textContent = 'Send this video to ' + NAMES[m];
}
chrome.storage.local.get('target').then((s) => showMode(s.target === 'chatgpt' ? 'chatgpt' : 'claude'));
document.querySelectorAll('input[name="target"]').forEach((r) => {
  r.addEventListener('change', () => { if (r.checked) { chrome.storage.local.set({ target: r.value }); showMode(r.value); } });
});

go.addEventListener('click', async () => {
  go.disabled = true;
  go.textContent = 'Sending…';
  msg.classList.remove('err');
  msg.textContent = 'Working (up to 30 s)…';
  const { result } = await chrome.runtime.sendMessage({ type: 'send', target: mode });
  go.disabled = false;
  showMode(mode);
  msg.textContent = result;
  msg.classList.toggle('err', !/^Sent /.test(result));
});

// ---- options ----
for (const id of ['pauseOn', 'replayOn', 'sendTranscript', 'voiceOn']) {
  const box = document.getElementById(id);
  chrome.storage.local.get(id).then((s) => { box.checked = s[id] !== false; });
  box.addEventListener('change', () => chrome.storage.local.set({ [id]: box.checked }));
}
const slider = document.getElementById('textLevel');
const sizeVal = document.getElementById('sizeVal');
const LABELS = { 1: 'smallest', 6: 'medium', 14: 'biggest' };
function showSize(v) { sizeVal.textContent = v + (LABELS[v] ? ' (' + LABELS[v] + ')' : ''); }
chrome.storage.local.get('textLevel').then((s) => { slider.value = s.textLevel || 6; showSize(Number(slider.value)); });
slider.addEventListener('input', () => { showSize(Number(slider.value)); chrome.storage.local.set({ textLevel: Number(slider.value) }); });
