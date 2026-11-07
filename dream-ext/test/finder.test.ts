import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseFinderReply, buildFinderPrompt, fallbackQueries, mergeHits, type FoundVideo } from '../src/finder';

describe('parseFinderReply', () => {
  it('strict JSON', () => {
    expect(parseFinderReply('{"queries":[{"q":"music theory explained","why":"You are a musician."},{"q":"english for musicians","why":"Words for your work."}]}'))
      .toEqual([{ q: 'music theory explained', why: 'You are a musician.' }, { q: 'english for musicians', why: 'Words for your work.' }]);
  });
  it('code fences, extra text, other key names, a bare list', () => {
    expect(parseFinderReply('Sure!\n```json\n{"queries":[{"query":"jazz piano lesson","reason":"You play."}]}\n```')).toEqual([{ q: 'jazz piano lesson', why: 'You play.' }]);
    expect(parseFinderReply('["a b", "c d", "a b"]')).toEqual([{ q: 'a b', why: '' }, { q: 'c d', why: '' }]);
  });
  it('a cut-off answer keeps the complete pairs; at most 5; junk = []', () => {
    expect(parseFinderReply('{"queries":[{"q":"one","why":"x \\"y\\""},{"q":"two","why":"z"},{"q":"thr')).toEqual([{ q: 'one', why: 'x "y"' }, { q: 'two', why: 'z' }]);
    const many = JSON.stringify({ queries: Array.from({ length: 8 }, (_, i) => ({ q: `q${i}`, why: '' })) });
    expect(parseFinderReply(many)).toHaveLength(5);
    expect(parseFinderReply('no idea')).toEqual([]);
    expect(parseFinderReply('')).toEqual([]);
  });
});

describe('finder prompt and merging', () => {
  it('the prompt carries what was said, the level and the filter', () => {
    const p = buildFinderPrompt('I am a musician and I want to talk with clients', 'about lower B2 for reading', 'any');
    expect(p.user).toContain('musician');
    expect(p.user).toContain('about B2');
    expect(p.user).toMatch(/level B2/);
    expect(p.system).toMatch(/JSON only/);
    expect(buildFinderPrompt('', 'B2', 'A2').user).toMatch(/easy English/);
    expect(fallbackQueries('  jazz   piano ', 'A1')[0].q).toBe('easy English jazz piano');
    expect(fallbackQueries('', 'any')[0].q).toBe('English conversation');
  });
  it('hits of several searches take turns, without repeats, keeping the reason', () => {
    const v = (id: string): FoundVideo => ({ id, title: id, channel: '' });
    const out = mergeHits([[v('a'), v('b'), v('c')], [v('b'), v('d')], []], [{ q: '1', why: 'w1' }, { q: '2', why: 'w2' }, { q: '3', why: 'w3' }], 4);
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'd', 'c']);
    expect(out.map((x) => x.why)).toEqual(['w1', 'w2', 'w2', 'w1']); // (b came first from the second search)
  });
});

// youtube.js is a content script (no import): run its pure finder part on its own
const src = fs.readFileSync(path.resolve(__dirname, '../../youtube-to-claude/youtube.js'), 'utf8');
const part = src.slice(src.indexOf('// FINDER-PURE-START'), src.indexOf('// FINDER-PURE-END'));
const { finderInitialData, finderVideos } = new Function(`${part}; return { finderInitialData, finderVideos };`)() as {
  finderInitialData(html: string): unknown;
  finderVideos(data: unknown, max?: number): { id: string; title: string; channel: string; lengthSeconds?: number; thumb?: string }[];
};

const WEB = {
  contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
    { channelRenderer: { channelId: 'UC1', title: { simpleText: 'A channel' } } },
    { videoRenderer: { videoId: 'AAAAAAAAAAA', title: { runs: [{ text: 'Learn ' }, { text: 'jazz' }] }, ownerText: { runs: [{ text: 'Jazz Lab' }] }, lengthText: { simpleText: '12:34' },
      thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/AAAAAAAAAAA/default.jpg' }, { url: 'https://i.ytimg.com/vi/AAAAAAAAAAA/hq720.jpg' }] } } },
    { videoRenderer: { videoId: 'LIVELIVELIV', title: { runs: [{ text: 'Live now' }] }, badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }] } },
    { shelfRenderer: { content: { verticalListRenderer: { items: [
      { videoRenderer: { videoId: 'BBBBBBBBBBB', title: { simpleText: 'Piano talk' }, longBylineText: { runs: [{ text: 'Keys' }] }, lengthText: { simpleText: '1:02:03' } } },
      { videoRenderer: { videoId: 'AAAAAAAAAAA', title: { simpleText: 'again' } } },
    ] } } } },
    { lockupViewModel: { contentId: 'CCCCCCCCCCC', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: 'New shape' },
      metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'Shape Channel' } }] }] } } } },
      contentImage: { thumbnailViewModel: { image: { sources: [{ url: 'https://i.ytimg.com/vi/CCCCCCCCCCC/hq.jpg' }] }, overlays: [{ thumbnailBadgeViewModel: { text: '4:05' } }] } } } },
  ] } }] } } } },
};
const MWEB = {
  contents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
    { videoWithContextRenderer: { videoId: 'DDDDDDDDDDD', headline: { runs: [{ text: 'Café “English” for musicians' }] }, shortBylineText: { runs: [{ text: 'Mobile Ch' }] },
      lengthText: { runs: [{ text: '8:00' }] }, thumbnail: { thumbnails: [{ url: '//i.ytimg.com/vi/DDDDDDDDDDD/mq.jpg' }] } } },
    { compactVideoRenderer: { videoId: 'EEEEEEEEEEE', title: { simpleText: 'Compact' }, shortBylineText: { runs: [{ text: 'C' }] } } },
  ] } }] } },
};
/** how m.youtube.com writes it: a JavaScript string with \x escapes */
const jsEscape = (s: string) => s.replace(/[^A-Za-z0-9 ]/g, (c) => { const n = c.charCodeAt(0); return n < 256 ? '\\x' + n.toString(16).padStart(2, '0') : '\\u' + n.toString(16).padStart(4, '0'); });

describe('youtube.js search parser', () => {
  it('the WEB page: videos only, no live, no repeats, all fields', () => {
    const html = `<script>if (window.ytInitialData) {}</script><script nonce="x">var ytInitialData = ${JSON.stringify(WEB)};</script>`;
    const v = finderVideos(finderInitialData(html));
    expect(v.map((x) => x.id)).toEqual(['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC']);
    expect(v[0]).toEqual({ id: 'AAAAAAAAAAA', title: 'Learn jazz', channel: 'Jazz Lab', lengthSeconds: 754, thumb: 'https://i.ytimg.com/vi/AAAAAAAAAAA/hq720.jpg' });
    expect(v[1].lengthSeconds).toBe(3723);
    expect(v[1].channel).toBe('Keys');
    expect(v[2]).toMatchObject({ title: 'New shape', channel: 'Shape Channel', lengthSeconds: 245 });
  });
  it('the MWEB page (escaped string) and window["ytInitialData"]', () => {
    const html = `<script>var ytInitialData = '${jsEscape(JSON.stringify(MWEB))}';</script>`;
    const v = finderVideos(finderInitialData(html));
    expect(v.map((x) => x.id)).toEqual(['DDDDDDDDDDD', 'EEEEEEEEEEE']);
    expect(v[0]).toEqual({ id: 'DDDDDDDDDDD', title: 'Café “English” for musicians', channel: 'Mobile Ch', lengthSeconds: 480, thumb: 'https://i.ytimg.com/vi/DDDDDDDDDDD/mq.jpg' });
    expect(v[1].thumb).toBe('https://i.ytimg.com/vi/EEEEEEEEEEE/mqdefault.jpg');
    expect(finderVideos(finderInitialData(`window["ytInitialData"] = ${JSON.stringify(MWEB)};`)).length).toBe(2);
  });
  it('at most max; nothing usable = []', () => {
    const many = { items: Array.from({ length: 30 }, (_, i) => ({ videoRenderer: { videoId: `v${String(i).padStart(10, '0')}`, title: { simpleText: 't' } } })) };
    expect(finderVideos(many)).toHaveLength(12);
    expect(finderVideos(many, 5)).toHaveLength(5);
    expect(finderInitialData('<html>nothing</html>')).toBeNull();
    expect(finderVideos(null)).toEqual([]);
  });
});
