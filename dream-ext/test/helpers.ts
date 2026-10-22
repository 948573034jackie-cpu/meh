import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { createDictionary } from '@core/dict/dictionary';
import type { Dictionary } from '@core/dict/types';
import type { DictData } from '@shared/api';

let dict: Dictionary | null = null;
/** the real dictionary that ships with the extension */
export function realDictionary(): Dictionary {
  if (dict) return dict;
  const gz = fs.readFileSync(path.resolve(__dirname, '../../youtube-to-claude/dream/dict.json.gz'));
  dict = createDictionary(JSON.parse(zlib.gunzipSync(gz).toString('utf8')) as DictData);
  return dict;
}

/** a video element stand-in whose time moves with a fake clock */
export class FakeVideo {
  private t = 0;
  get currentTime(): number { return this.t; }
  /** a jump (anything but playing on) is logged */
  set currentTime(v: number) { this.events.push(`seek@${v.toFixed(2)}`); this.t = v; this.ended = false; }
  paused = true;
  ended = false;
  playbackRate = 1;
  duration: number;
  events: string[] = [];
  constructor(duration = 600) { this.duration = duration; }
  async play(): Promise<void> { this.paused = false; this.events.push(`play@${this.t.toFixed(2)}`); }
  pause(): void { if (!this.paused) this.events.push(`pause@${this.t.toFixed(2)}`); this.paused = true; }
  /** advance the clock by `sec` seconds of playing */
  tick(sec: number): void { if (!this.paused) { this.t = Math.min(this.duration, this.t + sec * this.playbackRate); if (this.t >= this.duration) { this.ended = true; this.paused = true; } } }
}
