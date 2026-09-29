const msg = document.getElementById('msg');
const buttons = document.querySelectorAll('button.go');

chrome.storage.local.get('last').then(({ last }) => { if (last) msg.textContent = 'Last: ' + last; });

buttons.forEach((btn) => btn.addEventListener('click', async () => {
  const target = btn.id === 'gochatgpt' ? 'chatgpt' : 'claude';
  buttons.forEach((b) => (b.disabled = true));
  const label = btn.textContent;
  btn.textContent = 'Sending…';
  msg.classList.remove('err');
  msg.textContent = 'Working (up to 30 s)…';
  const { result } = await chrome.runtime.sendMessage({ type: 'send', target });
  buttons.forEach((b) => (b.disabled = false));
  btn.textContent = label;
  msg.textContent = result;
  msg.classList.toggle('err', !/^Sent /.test(result));
}));

// options
for (const id of ['pauseOn', 'replayOn', 'sendTranscript']) {
  const box = document.getElementById(id);
  chrome.storage.local.get(id).then((s) => { box.checked = s[id] !== false; });
  box.addEventListener('change', () => chrome.storage.local.set({ [id]: box.checked }));
}

const sizeSel = document.getElementById('textSize');
chrome.storage.local.get('textSize').then((s) => { sizeSel.value = s.textSize || 'auto'; });
sizeSel.addEventListener('change', () => chrome.storage.local.set({ textSize: sizeSel.value }));

document.querySelectorAll('input[name="target"]').forEach((r) => {
  chrome.storage.local.get('target').then((s) => { r.checked = r.value === (s.target || 'claude'); });
  r.addEventListener('change', () => { if (r.checked) chrome.storage.local.set({ target: r.value }); });
});
