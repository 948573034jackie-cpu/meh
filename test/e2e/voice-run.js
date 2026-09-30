'use strict';
// "Only react to my voice", end to end: the real app, a fake microphone playing a scripted
// conversation, the real speaker-recognition model (WebAssembly) and real screen capture.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const WAV = path.join(OUT, 'voice-mic.wav');
const timeline = require('./make-voice-wav')(WAV);
const MODEL = process.env.VOICE_MODEL || path.join(OUT, 'nemo_en_titanet_small.onnx');

// Test-only: some sandboxes re-sign HTTPS traffic with their own certificate. Never used by the real app.
if (process.env.CE_TEST_INSECURE_TLS) app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', WAV + '%noloop');

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function finish(code) {
  try { fs.writeFileSync(path.join(OUT, 'result'), String(code)); } catch (_) {}
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 2000).unref();
  app.exit(code);
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ x: 0, y: 0, width: 1280, height: 800, frame: false });
  await win.loadURL('data:text/html,<body style="margin:0;background:%23246">SCREEN</body>');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-voice-'));
  fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({ intervalSec: 1, enabled: false })); // mic stays off until the model is ready, so the scripted audio starts on cue
  const events = [];
  const pasteCalls = [];
  const t0 = Date.now();
  const h = require('../../src/app').start({
    settingsFile: path.join(dir, 's.json'), voiceProfileFile: path.join(dir, 'voice.json'), voiceModelPath: MODEL,
    notify: false, manageLoginItem: false, allowMultiple: true, bridge: false,
    paste: async (a) => { pasteCalls.push(a); return { ok: true, awayMs: 0, focusRestored: true }; },
    onEvent: (e) => { if (e.type === 'console' || e.type === 'voice-ready') console.log('   [page]', e.type, e.level !== undefined ? e.level : '', String(e.message || e.error || e.ready).slice(0, 400)); if (e.type !== 'level' && e.type !== 'console') events.push({ ...e, at: (Date.now() - t0) / 1000 }); },
  });
  const t0m = Date.now();
  const modelReady = await h.initVoice(); // the app's own download + checksum + load (no-op if already on disk)
  console.log(`   model ready in ${((Date.now() - t0m) / 1000).toFixed(1)} s`);
  check('speaker model downloaded/verified and loaded', modelReady === true);
  h.setEnabled(true); // microphone starts now -> the scripted conversation starts now
  for (let i = 0; i < 100 && h.getState().micState !== 'listening'; i++) await sleep(200);
  check('microphone is live', h.getState().micState === 'listening');

  // ---- before learning: nothing changes (feature is off) ----
  check('feature is OFF until you teach it your voice', h.settings.get('voiceOnly') === false && h.getVoice().profile === null);

  // ---- learn the user's voice ----
  console.log('\n# Learning the user\'s voice (they read 6 sentences)');
  const t1 = Date.now();
  const learned = await h.learnVoice();
  console.log(`   learning took ${((Date.now() - t1) / 1000).toFixed(1)} s (audio time), consistency ${learned.selfMean && learned.selfMean.toFixed(2)}, ${learned.pieces} pieces`);
  check('voice learned', learned.ok === true, JSON.stringify(learned));
  check('the speaker model is on disk, complete and verified (sha256)', fs.existsSync(MODEL) && require('crypto').createHash('sha256').update(fs.readFileSync(MODEL)).digest('hex') === 'ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e', MODEL + (process.env.VOICE_MODEL ? ' (supplied)' : ' (downloaded by the app)'));
  check('consistency of the recording is high (same person)', learned.selfMean > 0.75, String(learned.selfMean));
  check('voiceprint saved on this computer', fs.existsSync(path.join(dir, 'voice.json')) && h.settings.get('voiceOnly') === true);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'voice.json'), 'utf8'));
  check('the saved file holds numbers only (192-number voiceprint, no audio)', saved.vec.length === 192 && !JSON.stringify(saved).includes('RIFF') && fs.statSync(path.join(dir, 'voice.json')).size < 20000);

  // ---- the scripted conversation ----
  console.log('\n# Conversation: who gets a screenshot?');
  // audio time 0 = the moment the microphone went live; match each scripted speaker to the outcome that happened while they spoke
  const micLive = events.find((e) => e.type === 'mic' && e.state === 'listening');
  const A0 = micLive ? micLive.at : 0;
  const script = timeline.filter((x) => x.label !== 'enroll');
  const outcomeIn = (item) => events.filter((e) => (e.type === 'sent' || e.type === 'ignored') && e.at >= A0 + item.start - 0.2 && e.at <= A0 + item.end + 6.5);
  for (let i = 0; i < 600 && !script.every((it) => outcomeIn(it).length >= 1); i++) await sleep(500);
  await sleep(1500);
  const labels = script.map((s) => s.label);
  const outcomes = script.map((it) => outcomeIn(it)[0]);
  const got = outcomes.map((e) => (e ? (e.type === 'sent' ? 'SENT' : 'ignored') : 'nothing'));
  labels.forEach((who, i) => {
    const e = outcomes[i];
    const want = who === 'user' ? 'SENT' : 'ignored';
    const score = e && (e.voice && e.voice.score !== undefined ? e.voice.score.toFixed(2) : 'n/a');
    check(`${String(i + 1)}. ${who.padEnd(6)} speaks -> ${want}`, got[i] === want, `got ${got[i]}, voice score ${score}`);
  });
  const userScores = outcomes.filter((e, i) => e && labels[i] === 'user').map((e) => e.voice && e.voice.score);
  const otherScores = outcomes.filter((e, i) => e && labels[i] !== 'user').map((e) => e.voice && e.voice.score).filter((x) => x !== undefined);
  console.log(`   user scores: ${userScores.map((x) => x && x.toFixed(2)).join(', ')}   others/claude scores: ${otherScores.map((x) => x.toFixed(2)).join(', ')}`);
  check('exactly one decision per utterance (nothing extra was sent while the others spoke)', script.every((it) => outcomeIn(it).length === 1), script.map((it) => outcomeIn(it).length).join(','));
  check('rejected voices did not use up the wait between screenshots (next speech was still allowed)', got.filter((g) => g === 'SENT').length === labels.filter((l) => l === 'user').length);

  // ---- settings ----
  console.log('\n# Settings');
  h.settings.set('voiceOnly', false);
  check('the switch turns the check off again', h.settings.get('voiceOnly') === false);
  h.forgetVoice();
  check('"forget my voice" deletes the voiceprint', !fs.existsSync(path.join(dir, 'voice.json')) && h.getVoice().profile === null);

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  finish(failed ? 1 : 0);
}
main().catch((e) => { console.error('E2E CRASH', e); finish(2); });
setTimeout(() => { console.error('E2E TIMEOUT'); finish(3); }, 200000);
