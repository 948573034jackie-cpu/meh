(function () {
'use strict';
// Lives in the hidden microphone page. Keeps the last few seconds of raw microphone audio (16 kHz),
// and turns it into voiceprints on request. It never stores audio on disk and never sends audio out;
// only the voiceprint numbers (192 of them) go back to the app.
const VOICE = typeof module !== 'undefined' && module.exports
  ? { voiceid: require('./voiceid'), embedder: require('./embedder') }
  : { voiceid: globalThis.CEVoice.voiceid, embedder: globalThis.CEVoice.embedder };

const RATE = 16000;
const RING = RATE * 8;
const LOOKBACK = 0.25 * RATE; // the first word began a little before the app noticed

function createRunner({ ort, wasmPaths, send, createEmbedder = VOICE.embedder.createEmbedder }) {
  const { speechOnly, enrollmentChunks, MIN_SPEECH_SEC } = VOICE.voiceid;
  const ring = new Float32Array(RING);
  let w = 0; // total samples received
  let embedder = null;
  let verifyTask = null;
  let enroll = null;

  const slice = (from, to) => {
    const out = new Float32Array(to - from);
    for (let i = from; i < to; i++) out[i - from] = ring[i % RING];
    return out;
  };

  async function finishVerify(t) {
    try {
      if (!embedder) return send({ id: t.id, error: 'model-not-ready' });
      const sp = speechOnly(slice(Math.max(0, t.onset), t.end));
      const speechSec = sp.length / RATE;
      if (speechSec < MIN_SPEECH_SEC) return send({ id: t.id, error: 'too-short', speechSec });
      const emb = await embedder.embed(sp.subarray(0, Math.min(sp.length, t.sec * RATE)));
      send({ id: t.id, emb: Array.from(emb), speechSec });
    } catch (e) {
      send({ id: t.id, error: String((e && e.message) || e) });
    }
  }

  async function finishEnroll(t, reason) {
    enroll = null;
    try {
      if (!embedder) return send({ id: t.id, error: 'model-not-ready' });
      const all = new Float32Array(t.total);
      let k = 0;
      for (const p of t.parts) { all.set(p, k); k += p.length; }
      const chunks = enrollmentChunks(all).slice(0, 10);
      const embs = [];
      for (const c of chunks) embs.push(Array.from(await embedder.embed(c)));
      send({ id: t.id, embs, reason });
    } catch (e) {
      send({ id: t.id, error: String((e && e.message) || e) });
    }
  }

  return {
    // one 20 ms chunk (320 samples) of microphone audio
    push(chunk) {
      for (let i = 0; i < chunk.length; i++) ring[(w + i) % RING] = chunk[i];
      w += chunk.length;
      if (verifyTask && w >= verifyTask.end) { const t = verifyTask; verifyTask = null; finishVerify(t); }
      if (enroll) {
        enroll.parts.push(chunk.slice());
        enroll.total += chunk.length;
        if (w - enroll.lastCheck >= RATE) {
          enroll.lastCheck = w;
          const all = new Float32Array(enroll.total);
          let k = 0;
          for (const p of enroll.parts) { all.set(p, k); k += p.length; }
          const speechSec = speechOnly(all).length / RATE;
          send({ id: enroll.id, progress: speechSec });
          if (speechSec >= enroll.targetSec) finishEnroll(enroll, 'enough');
          else if (enroll.total / RATE >= enroll.maxSec) finishEnroll(enroll, 'timeout');
        }
      }
    },

    async handle(cmd) {
      if (cmd.cmd === 'voice-model') {
        try {
          embedder = await createEmbedder(ort, new Uint8Array(cmd.bytes), { wasmPaths });
          send({ ready: true });
        } catch (e) {
          send({ ready: false, error: String((e && e.message) || e) });
        }
      } else if (cmd.cmd === 'verify') {
        const onset = w - LOOKBACK;
        verifyTask = { id: cmd.id, onset, end: onset + Math.round((cmd.sec || 2) * RATE), sec: cmd.sec || 2 };
      } else if (cmd.cmd === 'enroll') {
        enroll = { id: cmd.id, parts: [], total: 0, lastCheck: w, targetSec: cmd.targetSec || 14, maxSec: cmd.maxSec || 50 };
      } else if (cmd.cmd === 'enroll-cancel' && enroll) {
        const t = enroll; enroll = null; send({ id: t.id, error: 'cancelled' });
      }
    },
    get samples() { return w; },
    get ready() { return !!embedder; },
  };
}

const api = { createRunner, RATE };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.CEVoice.runner = api;
})();
