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
    // the phone heard 5,000 words (explained "fresh" 200 words ago); the iPad 3,000 (explained "pad" 50 words ago)
    const m = mergeHeard({ n: 5000, asked: { fresh: 4800 } }, { n: 3000, asked: { pad: 2950, fresh: 1000 } });
    expect(m.n).toBe(5000);
    expect(m.asked.fresh).toBe(4800);
    expect(m.asked.pad).toBe(4950);
  });
});
