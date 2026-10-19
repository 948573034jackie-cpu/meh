import { describe, it, expect } from 'vitest';
import { StreamSentenceSplitter, splitSentences, findSentenceEnd } from '@core/listen/sentences';

/** Streams `text` in chunks of `n` characters and collects what the splitter returns, in order. */
function stream(text: string, n: number): { pieces: string[]; atChunk: number[] } {
  const sp = new StreamSentenceSplitter();
  const pieces: string[] = []; const atChunk: number[] = [];
  let full = '';
  for (let i = 0; i < text.length; i += n) {
    full += text.slice(i, i + n);
    for (const s of sp.push(full)) { pieces.push(s); atChunk.push(i); }
  }
  for (const s of sp.flush(text)) { pieces.push(s); atChunk.push(text.length); }
  return { pieces, atChunk };
}

describe('streamed-text sentence splitter', () => {
  it('returns each sentence as soon as the next one has started', () => {
    const sp = new StreamSentenceSplitter();
    expect(sp.push('Sanguine means hopeful')).toEqual([]);
    expect(sp.push('Sanguine means hopeful.')).toEqual([]); // a closing quote or "..." may still follow
    expect(sp.push('Sanguine means hopeful. Here')).toEqual(['Sanguine means hopeful.']);
    expect(sp.push('Sanguine means hopeful. Here he is cheerful! And')).toEqual(['Here he is cheerful!']);
    expect(sp.flush('Sanguine means hopeful. Here he is cheerful! And calm')).toEqual(['And calm']);
    expect(sp.flush()).toEqual([]);
  });

  it('gives the same sentences whatever the chunk size', () => {
    const text = 'Mr. Darcy said "Never!" and left. It was 3.5 miles, e.g. far away. Was he angry? Yes… very.\n\nA new paragraph without a stop';
    const want = ['Mr. Darcy said "Never!" and left.', 'It was 3.5 miles, e.g. far away.', 'Was he angry?', 'Yes… very.', 'A new paragraph without a stop'];
    expect(splitSentences(text)).toEqual(want);
    for (const n of [1, 2, 3, 7, 13, 50, 500]) expect(stream(text, n).pieces).toEqual(want);
  });

  it('keeps abbreviations, initials, decimals and closing quotes inside the sentence', () => {
    expect(splitSentences('Dr. Smith met J. K. Rowling at St. Paul\'s. Then they went home.')).toEqual(["Dr. Smith met J. K. Rowling at St. Paul's.", 'Then they went home.']);
    expect(splitSentences('He said, "I know." She smiled.')).toEqual(['He said, "I know."', 'She smiled.']);
    expect(splitSentences('It costs $2.50 today. Fine.')).toEqual(['It costs $2.50 today.', 'Fine.']);
  });

  it('splits at line breaks (lists, paragraphs) and drops empty lines', () => {
    expect(splitSentences('First point\n- second point\n\n\nThird.')).toEqual(['First point', '- second point', 'Third.']);
  });

  it('cuts a very long run without punctuation at a comma', () => {
    const long = `${'word '.repeat(30)}and then, ${'more '.repeat(40)}end`;
    const parts = new StreamSentenceSplitter({ maxChars: 200 }).flush(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].endsWith(',')).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' ').trim());
  });

  it('a tiny piece ("Oh.") waits for the next sentence; Chinese punctuation ends sentences too', () => {
    expect(splitSentences('"Oh." Yes, I see.', { minChars: 4 })).toEqual(['"Oh." Yes, I see.']);
    expect(splitSentences('乐观的。Hopeful.')).toEqual(['乐观的。', 'Hopeful.']);
  });

  it('findSentenceEnd: needs to see what follows unless the text is final', () => {
    expect(findSentenceEnd('Hello there.', 0)).toBe(-1);
    expect(findSentenceEnd('Hello there.', 0, true)).toBe(12);
    expect(findSentenceEnd('Hello there. Next', 0)).toBe(12);
    expect(findSentenceEnd('see e.g. this', 0, true)).toBe(13);
  });
});
