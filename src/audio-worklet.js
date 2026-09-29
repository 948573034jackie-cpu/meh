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
