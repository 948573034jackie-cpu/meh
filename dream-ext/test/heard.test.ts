import { describe, it, expect } from 'vitest';
import { HeardCounter, readHeard, mergeHeard } from '../src/heard';

describe('the 1,000-word rule, counted across videos', () => {
  it('a word explained is not asked again within the next 1,000 words heard, in the same video', () => {
    const h = new HeardCounter();
    h.hear('s1', 0, 10);
    h.ask('meticulous', 5);
    expect(h.lately('meticulous', 400, 1000)).toBe(true);
    expect(h.lately('meticulous', 1004, 1000)).toBe(true);
    expect(h.lately('meticulous', 1006, 1000)).toBe(false);
    expect(h.lately('other', 400, 1000)).toBe(false);
    expect(h.lately('meticulous', 400, 0)).toBe(false);
  });
  it('the count goes on in the NEXT video', () => {
    const a = new HeardCounter();
    for (let i = 0; i < 30; i++) a.hear(`a${i}`, i * 10, 10);       // 300 words of video A
    a.ask('gregarious', 290);
    const saved = JSON.parse(JSON.stringify(a.state()));
    expect(saved.n).toBe(300);
    // video B starts: the same learner, the counter goes on from 300
    const b = new HeardCounter(saved);
    expect(b.total).toBe(300);
    expect(b.lately('gregarious', 0, 1000)).toBe(true);              // 10 words ago
    expect(b.lately('gregarious', 900, 1000)).toBe(true);            // 910 words after it
    expect(b.lately('gregarious', 1000, 1000)).toBe(false);          // 1,010 words after it
    for (let i = 0; i < 100; i++) b.hear(`b${i}`, i * 10, 10);       // 1,000 words of video B
    expect(b.total).toBe(1300);
    expect(b.lately('gregarious', 1000, 1000)).toBe(false);
  });
  it('hearing the same sentence again (a rewind, a replay) does not count again', () => {
    const h = new HeardCounter();
    h.hear('s1', 0, 12); h.hear('s2', 12, 8);
    expect(h.total).toBe(20);
    h.hear('s1', 0, 12); h.hear('s2', 12, 8); h.hear('s1', 0, 12);
    expect(h.total).toBe(20);
    h.hear('s3', 20, 5);
    expect(h.total).toBe(25);
  });
  it('a jump forward in the video does not count the words that were skipped', () => {
    const h = new HeardCounter();
    h.hear('s1', 0, 10);
    h.ask('ephemeral', 5);
    h.hear('s900', 9000, 10);           // jumped far ahead: only 20 words were heard
    expect(h.total).toBe(20);
    expect(h.lately('ephemeral', 9010, 1000)).toBe(true);
  });
  it('saved data: broken data is an empty state; old words are dropped; two devices merge', () => {
    expect(readHeard(null)).toEqual({ n: 0, asked: {} });
    expect(readHeard({ n: 'x', asked: 3 })).toEqual({ n: 0, asked: {} });
    expect(readHeard({ n: 50, asked: { a: 10, b: 99, c: 'q' } })).toEqual({ n: 50, asked: { a: 10 } });
    const h = new HeardCounter({ n: 5000, asked: { old: 100, fresh: 4800 } });
    expect(h.state(1000).asked).toEqual({ fresh: 4800 });
    // the phone heard 5,000 words (explained "fresh" 200 words ago); a copy that is NOT ahead comes in as it is
    const m = mergeHeard({ n: 5000, asked: { fresh: 4800 } }, { n: 3000, asked: { pad: 2950, fresh: 1000 } });
    expect(m.n).toBe(5000);
    expect(m.asked.fresh).toBe(4800);
    expect(m.asked.pad).toBe(2950);
    // a copy that IS ahead: this device's words move up with the counter (still "200 words ago")
    const up = mergeHeard({ n: 5000, asked: { fresh: 4800 } }, { n: 8000, asked: { pad: 7900 } });
    expect(up).toEqual({ n: 8000, asked: { fresh: 7800, pad: 7900 } });
  });
  it('reading this device\'s OWN older copy back never makes an old explanation new (the rule must not become "never again")', () => {
    // "foo" explained at 5,000 and written to the shared file; 300 words later the file is read back and merged
    let mine: { n: number; asked: Record<string, number> } = { n: 5300, asked: { foo: 5000 } };
    const file = { n: 5000, asked: { foo: 5000 } };
    for (let i = 0; i < 5; i++) { mine = mergeHeard(mine, file); mine = { n: mine.n + 300, asked: mine.asked }; }
    expect(mine.asked.foo).toBe(5000);
    const h = new HeardCounter(mine);
    expect(h.total).toBe(6800);
    expect(h.lately('foo', 0, 1000)).toBe(false);   // 1,800 words ago: it may be explained again
    // very old words are dropped at a merge
    expect(mergeHeard({ n: 50000, asked: { old: 100, now: 49990 } }, { n: 1, asked: {} }).asked).toEqual({ now: 49990 });
  });
});
