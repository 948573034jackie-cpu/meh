'use strict';
// Hidden page that listens to the MICROPHONE (and nothing else) and streams
// its loudness to the main process. Auto-gain / echo-cancel / noise-suppress
// are all off so this can never change your system volume or mic level.
let stream = null;
let ctx = null;
let running = false;

async function start() {
  if (running) return;
  running = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    try {
      ctx = new AudioContext({ latencyHint: 'interactive', sinkId: { type: 'none' } });
    } catch (_) {
      ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    await ctx.audioWorklet.addModule('audio-worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    // Only the human-voice band, so fan rumble / hiss / keyboard clatter count for less.
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 120, Q: 0.7 });
    const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3800, Q: 0.7 });
    const meter = new AudioWorkletNode(ctx, 'meter', { numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = new GainNode(ctx, { gain: 0 }); // keep the graph pulled, output is silent
    meter.port.onmessage = (e) => window.eyes.level(20 * Math.log10(Math.max(e.data, 1e-6)));
    src.connect(hp).connect(lp).connect(meter).connect(mute).connect(ctx.destination);
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      stop();
      window.eyes.status('error', 'Microphone disconnected');
    });
    await ctx.resume();
    window.eyes.status('listening');
  } catch (e) {
    stop();
    window.eyes.status('error', `${e.name}: ${e.message}`);
  }
}

function stop() {
  running = false;
  if (stream) stream.getTracks().forEach((t) => t.stop()); // releases the mic (OS mic light off)
  stream = null;
  if (ctx) ctx.close().catch(() => {});
  ctx = null;
}

window.eyes.onCommand((cmd) => {
  if (cmd === 'start') start();
  else if (cmd === 'stop') {
    stop();
    window.eyes.status('stopped');
  }
});
