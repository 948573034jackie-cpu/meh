// Runs in a hidden page. Listens to the microphone and tells the service worker
// each time you are speaking. Chrome's echo cancellation removes sound that Chrome
// itself is playing (Claude's voice); background.js also ignores speech while the
// claude.ai tab is audible.

const SENSITIVITY = 3;    // higher = needs a louder voice
const MIN_LEVEL = 0.02;   // absolute minimum loudness (RMS, 0..1)
const ONSET_MS = 150;     // voice must stay loud this long to count
const PING_MS = 400;      // while you keep talking, repeat the "speech" signal this often

let currentLevel = 0;
const ports = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'level') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
});

(async () => {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
    });
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'mic-error', message: 'Microphone blocked (' + e.name + '). Open the setup page and allow it.' });
    return;
  }

  const ctx = new AudioContext();
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  let floor = 0.005;
  let loudSince = 0;
  let lastPing = 0;

  setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);

    const threshold = Math.max(MIN_LEVEL, floor * SENSITIVITY);
    currentLevel = Math.min(1, rms / (threshold * 2));
    for (const p of ports) p.postMessage({ level: currentLevel });

    const now = performance.now();
    if (rms < threshold) {
      floor = floor * 0.98 + rms * 0.02; // learn the room noise
      loudSince = 0;
    } else {
      if (!loudSince) loudSince = now;
      if (now - loudSince >= ONSET_MS && now - lastPing >= PING_MS) {
        lastPing = now;
        chrome.runtime.sendMessage({ type: 'speech' }).catch(() => {});
      }
    }
  }, 50);
})();
