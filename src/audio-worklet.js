// Runs on the audio thread: reports the loudness (RMS) of the microphone
// every ~20ms. It only ever READS the mic; nothing is played or changed.
class Meter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.win = Math.round(sampleRate * 0.02);
    this.sum = 0;
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) this.sum += ch[i] * ch[i];
      this.n += ch.length;
      if (this.n >= this.win) {
        this.port.postMessage(Math.sqrt(this.sum / this.n));
        this.sum = 0;
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('meter', Meter);

// Raw microphone audio in 20 ms pieces (16 kHz) for the optional "only my voice" check.
// It stays inside this page: it is never saved and never leaves the app.
class Pcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(320);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === 320) { this.port.postMessage(this.buf.slice()); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('pcm', Pcm);
