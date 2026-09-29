const go = document.getElementById('go');
const msg = document.getElementById('msg');

chrome.storage.local.get('last').then(({ last }) => { if (last) msg.textContent = 'Last: ' + last; });

go.addEventListener('click', async () => {
  go.disabled = true;
  go.textContent = 'Sending… (up to 30 s)';
  msg.classList.remove('err');
  msg.textContent = '';
  const { result } = await chrome.runtime.sendMessage({ type: 'send' });
  go.disabled = false;
  go.textContent = 'Send this video to Claude';
  msg.textContent = result;
  msg.classList.toggle('err', !/^Sent /.test(result));
});

// options
for (const id of ['pauseOn', 'replayOn']) {
  const box = document.getElementById(id);
  chrome.storage.local.get(id).then((s) => { box.checked = s[id] !== false; });
  box.addEventListener('change', () => chrome.storage.local.set({ [id]: box.checked }));
}
