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
// --- the "Show transcript" panel gave every word twice (real text from the bug report)
const dbl = [
  'And and then then come come back back with with a a more more sober sober mindset mindset of, of, okay, okay,.',
  "Now now I'm I'm going going to to fix fix all all the the things things that that need need fixing, fixing, you you know. Know.",
  'But But I I think think sometimes sometimes separating separating those those two two halves halves of of our our brain brain.',
  'Can can be be really really beneficial beneficial thing thing for for us us as as writers writers is is like, like,.',
  '"Okay, "Okay, just just let let me me let let me me write write without without judgment judgment and and then then let let.',
  'Me me come come back back and and edit edit later." Later."',
  'Diamond Diamond Rio Rio has has a a song song called called I I believe believe it\'s it\'s called called One One Pump Pump Texico.'
];
const panelCues = dbl.map((text, i) => ({ start: i * 5, end: null, text, words: null }));
const fixed = L.buildSentences(panelCues).map((x) => x.text).join(' ');
console.log('  panel text ->', fixed);
assert(!/\b(\w+) \1\b/i.test(fixed.replace(/ (very|no) \1/i, '')), 'still doubled: ' + fixed);
assert(/going to fix all the things that need fixing/i.test(fixed));
assert(/Diamond Rio has a song called I believe it's called One Pump Texico/i.test(fixed));
console.log('doubled-word tests passed');
// --- more kinds of doubling (every route must come out clean)
const clean = (t) => t.replace(/\s+/g, ' ');
const noDouble = (t, label) => { const m = t.match(/\b([A-Za-z']+)[.,"]* \1\b/i); assert(!m || /^(very|no|let me)/i.test(m[0]), label + ' still doubled: ' + t); };
// (1) doubled, but the cue is short (under 6 words) -> the whole-transcript net must catch it
const shortCues = [];
const lines = ['Hello Hello everyone everyone.', 'Welcome Welcome to to the the show show.', 'Today Today we we learn learn English English.', 'It It is is really really fun fun.', 'Let Let us us start start now now.', 'First First we we read read a a story story.', 'Then Then we we talk talk about about it it.', 'You You can can ask ask me me anything anything.'];
lines.forEach((t, i) => shortCues.push({ start: i * 3, end: null, text: t, words: null }));
const o1 = L.buildSentences(shortCues).map((x) => x.text).join(' ');
console.log('  short doubled cues ->', o1);
assert.equal(o1, 'Hello everyone. Welcome to the show. Today we learn English. It is really fun. Let us start now. First we read a story. Then we talk about it. You can ask me anything.');
// (2) per-word timing where every word is listed twice
const timedDouble = { events: [{ tStartMs: 0, dDurationMs: 4000, segs: ['we', 'we', 'are', 'are', 'going', 'going', 'to', 'to', 'learn', 'learn', 'English.', 'English.'].map((w, k) => ({ utf8: (k ? ' ' : '') + w, tOffsetMs: Math.floor(k / 2) * 500 })) }] };
const o2 = L.buildSentences(L.parseJson3(timedDouble)).map((x) => x.text).join(' ');
console.log('  timed doubled ->', o2);
assert.equal(o2, 'We are going to learn English.');
// (3) real speech with a few natural repeats stays untouched
const speech = L.buildSentences([{ start: 0, end: null, text: 'It was very very good and I said no no that is not what I meant at all today my friend.', words: null }]).map((x) => x.text).join(' ');
assert.equal(speech, 'It was very very good and I said no no that is not what I meant at all today my friend.');
// (4) a doubled transcript keeps sentence times sane (each sentence starts before it ends, in order)
const ss4 = L.buildSentences(shortCues);
assert(ss4.every((x, i) => x.end > x.start && (i === 0 || x.start >= ss4[i - 1].start)));
console.log('more doubling tests passed');
// --- time stamps and transcript checks
assert.equal(L.parseClock('0:05'), 5);
assert.equal(L.parseClock('1:05'), 65);
assert.equal(L.parseClock('1:02:03'), 3723);
assert.equal(L.parseClock('0:05 5 seconds'), 5);                 // a second copy of the time in words must not count
assert.equal(L.parseClock('1:05 1 minute, 5 seconds'), 65);
assert.equal(L.parseClock('  12:34\n'), 754);
assert.equal(L.parseClock('1:05:30 1 hour, 5 minutes, 30 seconds'), 3930);
assert.equal(L.parseClock('no time here'), null);
const tr = L.parseTranscriptResponse({ actions: [{ updateEngagementPanelAction: { content: { transcriptSearchPanelRenderer: { body: { transcriptSegmentListRenderer: { initialSegments: [
  { transcriptSectionHeaderRenderer: { sectionHeader: { sectionHeaderViewModel: {} } } },
  { transcriptSegmentRenderer: { startMs: '65000', endMs: '68500', snippet: { runs: [{ text: 'Hello ' }, { text: 'again' }] } } },
  { transcriptSegmentRenderer: { startMs: '3930000', endMs: '3933000', snippet: { simpleText: 'Much later.' } } },
  { transcriptSegmentRenderer: { startMs: '1000', endMs: '2000', snippet: { runs: [{ text: 'First.' }] } } }] } } } } } }] });
assert.deepEqual(tr.map((c) => [c.start, c.end, c.text]), [[1, 2, 'First.'], [65, 68.5, 'Hello again'], [3930, 3933, 'Much later.']]);
const cu = (arr) => arr.map((s) => ({ start: s, text: 'x' }));
assert.equal(L.judgeCues(cu([0, 60, 590]), 600).ok, true);
assert.equal(L.judgeCues(cu([0, 60, 1800]), 600).tooLate, true);   // another video's transcript
assert.equal(L.judgeCues(cu([0, 60, 200]), 7200).ok, false);       // a 2-hour video that stops after 3 minutes
assert.equal(L.judgeCues(cu([0, 60, 200]), 7200).tooLate, false);
assert.equal(L.judgeCues(cu([0, 30]), 60).ok, true);              // short video: fine
assert.equal(L.judgeCues(cu([0, 5]), 100).ok, true);              // under 2 minutes: never "partial"
assert.equal(L.judgeCues(cu([0, 60]), 0).ok, true);               // length unknown: trust it
assert.equal(L.judgeCues([], 600).ok, false);
console.log('time stamp + transcript check tests passed');
// --- subtitle files from other tools
const srt = '1\n00:00:01,000 --> 00:00:03,500\nHello everyone,\nwelcome to the show.\n\n2\n00:01:05,250 --> 00:01:08,000\n<i>Today</i> we learn &amp; practise.\n\n3\n01:02:03,000 --> 01:02:05,000\nMuch later.\n';
const sc = L.parseSubtitleFile(srt);
assert.deepEqual(sc.map((c) => [c.start, c.text]), [[1, 'Hello everyone, welcome to the show.'], [65.25, 'Today we learn & practise.'], [3723, 'Much later.']]);
const vtt = 'WEBVTT\nKind: captions\n\nNOTE this is a note\n\n00:00:01.000 --> 00:00:03.000 align:start position:0%\nHello<00:00:01.500><c> everyone</c>\n\n00:03.000 --> 00:05.000\nshort form works too\n';
const vc = L.parseSubtitleFile(vtt);
assert.deepEqual(vc.map((c) => [c.start, c.text]), [[1, 'Hello everyone'], [3, 'short form works too']]);
const txt = '[0:05] First line here\n[1:05] Second line\n1:02:03 Hour line\nnot a line\n';
assert.deepEqual(L.parseSubtitleFile(txt).map((c) => [c.start, c.text]), [[5, 'First line here'], [65, 'Second line'], [3723, 'Hour line']]);
assert.deepEqual(L.parseSubtitleFile('nothing useful'), []);
// a 3-hour subtitle file (2000 lines) parses fast and in order
const big = Array.from({ length: 2000 }, (_, i) => { const t = i * 5; const f = (n) => String(n).padStart(2, '0'); return (i + 1) + '\n' + f(Math.floor(t / 3600)) + ':' + f(Math.floor(t % 3600 / 60)) + ':' + f(t % 60) + ',000 --> ' + f(Math.floor((t + 4) / 3600)) + ':' + f(Math.floor((t + 4) % 3600 / 60)) + ':' + f((t + 4) % 60) + ',000\nLine number ' + (i + 1) + ' of the long video.\n'; }).join('\n');
const bc = L.parseSubtitleFile(big);
assert.equal(bc.length, 2000); assert.equal(bc[1999].start, 9995);
assert.equal(L.buildSentences(bc).length > 1000, true);
console.log('subtitle file tests passed');
