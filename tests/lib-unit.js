const L = require('../youtube-to-claude/lib.js');
const assert = require('assert');
// 1) typed captions that cut sentences in the middle of a line
let cues = L.parseJson3({events:[
 {tStartMs:0,dDurationMs:3000,segs:[{utf8:'Hello everyone, welcome'}]},
 {tStartMs:3000,dDurationMs:3000,segs:[{utf8:'to the show. Today we'}]},
 {tStartMs:6000,dDurationMs:3000,segs:[{utf8:'learn English. It is'}]},
 {tStartMs:9000,dDurationMs:3000,segs:[{utf8:'really fun, I think.'}]} ]});
let ss = L.buildSentences(cues);
console.log(ss.map(s=>`[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join('\n'));
assert.deepEqual(ss.map(s=>s.text),['Hello everyone, welcome to the show.','Today we learn English.','It is really fun, I think.']);
// 2) auto captions: no punctuation, per-word times, pauses only at natural breaks
function asr(sentences){ // each sentence: string; pause 1.0s between, 0.15 inside; a small 0.5 pause after dangling words
  const evs=[];let t=0;
  for(const s of sentences){ const ws=s.split(' '); const segs=[]; const t0=t;
    ws.forEach((w,i)=>{ segs.push({utf8:(i?' ':'')+w,tOffsetMs:Math.round((t-t0)*1000)}); t+=0.35+(/^(the|and|to|because)$/.test(w)?0.5:0.05); });
    evs.push({tStartMs:Math.round(t0*1000),dDurationMs:Math.round((t-t0)*1000),segs}); t+=1.0; }
  return {events:evs};
}
const text=['so today i want to talk about the reason we forget things','and i think it is because the brain is very busy','when you go to the shop you forget what you wanted','it happens to everyone i promise'];
ss=L.buildSentences(L.parseJson3(asr(text)));
console.log(ss.map(s=>`[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join('\n'));
assert.equal(ss.length,4);
assert.equal(ss[0].text,'So today I want to talk about the reason we forget things.');
assert(ss.every(s=>!/\b(the|and|to|because)\.$/.test(s.text)),'no sentence ends on a dangling word');
// 3) long run without pauses is still cut at a sensible point (not after "the")
const long='one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix twentyseven twentyeight twentynine thirty thirtyone thirtytwo';
ss=L.buildSentences(L.parseJson3(asr([long])));
assert(ss.length>=2 && ss.every(s=>s.text.split(' ').length<=31));
// 4) segment ~30 s, complete sentences, no 3-sentence cap
const five=[];for(let i=0;i<10;i++)five.push({start:i*5,end:i*5+4.5,text:'Sentence '+i+'.'});
let seg=L.pickSegment(five,42);           // current = sentence 8 (40-44.5)
console.log('segment',seg.start,seg.end,(seg.end-seg.start).toFixed(1)+'s',seg.items.length,'sentences');
assert(seg.end-seg.start<=30 && seg.end-seg.start>=20 && seg.items.length>=5);
assert.equal(seg.items[seg.items.length-1].text,'Sentence 8.');
assert.equal(L.pickSegment(five,1).items.length,1);
// 5) transcript text
console.log(L.formatTranscript(L.parseJson3(asr(text))).split('\n')[0]);
console.log('ALL TESTS PASSED');
// --- grouping for display: full sentences on their own line, tiny phrases stay with a neighbour
const items=[{text:'Hello everyone, welcome to the show.'},{text:'Today we learn English.'},{text:'It is fun!'},{text:'Let us start with a story about a small dog.'},{text:'Yeah.'},{text:'Once upon a time there was a dog named Max.'}];
const gr=L.groupSentences(items);
console.log(gr.map(g=>g.text));
assert.equal(gr.length,3);
assert.equal(gr[0].text,'Hello everyone, welcome to the show. Today we learn English. It is fun!');
assert.equal(gr[1].text,'Let us start with a story about a small dog. Yeah.');
assert.deepEqual(L.groupSentences([{text:'Yeah.'},{text:'Okay so here we go now.'}]).map(g=>g.idx),[[0,1]]);
assert.equal(L.groupSentences([{text:'Hi.'},{text:'Yes.'}]).length,1);
console.log('grouping tests passed');
// --- player data in different page formats (mobile YouTube hides it in several ways)
const pr1 = {playabilityStatus:{status:'OK'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:'https://x/y',languageCode:'en'}]}}};
const esc = (o) => JSON.stringify(o).replace(/[{}"]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
const pages = {
  'var x = {...}': '<script>var ytInitialPlayerResponse = ' + JSON.stringify(pr1) + ';var a=1;</script>',
  'after a plain mention': '<script>if (window.ytInitialPlayerResponse) { go(); }</script><script>ytInitialPlayerResponse = ' + JSON.stringify(pr1) + ';</script>',
  'property in JSON': '<script>var data = {"ytInitialPlayerResponse":' + JSON.stringify(pr1) + ',"other":1};</script>',
  'JSON.parse(\\x7b...)': "<script>ytInitialPlayerResponse = JSON.parse('" + esc(pr1) + "');</script>",
  'JSON.parse with \\uXXXX and quotes': '<script>ytInitialPlayerResponse = JSON.parse("' + JSON.stringify(pr1).replace(/"/g, '\\"').replace(/e/g, '\\u0065') + '");</script>',
};
for (const [name, html] of Object.entries(pages)) {
  const got = L.extractPlayerResponse(html);
  assert(got && got.captions.playerCaptionsTracklistRenderer.captionTracks[0].languageCode === 'en', 'failed: ' + name);
  console.log('  ok  ' + name);
}
assert.equal(L.extractPlayerResponse('<html>nothing here</html>'), null);
console.log('player-data formats passed');
// --- rolling auto-captions: the same words must not appear twice
const roll = (evs) => L.buildSentences(L.parseJson3({ events: evs })).map((s) => s.text).join(' ');
// (a) line 2 starts with the end of line 1, typed without per-word timing
let r1 = roll([
  { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'we are going to learn' }] },
  { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'going to learn how to speak' }] },
  { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: 'how to speak clearly today.' }] }]);
console.log('  rolling (a):', r1);
assert.equal(r1, 'We are going to learn how to speak clearly today.');
// (b) the whole previous line comes back at the start of the next one
let r2 = roll([
  { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello everyone.' }] },
  { tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: 'Hello everyone. Welcome to the show.' }] }]);
console.log('  rolling (b):', r2);
assert.equal(r2, 'Hello everyone. Welcome to the show.');
// (c) per-word timing, second line repeats the last words with slightly different times
let r3 = roll([
  { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'we' }, { utf8: ' are', tOffsetMs: 300 }, { utf8: ' going', tOffsetMs: 600 }, { utf8: ' to', tOffsetMs: 900 }] },
  { tStartMs: 1500, dDurationMs: 3000, segs: [{ utf8: 'going', tOffsetMs: 20 }, { utf8: ' to', tOffsetMs: 330 }, { utf8: ' learn', tOffsetMs: 700 }, { utf8: ' English.', tOffsetMs: 1100 }] }]);
console.log('  rolling (c):', r3);
assert.equal(r3, 'We are going to learn English.');
// (d) real repeats stay: "no, no, no" said by a person is not rolling
let r4 = roll([{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'No, no, no, that is wrong.' }] }]);
assert.equal(r4, 'No, no, no, that is wrong.');
let r5 = roll([{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'I said very' }] }, { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'very good work.' }] }]);
assert.equal(r5, 'I said very very good work.'); // only one word overlaps: kept
console.log('rolling-caption tests passed');
