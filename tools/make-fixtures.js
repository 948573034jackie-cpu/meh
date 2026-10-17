// Builds DASH test media with ffmpeg into test/fixtures/ (git-ignored):
//   a 30 s song-like signal whose loudness changes every 2 s, split into
//   WebM/Opus audio segments and VP9 video segments, like YouTube serves them.
// Run: node tools/make-fixtures.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const out = process.env.FIXTURES_OUT || path.join(__dirname, '..', 'test', 'fixtures');
const DUR = 30;

function ff(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

function timeline(mpdFile) {
  // Reads <S t d r> entries of the single representation.
  const xml = fs.readFileSync(mpdFile, 'utf8');
  const scale = Number((xml.match(/timescale="(\d+)"/) || [])[1] || 1000);
  const segs = [];
  let t = 0;
  for (const m of xml.matchAll(/<S\s+([^>]*)\/>/g)) {
    const attr = (n) => {
      const r = m[1].match(new RegExp(n + '="(\\d+)"'));
      return r ? Number(r[1]) : null;
    };
    if (attr('t') !== null) t = attr('t');
    const d = attr('d');
    const r = attr('r') || 0;
    for (let i = 0; i <= r; i++) {
      segs.push({ start: t / scale, end: (t + d) / scale });
      t += d;
    }
  }
  return segs;
}

function build(name, inputArgs, codecArgs, segType, ext, mime, segDur) {
  const dir = path.join(out, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  ff([...inputArgs, ...codecArgs, '-f', 'dash', '-seg_duration', String(segDur), '-dash_segment_type', segType,
    '-init_seg_name', `init.${ext}`, '-media_seg_name', `seg-$Number%03d$.${ext}`, path.join(dir, 'out.mpd')]);
  const segs = timeline(path.join(dir, 'out.mpd')).map((s, i) => ({
    ...s,
    url: `${name}/seg-${String(i + 1).padStart(3, '0')}.${ext}`,
  }));
  return { mime, init: `${name}/init.${ext}`, segs };
}

fs.mkdirSync(out, { recursive: true });
// Loud (sine at full scale) on even 2-second blocks, quiet on odd ones,
// plus a bass thump every second so the colours change.
const TEST_SIGNAL = `aevalsrc='(if(lt(mod(t\\,4)\\,2)\\,0.9\\,0.12))*sin(2*PI*440*t)*0.8+0.2*sin(2*PI*60*t)*exp(-8*mod(t\\,1))':s=48000:d=${DUR}`;
// DEMO=1: a song-like signal (kick, hats, bass line, melody, quiet bridge) for screenshots.
const DEMO_SIGNAL = `aevalsrc='(0.55+0.45*between(mod(t\\,16)\\,0\\,11.9))*(` +
  `0.9*sin(2*PI*(50+90*exp(-25*mod(t\\,0.5)))*mod(t\\,0.5))*exp(-9*mod(t\\,0.5))` +
  `+0.18*(random(0)*2-1)*exp(-40*mod(t+0.25\\,0.5))*gte(t\\,4)` +
  `+0.25*sin(2*PI*(55*pow(2\\,floor(mod(t\\,8)/2)/12*3))*t)` +
  `+0.22*sin(2*PI*(440*pow(2\\,floor(mod(t*2\\,7))/12*2))*t)*gte(mod(t\\,8)\\,2))':s=48000:d=${DUR}`;
// A drum groove at 96 BPM (a beat every 0.625 s), the first bar's "1" at
// 0.8 s: kick on 1 and 3, snare on 2 and 4, hi-hats on eighths. For the beat
// grid, quantize and drum view tests.
const DRUM_SIGNAL = `aevalsrc='gte(t\\,0.8)*(` +
  `0.9*sin(2*PI*(50+90*exp(-25*mod(t-0.8\\,1.25)))*mod(t-0.8\\,1.25))*exp(-9*mod(t-0.8\\,1.25))` +
  `+gte(t\\,1.425)*((random(0)*2-1)*0.45*exp(-30*mod(t-1.425\\,1.25))+0.3*sin(2*PI*190*mod(t-1.425\\,1.25))*exp(-25*mod(t-1.425\\,1.25)))` +
  `+(random(1)*2-1)*0.15*exp(-90*mod(t-0.8\\,0.3125)))':s=48000:d=${DUR}`;
const audioIn = ['-f', 'lavfi', '-i', process.env.DEMO ? DEMO_SIGNAL : TEST_SIGNAL];
const audio = build('audio', audioIn, ['-c:a', 'libopus', '-b:a', '96k'], 'webm', 'webm', 'audio/webm; codecs="opus"', 2);
const drums = build('drums', ['-f', 'lavfi', '-i', DRUM_SIGNAL], ['-c:a', 'libopus', '-b:a', '96k'], 'webm', 'webm', 'audio/webm; codecs="opus"', 2);
const video = build('video', ['-f', 'lavfi', '-i', `testsrc=size=160x90:rate=24:duration=${DUR}`],
  ['-c:v', 'libvpx-vp9', '-b:v', '120k', '-deadline', 'realtime', '-cpu-used', '8', '-g', '24', '-keyint_min', '24'],
  'webm', 'webm', 'video/webm; codecs="vp9"', 2);

// Same audio as fragmented MP4/AAC, for the parser tests.
const mp4 = build('mp4audio', audioIn, ['-c:a', 'aac', '-b:a', '128k'], 'mp4', 'm4s', 'audio/mp4; codecs="mp4a.40.2"', 2);
fs.renameSync(path.join(out, 'mp4audio', 'init.m4s'), path.join(out, 'mp4audio', 'init.mp4'));
mp4.init = 'mp4audio/init.mp4';

// A song that changes tempo: 20 beats at 90 BPM, then 30 at 120 (drums,
// bass, chords), for the "the grid follows the tempo" test.
const { synth, tempoMap, popKit, drumKit } = require('../test/music.js');
const tempoSong = synth({ dur: DUR, make(S) { const B = tempoMap(0.9, [[20, 90], [30, 120]]); popKit(S, B); return B; } }, 48000);
const raw = path.join(out, 'tempo.f32');
fs.writeFileSync(raw, Buffer.from(tempoSong.x.buffer));
const tempo = build('tempo', ['-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', raw], ['-c:a', 'libopus', '-b:a', '96k', '-ac', '2'], 'webm', 'webm', 'audio/webm; codecs="opus"', 2);
fs.rmSync(raw);
// A whole drum kit (kick, snare, hi-hats, ride, crash, tom fills, cowbell) for the drum chart.
const kitSpec = drumKit(11, 4, 7, 7, 4);
const kitSong = synth({ ...kitSpec, dur: DUR }, 48000);
fs.writeFileSync(raw, Buffer.from(kitSong.x.buffer));
const kit = build('kit', ['-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', raw], ['-c:a', 'libopus', '-b:a', '128k', '-ac', '2'], 'webm', 'webm', 'audio/webm; codecs="opus"', 2);
fs.rmSync(raw);

fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ duration: DUR, audio, video, mp4, drums, drumBpm: 96, drumFirstBeat: 0.8, tempo, tempoBeats: tempoSong.beats, kit, kitHits: kitSpec.hits }, null, 2));
console.log('fixtures written to', out, `audio segs=${audio.segs.length} video segs=${video.segs.length}`);
