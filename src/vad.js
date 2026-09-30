'use strict';

// Voice-onset detector. Fed one loudness value (dBFS) every ~20ms from the
// MICROPHONE only, it fires a single "start" event the moment a new burst of
// speech begins (after only ~60ms of sustained sound), and an "end" event once
// the speaker has been quiet for `hangoverMs`.

const SENSITIVITY = {
  low: { marginDb: 18, minDb: -42 },
  normal: { marginDb: 12, minDb: -48 },
  high: { marginDb: 8, minDb: -54 },
};

const DEFAULTS = {
  frameMs: 20,
  onsetMs: 60, // sound must last this long to count as speech (rejects clicks/pops)
  hangoverMs: 1200, // silence needed before the next word counts as a NEW utterance
  minIntervalMs: 60000, // after one screenshot, wait this long before taking another
  warmupMs: 500, // ignore start-up pops while the noise floor settles
  maxSpeechMs: 15000, // sustained "speech" longer than this is treated as background noise
  floorInitDb: -65,
  floorMinDb: -90,
  floorMaxDb: -25,
};

class Vad {
  constructor(opts = {}, onEvent = () => {}) {
    this.opts = { ...DEFAULTS, ...SENSITIVITY.normal, ...opts };
    this.onEvent = onEvent;
    this.reset();
  }

  setSensitivity(name) {
    const preset = SENSITIVITY[name];
    if (!preset) throw new Error(`unknown sensitivity: ${name}`);
    Object.assign(this.opts, preset);
  }

  // the picture was not actually sent (e.g. not the user's voice): let the next speech trigger at once
  forgetLastTrigger() {
    this.lastTriggerTs = -Infinity;
  }

  setMinInterval(ms) {
    if (!(ms >= 0)) throw new Error('bad interval');
    this.opts.minIntervalMs = ms;
  }

  reset() {
    this.floorDb = this.opts.floorInitDb;
    this.speaking = false;
    this.aboveFrames = 0;
    this.startedAt = null; // first frame ever seen (for warmup)
    this.speechStartTs = 0;
    this.lastVoiceTs = 0;
    this.lastTriggerTs = -Infinity;
  }

  get thresholdDb() {
    return Math.max(this.opts.minDb, this.floorDb + this.opts.marginDb);
  }

  _updateFloor(db) {
    const o = this.opts;
    if (db < this.floorDb) this.floorDb = this.floorDb * 0.5 + db * 0.5; // follow quiet quickly
    else this.floorDb += 0.02 * (db - this.floorDb); // follow rising noise slowly
    this.floorDb = Math.min(o.floorMaxDb, Math.max(o.floorMinDb, this.floorDb));
  }

  // db: loudness of the latest frame in dBFS; now: timestamp in ms.
  process(db, now) {
    const o = this.opts;
    if (!Number.isFinite(db)) db = o.floorMinDb;
    if (this.startedAt === null) this.startedAt = now;
    const warm = now - this.startedAt >= o.warmupMs;
    const above = db > this.thresholdDb;

    if (!this.speaking) {
      if (above) {
        this.aboveFrames++;
        if (this.aboveFrames * o.frameMs >= o.onsetMs && warm) {
          this.speaking = true;
          this.speechStartTs = now;
          this.lastVoiceTs = now;
          if (now - this.lastTriggerTs >= o.minIntervalMs) {
            this.lastTriggerTs = now;
            this.onEvent({ type: 'start', ts: now, db });
          } else {
            this.onEvent({ type: 'suppressed', ts: now, db });
          }
        }
      } else {
        this.aboveFrames = 0;
        this._updateFloor(db);
      }
      return;
    }

    if (above) {
      this.lastVoiceTs = now;
      if (now - this.speechStartTs > o.maxSpeechMs) {
        // Never-ending loud sound = background noise, not a person. Adapt to it.
        this.floorDb = Math.min(o.floorMaxDb, db);
        this.speaking = false;
        this.aboveFrames = 0;
        this.onEvent({ type: 'end', ts: now, reason: 'noise' });
      }
    } else if (now - this.lastVoiceTs >= o.hangoverMs) {
      this.speaking = false;
      this.aboveFrames = 0;
      this.onEvent({ type: 'end', ts: now, reason: 'silence' });
    }
  }
}

module.exports = { Vad, SENSITIVITY, DEFAULTS };
