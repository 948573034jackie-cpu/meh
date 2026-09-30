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
  await chrome.storage.local.set({ target: mode, sendOn: true }); // same as turning that button under the video green
  const { result } = await chrome.runtime.sendMessage({ type: 'send', target: mode });
  go.disabled = false;
  showMode(mode);
  msg.textContent = result;
  msg.classList.toggle('err', !/^Sent /.test(result));
});

// the subtitle-file reader is the same code the video page uses
const parseSubtitleFile = (window.YTC || {}).parseSubtitleFile;

// ---- options ----
for (const id of ['pauseOn', 'replayOn', 'voiceOn', 'voiceBridge', 'feedOn', 'talkOn', 'imageOn', 'barOn']) {
  const box = document.getElementById(id);
  chrome.storage.local.get(id).then((s) => { box.checked = s[id] !== false; });
  box.addEventListener('change', () => chrome.storage.local.set({ [id]: box.checked }));
}
const slider = document.getElementById('textLevel');
const sizeVal = document.getElementById('sizeVal');
const LABELS = { 1: 'smallest', 6: 'medium', 10: 'biggest' };
function showSize(v) { sizeVal.textContent = (Number.isInteger(v) ? v : v.toFixed(2).replace(/0$/, '')) + (LABELS[v] ? ' (' + LABELS[v] + ')' : ''); }
chrome.storage.local.get('textLevel').then((s) => { slider.value = Math.min(10, s.textLevel || 6); showSize(Number(slider.value)); });
slider.addEventListener('input', () => { showSize(Number(slider.value)); chrome.storage.local.set({ textLevel: Number(slider.value) }); });


// ---- load your own subtitle file for the video in the current tab ----
document.getElementById('subfile').addEventListener('change', async (e) => {
  const out = document.getElementById('subMsg');
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const id = tab && tab.url && new URL(tab.url).searchParams.get('v');
    if (!id) { out.textContent = 'Open the YouTube video first, then choose the file.'; return; }
    const cues = parseSubtitleFile(await file.text());
    if (!cues.length) { out.textContent = 'I could not find subtitle lines in that file.'; return; }
    const { manualSubs = {} } = await chrome.storage.local.get('manualSubs');
    manualSubs[id] = cues;
    const ids = Object.keys(manualSubs);
    while (ids.length > 6) delete manualSubs[ids.shift()]; // keep the last few videos only
    await chrome.storage.local.set({ manualSubs });
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'reload-subs' }).catch(() => null);
    out.textContent = 'Loaded ' + cues.length + ' lines' + (r ? ' (' + (r.lines || 0) + ' used). Pause the video now.' : '. Reload the YouTube page, then pause.');
  } catch (err) { out.textContent = 'Could not load: ' + err.message; }
});

document.getElementById('ver').textContent = 'version ' + chrome.runtime.getManifest().version;
