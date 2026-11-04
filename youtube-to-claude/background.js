// My tutor's AI (your own API key), its jobs and the settings / vocabulary pages: dream/dream-bg.js (built from dream-ext/).
if (typeof importScripts === 'function') { try { importScripts('dream/dream-bg.js'); } catch (e) { console.error('My tutor background failed to load', e); } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);

// ---- 🩺 check: what works and what does not, in plain words (copy it and send it to get help) ----
async function diagnose() {
  const out = [], problems = [];
  const add = (k, v) => out.push(k + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)));
  const man = chrome.runtime.getManifest();
  const phone = !!self.__ytcSafari;
  add('Extension', man.version + (phone ? ' (Safari)' : ' (Chrome)') + ' · ' + new Date().toLocaleString());
  try { add('Device', (self.navigator && navigator.userAgent || '').slice(0, 140)); } catch (e) { /* ignore */ }
  const st = await chrome.storage.local.get(null).catch(() => ({}));
  const ex = st.drExtras || {}, ds = st.drSettings || {}, ks = st.drKeys || {};
  const tutorOn = ex.tutorOn !== false; // on unless you turned it off

  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (e) { problems.push('Cannot see the tabs: ' + e.message); }
  const hosts = tabs.map((t) => { try { return new URL(t.url).host; } catch (e) { return '(no access)'; } });
  add('Open tabs', hosts.join(', ') || '(none visible)');

  const yts = tabs.filter((t) => /^https:\/\/(www|m)\.youtube\.com\//.test(t.url || ''));
  if (!yts.length) problems.push('No YouTube tab found. Open a video on youtube.com (and allow the extension on youtube.com).');
  for (const t of yts.slice(0, 2)) {
    const r = await within(chrome.tabs.sendMessage(t.id, { type: 'yt-diag' }).catch((e) => ({ error: e.message })), 3000);
    add('YouTube tab', r || 'no answer');
    if (!r || r.error) problems.push('The YouTube page does not answer. Reload it, and allow the extension on youtube.com' + (phone ? ' (aA → Manage Extensions).' : '.'));
    else {
      if (!r.video) problems.push('No video found on the YouTube page (open a video, not the home page).');
      if (r.subtitles && /^none|error/.test(r.subtitles)) problems.push('No subtitles for this video: ' + r.subtitles + '. My tutor needs the video\'s subtitles (CC).');
      if (!tutorOn) problems.push('My tutor is OFF. Press "My tutor" ' + (phone ? 'in the bar at the bottom of the page' : 'under the video') + ' so it turns green.');
      if (r.tutor && r.tutor.problem) problems.push(r.tutor.problem);
      if (r.tutor && r.tutor.voiceProblem) problems.push('The tutor\'s voice had a problem: ' + r.tutor.voiceProblem + '. (One failed sentence is said by ' + (phone ? 'the iPhone voice' : 'the Mac voice') + '; then the good voice is tried again.)');
      if (r.muted) problems.push('The video is MUTED. Tap the speaker icon in the player.');
      if (r.microphone === 'blocked') problems.push('The microphone is blocked: ' + (phone ? 'iPhone Settings → this app → allow the Microphone and Speech Recognition.' : 'click the lock icon left of the address bar → Microphone → Allow.') + ' Without it you can still type to the tutor.');
    }
  }

  // My tutor: on / off, which keys are saved (never the keys themselves), the voice and the AI it uses
  const saved = Object.keys(ks).filter((k) => ks[k]);
  add('My tutor', { on: tutorOn, keys: saved.length ? saved : 'none saved', ai: ds.ai ? (ds.ai.provider + ' ' + (ds.ai.provider === 'openai' ? ds.ai.openaiModel : ds.ai.anthropicModel)) : 'default', level: ds.learnerLevel || 'B2', voice: ex.voice || 'auto', liveTalk: ks.openai ? 'OpenAI live (real time)' : 'slower (no OpenAI key)' });
  if (!saved.length) problems.push('No API key is saved. ' + (phone ? 'Tap ⚙ in the tutor bar → All settings' : 'Click the extension icon → All settings') + ' → API keys → paste your Claude key → Save → Test.');
  if (ex.voice === 'openai' && !ks.openai) problems.push('The OpenAI voice is chosen but no OpenAI API key is saved (⚙ → API keys). ' + (phone ? 'The iPhone voice' : 'The Mac voice') + ' is used until then.');
  if (ex.voice === 'azure' && !ks.azure) problems.push('The Microsoft (Azure) voice is chosen but no Microsoft key is saved (⚙ → API keys). ' + (phone ? 'The iPhone voice' : 'The Mac voice') + ' is used until then.');
  if (ex.voice === 'elevenlabs' && !ks.elevenlabs) problems.push('The ElevenLabs voice is chosen but no ElevenLabs key is saved (⚙ → API keys). ' + (phone ? 'The iPhone voice' : 'The Mac voice') + ' is used until then.');

  // the vocabulary file (one database for the Mac and the iPhone)
  const db = st.drDbStatus;
  if (db) {
    add('Vocabulary file', db);
    if (db.noDevice) out.push('(the Safari version keeps the words inside the extension; the YT Learn app can share the file)');
    else if (!db.ok) problems.push('The vocabulary file was not saved: ' + (db.notInstalled ? 'the helper is not installed on this Mac (All settings → Level Check shows the one command).' : db.error || 'unknown problem'));
  }

  const head = problems.length ? 'PROBLEMS FOUND (' + problems.length + '):\n' + problems.map((p, i) => (i + 1) + '. ' + p).join('\n') : 'No problems found ✓';
  return head + '\n\n--- details (send this to Claude Code to get help) ---\n' + out.join('\n');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'diagnose') { diagnose().then((report) => sendResponse({ report }), (e) => sendResponse({ report: 'Check failed: ' + e.message })); return true; }
});
