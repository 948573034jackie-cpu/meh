// the extension window: My tutor's pages, the 🩺 check, a subtitle file for a video without captions

document.getElementById('ver').textContent = 'version ' + chrome.runtime.getManifest().version;

// ---- My tutor's own pages ----
for (const [id, page] of [['dream-settings', 'options'], ['dream-vocab', 'vocab'], ['dream-reader', 'reader']]) {
  const b = document.getElementById(id);
  if (b) b.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('dream/' + page + '.html') }));
}

// ---- 🩺 check for problems: a report you can copy and send ----
{
  const check = document.getElementById('check'), pre = document.getElementById('report'), copyB = document.getElementById('copyReport');
  check.addEventListener('click', async () => {
    pre.style.display = 'block'; pre.textContent = 'Checking…';
    try { const r = await chrome.runtime.sendMessage({ type: 'diagnose' }); pre.textContent = (r && r.report) || 'No answer from the extension.'; }
    catch (e) { pre.textContent = 'The extension did not answer: ' + e.message; }
    copyB.style.display = 'inline-block';
  });
  copyB.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pre.textContent); copyB.textContent = 'Copied ✓'; }
    catch (e) { const r = document.createRange(); r.selectNodeContents(pre); getSelection().removeAllRanges(); getSelection().addRange(r); copyB.textContent = 'Selected: tap Copy'; }
  });
}

// ---- load your own subtitle file for the video in the current tab (the same reader the video page uses) ----
const parseSubtitleFile = (window.YTC || {}).parseSubtitleFile;
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
    out.textContent = 'Loaded ' + cues.length + ' lines' + (r ? ' (' + (r.lines || 0) + ' used). The tutor reads the video again.' : '. Reload the YouTube page.');
  } catch (err) { out.textContent = 'Could not load: ' + err.message; }
});
