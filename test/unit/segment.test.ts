import { describe, it, expect } from 'vitest';
import { createSegmenter } from '@core/segment';
import type { Sentence, Token } from '@core/segment';

const seg = createSegmenter();

/** Sentence texts as the reader would render them. */
function sentences(text: string): string[] {
  return seg.segmentParagraph(text).map((s) => text.slice(s.start, s.end));
}

/** "kind:text" for every token of every sentence. */
function tokenList(text: string): string[] {
  return seg.segmentParagraph(text).flatMap((s) => s.tokens.map((t) => `${t.kind}:${t.text}`));
}

function words(text: string): string[] {
  return seg.segmentParagraph(text).flatMap((s) => s.tokens.filter((t) => t.kind !== 'punct').map((t) => t.text));
}

/** The structural invariants every result must satisfy, whatever the input. */
function checkInvariants(text: string, out: Sentence[] = seg.segmentParagraph(text)): Sentence[] {
  let prevEnd = -1;
  out.forEach((s, i) => {
    expect(s.index).toBe(i);
    expect(s.start).toBeGreaterThanOrEqual(0);
    expect(s.end).toBeLessThanOrEqual(text.length);
    expect(s.end).toBeGreaterThan(s.start); // never empty
    expect(s.start).toBeGreaterThanOrEqual(prevEnd); // sorted, non-overlapping
    prevEnd = s.end;
    const st = text.slice(s.start, s.end);
    expect(st).toBe(st.trim()); // trimmed
    checkTokens(text, s.tokens, s);
  });
  return out;
}

function checkTokens(text: string, tokens: Token[], within?: { start: number; end: number }): void {
  let prevEnd = within ? within.start : 0;
  for (const t of tokens) {
    expect(t.text).toBe(text.slice(t.start, t.end));
    expect(t.end).toBeGreaterThan(t.start);
    expect(t.start).toBeGreaterThanOrEqual(prevEnd);
    expect(t.kind).not.toBe('space'); // convention: whitespace is never a token
    expect(/^\s+$/.test(t.text)).toBe(false);
    if (within) expect(t.end).toBeLessThanOrEqual(within.end);
    prevEnd = t.end;
  }
}

describe('createSegmenter', () => {
  it('returns an object implementing the Segmenter interface', () => {
    expect(typeof seg.segmentParagraph).toBe('function');
    expect(typeof seg.tokenize).toBe('function');
  });
});

describe('sentence segmentation: the spec cases', () => {
  it('keeps a title abbreviation and a.m./p.m. inside one sentence', () => {
    const t = 'Mr. Darcy arrived at 5 p.m. on Tuesday.';
    expect(sentences(t)).toEqual([t]);
    checkInvariants(t);
  });

  it('splits after a closing quote that ends a question, and keeps the quote inside the sentence', () => {
    const t = '“Is it true,” she asked, “that you never dance?” He said nothing.';
    expect(sentences(t)).toEqual(['“Is it true,” she asked, “that you never dance?”', 'He said nothing.']);
    checkInvariants(t);
  });

  it('merges "Dr." and keeps an ellipsis followed by lowercase inside the sentence', () => {
    const t = 'Dr. Smith remained sanguine: the weather, he insisted, would improve by Thursday... or at least by Friday!';
    expect(sentences(t)).toEqual([t]);
    checkInvariants(t);
  });

  it('treats initials as part of the name', () => {
    const t = 'It was J. R. R. Tolkien who wrote it. Nobody else.';
    expect(sentences(t)).toEqual(['It was J. R. R. Tolkien who wrote it.', 'Nobody else.']);
    checkInvariants(t);
  });

  it('does not treat a decimal number as an abbreviation', () => {
    const t = 'He paid $3.50. Then he left.';
    expect(sentences(t)).toEqual(['He paid $3.50.', 'Then he left.']);
    expect(tokenList(t)).toEqual(['word:He', 'word:paid', 'punct:$', 'number:3.50', 'punct:.', 'word:Then', 'word:he', 'word:left', 'punct:.']);
    checkInvariants(t);
  });

  it('keeps "... and" together and splits at the real period', () => {
    const t = 'She whispered... and then stopped. Silence.';
    expect(sentences(t)).toEqual(['She whispered... and then stopped.', 'Silence.']);
    expect(tokenList(t)).toContain('punct:...');
    checkInvariants(t);
  });

  it('handles "Fig." and "p." followed by numbers', () => {
    const t = 'See Fig. 3 and p. 12 for details. Done.';
    expect(sentences(t)).toEqual(['See Fig. 3 and p. 12 for details.', 'Done.']);
    checkInvariants(t);
  });

  it('keeps U.S. / U.K. inside their sentences and still splits between them', () => {
    const t = 'The U.S. economy grew. The U.K. did not.';
    expect(sentences(t)).toEqual(['The U.S. economy grew.', 'The U.K. did not.']);
    expect(words(t)).toEqual(['The', 'U.S', 'economy', 'grew', 'The', 'U.K', 'did', 'not']);
    checkInvariants(t);
  });

  it('keeps "the U.S. Then" split (non-title abbreviation followed by an uppercase word)', () => {
    const t = 'He went to the U.S. Then he left.';
    expect(sentences(t)).toEqual(['He went to the U.S.', 'Then he left.']);
    checkInvariants(t);
  });

  it('makes a paragraph with no terminal punctuation one sentence', () => {
    const t = 'WAR AND PEACE';
    const out = checkInvariants(t);
    expect(sentences(t)).toEqual([t]);
    expect(out[0].tokens.map((k) => k.text)).toEqual(['WAR', 'AND', 'PEACE']);
    expect(out[0].tokens.every((k) => k.kind === 'word')).toBe(true);
  });

  it('splits "Hello?! Really?!" and collapses the punctuation runs', () => {
    const t = 'Hello?! Really?!';
    expect(sentences(t)).toEqual(['Hello?!', 'Really?!']);
    expect(tokenList(t)).toEqual(['word:Hello', 'punct:?!', 'word:Really', 'punct:?!']);
    checkInvariants(t);
  });

  it('splits very short sentences', () => {
    const t = 'One. Two. Three.';
    expect(sentences(t)).toEqual(['One.', 'Two.', 'Three.']);
    checkInvariants(t);
  });

  it('keeps e.g. / i.e. / etc. inside one sentence', () => {
    const t = 'e.g. apples, i.e. fruit, etc. are fine.';
    expect(sentences(t)).toEqual([t]);
    checkInvariants(t);
  });
});

describe('sentence segmentation: abbreviations and quotes', () => {
  it('always merges title abbreviations, including in ALL CAPS headings', () => {
    expect(sentences('Mrs. Bennet and Ms. Lucas met Prof. Brown at St. James. Later.')).toEqual([
      'Mrs. Bennet and Ms. Lucas met Prof. Brown at St. James.', 'Later.',
    ]);
    expect(sentences('MR. DARCY ARRIVED. HE LEFT.')).toEqual(['MR. DARCY ARRIVED.', 'HE LEFT.']);
    expect(sentences('Capt. Wentworth, Col. Brandon, Gen. Tilney and Lt. Price. All of them.')).toEqual([
      'Capt. Wentworth, Col. Brandon, Gen. Tilney and Lt. Price.', 'All of them.',
    ]);
    expect(sentences('Rev. Collins wrote to Sr. Pedro and Jr. Pedro and the Hon. Mr. Smith. Done.')).toEqual([
      'Rev. Collins wrote to Sr. Pedro and Jr. Pedro and the Hon. Mr. Smith.', 'Done.',
    ]);
    expect(sentences('Messrs. Lee and Mme. Dupont and Mlle. Odile left. Yes.')).toEqual([
      'Messrs. Lee and Mme. Dupont and Mlle. Odile left.', 'Yes.',
    ]);
    expect(sentences('We climbed Mt. Fuji and Sgt. Pepper sang. Yes.')).toEqual(['We climbed Mt. Fuji and Sgt. Pepper sang.', 'Yes.']);
  });

  it('always merges "vs." (even before an uppercase word)', () => {
    expect(sentences('Brown vs. Board of Education was decided. Done.')).toEqual(['Brown vs. Board of Education was decided.', 'Done.']);
    expect(sentences('e.g. Apples are good. Yes.')).toEqual(['e.g. Apples are good.', 'Yes.']);
  });

  it('keeps conditional abbreviations split when a capitalised sentence follows', () => {
    expect(sentences('at 5 p.m. He left.')).toEqual(['at 5 p.m.', 'He left.']);
    expect(sentences('apples, pears, etc. The rest stayed.')).toEqual(['apples, pears, etc.', 'The rest stayed.']);
    expect(sentences('Apple Inc. The company grew.')).toEqual(['Apple Inc.', 'The company grew.']);
    expect(sentences('Smith et al. The study found it. Yes.')).toEqual(['Smith et al.', 'The study found it.', 'Yes.']);
  });

  it('merges conditional abbreviations followed by numbers, lowercase or symbols', () => {
    expect(sentences('No. 5 is here. Fine.')).toEqual(['No. 5 is here.', 'Fine.']);
    expect(sentences('Jan. 5, 2020 was cold. Dec. 24 was not. Yes.')).toEqual(['Jan. 5, 2020 was cold.', 'Dec. 24 was not.', 'Yes.']);
    expect(sentences('See ch. 3, vol. 2, pp. 10-12 and ed. 4 (approx. 50 pages). Then stop.')).toEqual([
      'See ch. 3, vol. 2, pp. 10-12 and ed. 4 (approx. 50 pages).', 'Then stop.',
    ]);
    expect(sentences('It was 300 B.C. or A.D. 50, around 10 a.m. or 2 p.m. in the U.S.A. and Ltd. and Co. and Corp. entities. Done.')).toEqual([
      'It was 300 B.C. or A.D. 50, around 10 a.m. or 2 p.m. in the U.S.A. and Ltd. and Co. and Corp. entities.', 'Done.',
    ]);
    expect(sentences('Born Feb. 2, Mar. 3, Apr. 4, Jun. 6, Jul. 7, Aug. 8, Sep. 9, Sept. 9, Oct. 10, Nov. 11. Fine.')).toEqual([
      'Born Feb. 2, Mar. 3, Apr. 4, Jun. 6, Jul. 7, Aug. 8, Sep. 9, Sept. 9, Oct. 10, Nov. 11.', 'Fine.',
    ]);
    expect(sentences('cf. the appendix. Then stop.')).toEqual(['cf. the appendix.', 'Then stop.']);
  });

  it('does not mistake ordinary words that end in an abbreviation for abbreviations', () => {
    // "first" ends with "st", "it" is not "it." abbreviation, "fig" lower-case + uppercase next stays split
    expect(sentences('He came first. Then second.')).toEqual(['He came first.', 'Then second.']);
    expect(sentences('It is a fig. The tree is old.')).toEqual(['It is a fig.', 'The tree is old.']);
    expect(sentences('She said no. He said yes.')).toEqual(['She said no.', 'He said yes.']);
  });

  it('does not treat a trailing ellipsis after an abbreviation-like word as an abbreviation', () => {
    expect(sentences('He wanted apples, pears, etc... Then he left.')).toEqual(['He wanted apples, pears, etc...', 'Then he left.']);
  });

  it('treats single capital letters as initials, except the pronoun "I"', () => {
    expect(sentences('J. K. Rowling and A. A. Milne wrote books. True.')).toEqual(['J. K. Rowling and A. A. Milne wrote books.', 'True.']);
    expect(sentences('It was I. Nobody else.')).toEqual(['It was I.', 'Nobody else.']);
    expect(sentences('J. I. Packer wrote it. Done.')).toEqual(['J. I. Packer wrote it.', 'Done.']);
    expect(sentences('Dr. I. Smith wrote it. Done.')).toEqual(['Dr. I. Smith wrote it.', 'Done.']);
  });

  it('merges when the next segment starts with a lowercase letter', () => {
    expect(sentences('"Stop!" he said. "Now." Then silence.')).toEqual(['"Stop!" he said.', '"Now."', 'Then silence.']);
    expect(sentences('Wait! what? no.')).toEqual(['Wait! what? no.']);
    expect(sentences('She whispered… and then stopped. Silence.')).toEqual(['She whispered… and then stopped.', 'Silence.']);
  });

  it('splits after "..." when an uppercase word follows', () => {
    expect(sentences('She whispered... And then stopped.')).toEqual(['She whispered...', 'And then stopped.']);
  });

  it('keeps the single-character ellipsis (U+2026) inside the sentence, as ICU does', () => {
    // ICU does not treat U+2026 as a sentence terminator; splitting there would be a guess.
    expect(sentences('It ended… Nothing more.')).toEqual(['It ended… Nothing more.']);
    expect(sentences('It ended… nothing more. Done.')).toEqual(['It ended… nothing more.', 'Done.']);
  });

  it('attaches a closing quote or bracket at the start of the next segment to the previous sentence', () => {
    expect(sentences('He said. ” Then.')).toEqual(['He said. ” Then.']);
    expect(sentences('He said. ) Then.')).toEqual(['He said. ) Then.']);
    expect(sentences('He said. ] Then.')).toEqual(['He said. ] Then.']);
    expect(sentences('He said. » Then.')).toEqual(['He said. » Then.']);
    expect(sentences('He said. " Then.')).toEqual(['He said. " Then.']);
    expect(sentences("He said. ' Then.")).toEqual(["He said. ' Then."]);
    expect(sentences('He said. ’ Then.')).toEqual(['He said. ’ Then.']);
  });

  it('does not attach an opening quote that starts the next sentence', () => {
    expect(sentences("'Hello,' she said. 'Bye.' He left.")).toEqual(["'Hello,' she said.", "'Bye.'", 'He left.']);
    expect(sentences('"Hello," she said. "Bye." He left.')).toEqual(['"Hello," she said.', '"Bye."', 'He left.']);
    expect(sentences('He left. ’Tis the season.')).toEqual(['He left.', '’Tis the season.']);
    expect(sentences('“Go.” “Now.” Then.')).toEqual(['“Go.”', '“Now.”', 'Then.']);
    expect(sentences('(He left.) Then he sat.')).toEqual(['(He left.)', 'Then he sat.']);
  });

  it('attaches an unmatched straight quote to the previous sentence even before a letter', () => {
    // the previous sentence has an unmatched " so the next " closes it
    expect(sentences('He said "stop. "Then he left.')).toEqual(['He said "stop. "Then he left.']);
  });

  it('moves an opening quote that ICU glued to the previous sentence into the next one', () => {
    const t = 'end.”“Start again.';
    expect(sentences(t)).toEqual(['end.”', '“Start again.']);
    const out = checkInvariants(t);
    expect(out[0].tokens.map((k) => `${k.kind}:${k.text}`)).toEqual(['word:end', 'punct:.”']);
    expect(out[1].tokens.map((k) => `${k.kind}:${k.text}`)).toEqual(['punct:“', 'word:Start', 'word:again', 'punct:.']);
  });

  it('handles an abbreviation at the very end of the text', () => {
    expect(sentences('Mr.')).toEqual(['Mr.']);
    expect(sentences('a.m.')).toEqual(['a.m.']);
    expect(sentences('He met Mr. ')).toEqual(['He met Mr.']);
  });

  it('splits at sentence punctuation with no following space', () => {
    expect(sentences('Wait!What?')).toEqual(['Wait!', 'What?']);
  });
});

describe('sentence segmentation: whitespace and odd input', () => {
  it('returns no sentences for an empty string', () => {
    expect(seg.segmentParagraph('')).toEqual([]);
  });

  it('returns no sentences for whitespace-only input', () => {
    expect(seg.segmentParagraph('   ')).toEqual([]);
    expect(seg.segmentParagraph('\t\n  \n')).toEqual([]);
  });

  it('makes a string of only punctuation one sentence with one punct token', () => {
    const t = '...!!!';
    const out = checkInvariants(t);
    expect(sentences(t)).toEqual([t]);
    expect(out[0].tokens).toEqual([{ start: 0, end: 6, text: '...!!!', kind: 'punct' }]);
  });

  it('treats a newline before an uppercase word as a boundary and keeps the offsets exact', () => {
    const t = 'He left.\nShe stayed.';
    const out = checkInvariants(t);
    expect(sentences(t)).toEqual(['He left.', 'She stayed.']);
    expect(out[1].start).toBe(9);
    expect(out.flatMap((s) => s.tokens.map((k) => k.text))).toEqual(['He', 'left', '.', 'She', 'stayed', '.']);
  });

  it('keeps a line wrapped inside a sentence (newline before lowercase) as one sentence', () => {
    const t = 'the quick brown\nfox jumps.';
    expect(sentences(t)).toEqual([t]);
    expect(words(t)).toEqual(['the', 'quick', 'brown', 'fox', 'jumps']);
  });

  it('handles double spaces: offsets are exact and spaces are not tokens', () => {
    const t = 'Double  spaces here.  And more.';
    const out = checkInvariants(t);
    expect(sentences(t)).toEqual(['Double  spaces here.', 'And more.']);
    expect(out[0]).toMatchObject({ start: 0, end: 20 });
    expect(out[1]).toMatchObject({ start: 22, end: 31 });
    expect(out[0].tokens.map((k) => [k.start, k.end])).toEqual([[0, 6], [8, 14], [15, 19], [19, 20]]);
  });

  it('trims leading and trailing whitespace from sentence boundaries', () => {
    const t = '  Leading spaces. Trailing.  ';
    const out = checkInvariants(t);
    expect(sentences(t)).toEqual(['Leading spaces.', 'Trailing.']);
    expect(out[0].start).toBe(2);
    expect(out[1].end).toBe(27);
  });

  it('handles CJK punctuation and words', () => {
    const t = '你好。再见！Hello world.';
    const out = checkInvariants(t);
    expect(sentences(t)).toEqual(['你好。', '再见！', 'Hello world.']);
    expect(out[0].tokens.map((k) => `${k.kind}:${k.text}`)).toEqual(['word:你好', 'punct:。']);
    expect(out[1].tokens.map((k) => `${k.kind}:${k.text}`)).toEqual(['word:再见', 'punct:！']);
  });

  it('ignores zero-width and directional format characters', () => {
    const t = '\u200BHello\u200B world.\u200E';
    const out = checkInvariants(t);
    expect(sentences(t)).toEqual(['Hello\u200B world.']);
    expect(out[0].tokens.map((k) => k.text)).toEqual(['Hello', 'world', '.']);
  });

  it('treats non-breaking spaces as whitespace', () => {
    const t = 'Mr.\u00A0Darcy left.\u00A0He did.';
    expect(words(t)).toEqual(['Mr', 'Darcy', 'left', 'He', 'did']);
    checkInvariants(t);
  });

  it('keeps emoji and symbols as punct tokens', () => {
    const t = 'Hello 😀 world → done 100%';
    const out = checkInvariants(t);
    expect(out[0].tokens.map((k) => `${k.kind}:${k.text}`)).toEqual(['word:Hello', 'punct:😀', 'word:world', 'punct:→', 'word:done', 'number:100', 'punct:%']);
  });
});

describe('tokens', () => {
  it('joins word + single hyphen + word into one token, including chains', () => {
    const t = 'A well-known re-entry and a state-of-the-art device.';
    expect(words(t)).toEqual(['A', 'well-known', 're-entry', 'and', 'a', 'state-of-the-art', 'device']);
    expect(tokenList(t).filter((k) => k.startsWith('punct'))).toEqual(['punct:.']);
    checkInvariants(t);
  });

  it('joins across the non-breaking hyphen (U+2011) and the hyphen (U+2010)', () => {
    expect(words('x\u2011y and a\u2010b')).toEqual(['x\u2011y', 'and', 'a\u2010b']);
  });

  it('does not join across spaces, double hyphens, dashes or mixed hyphen runs', () => {
    expect(tokenList('a - b')).toEqual(['word:a', 'punct:-', 'word:b']);
    expect(tokenList('a--b')).toEqual(['word:a', 'punct:--', 'word:b']);
    expect(tokenList('a—b')).toEqual(['word:a', 'punct:—', 'word:b']);
    expect(tokenList('a–b')).toEqual(['word:a', 'punct:–', 'word:b']);
    expect(tokenList('a-\u2011b')).toEqual(['word:a', 'punct:-\u2011', 'word:b']);
    expect(tokenList('-a')).toEqual(['punct:-', 'word:a']);
    expect(tokenList('a-')).toEqual(['word:a', 'punct:-']);
  });

  it('classifies joined number-word compounds as words and number-number as numbers', () => {
    expect(tokenList('a 5-year-old and pages 10-12')).toEqual(['word:a', 'word:5-year-old', 'word:and', 'word:pages', 'number:10-12']);
  });

  it('keeps internal apostrophes (curly and straight)', () => {
    expect(words('don’t touch Darcy’s hat, it isn\'t Smith\'s')).toEqual(['don’t', 'touch', 'Darcy’s', 'hat', 'it', "isn't", "Smith's"]);
  });

  it('classifies numbers with decimal points and thousands separators', () => {
    expect(tokenList('3 or 3.50 or 1,000 or 3,000.5 but 5th and 10am')).toEqual([
      'number:3', 'word:or', 'number:3.50', 'word:or', 'number:1,000', 'word:or', 'number:3,000.5', 'word:but', 'word:5th', 'word:and', 'word:10am',
    ]);
  });

  it('collapses runs of punctuation into one token', () => {
    expect(tokenList('“Really?!” she said...')).toEqual(['punct:“', 'word:Really', 'punct:?!”', 'word:she', 'word:said', 'punct:...']);
    expect(tokenList('(yes) [no] «hi»')).toEqual(['punct:(', 'word:yes', 'punct:)', 'punct:[', 'word:no', 'punct:]', 'punct:«', 'word:hi', 'punct:»']);
  });

  it('does not collapse punctuation separated by whitespace', () => {
    expect(tokenList('end. — start')).toEqual(['word:end', 'punct:.', 'punct:—', 'word:start']);
  });

  it('keeps dotted abbreviations as the segmenter produces them', () => {
    expect(tokenList('U.S.A. and e.g. this')).toEqual(['word:U.S.A', 'punct:.', 'word:and', 'word:e.g', 'punct:.', 'word:this']);
  });

  it('keeps every token inside its sentence', () => {
    const t = 'Mr. Darcy said, “No.” She left (quickly)! Then... silence?! Yes.';
    const out = checkInvariants(t);
    expect(out.length).toBe(4);
    for (const s of out) expect(s.tokens.length).toBeGreaterThan(0);
  });
});

describe('soft hyphens', () => {
  it('segments the intact word but keeps original offsets and the soft hyphen inside the token', () => {
    const t = 'ab\u00ADsolutely fine. Next.';
    const out = checkInvariants(t);
    expect(sentences(t)).toEqual(['ab\u00ADsolutely fine.', 'Next.']);
    expect(out[0].tokens[0]).toEqual({ start: 0, end: 11, text: 'ab\u00ADsolutely', kind: 'word' });
    expect(out[0].tokens.map((k) => k.text)).toEqual(['ab\u00ADsolutely', 'fine', '.']);
    expect(out[1]).toMatchObject({ start: 18, end: 23 });
  });

  it('never starts or ends a token or sentence with a soft hyphen', () => {
    const t = '\u00ADThe end.\u00AD Next\u00AD one.\u00AD';
    const out = checkInvariants(t);
    // a sentence is a slice of the original text, so an internal soft hyphen stays in it
    expect(sentences(t)).toEqual(['The end.', 'Next\u00AD one.']);
    const text = (x: Sentence): string => t.slice(x.start, x.end);
    for (const x of out) {
      expect(text(x).startsWith('\u00AD')).toBe(false);
      expect(text(x).endsWith('\u00AD')).toBe(false);
      for (const k of x.tokens) {
        expect(k.text.startsWith('\u00AD')).toBe(false);
        expect(k.text.endsWith('\u00AD')).toBe(false);
      }
    }
    expect(out.flatMap((s) => s.tokens.map((k) => k.text))).toEqual(['The', 'end', '.', 'Next', 'one', '.']);
  });

  it('does not split a soft-hyphenated word that straddles a would-be boundary', () => {
    // without stripping, ICU would see "Mr" + soft hyphen and could misclassify
    const t = 'Mr. Dar\u00ADcy ar\u00ADrived. He left.';
    expect(sentences(t)).toEqual(['Mr. Dar\u00ADcy ar\u00ADrived.', 'He left.']);
    expect(words(t)).toEqual(['Mr', 'Dar\u00ADcy', 'ar\u00ADrived', 'He', 'left']);
  });

  it('handles a string that is only soft hyphens', () => {
    expect(seg.segmentParagraph('\u00AD\u00AD')).toEqual([]);
    expect(seg.tokenize('\u00AD')).toEqual([]);
  });
});

describe('tokenize()', () => {
  it('returns [] for an empty string and whitespace', () => {
    expect(seg.tokenize('')).toEqual([]);
    expect(seg.tokenize('   ')).toEqual([]);
  });

  it('tokenises arbitrary text with the same conventions as segmentParagraph', () => {
    const t = 'ab\u00ADsolutely well-known, "Hi!" don’t 3.50';
    const out = seg.tokenize(t);
    checkTokens(t, out);
    expect(out.map((k) => `${k.kind}:${k.text}@${k.start}-${k.end}`)).toEqual([
      'word:ab\u00ADsolutely@0-11', 'word:well-known@12-22', 'punct:,@22-23', 'punct:"@24-25', 'word:Hi@25-27', 'punct:!"@27-29', 'word:don’t@30-35', 'number:3.50@36-40',
    ]);
  });

  it('spans sentence boundaries without splitting punctuation runs at them', () => {
    const t = 'One. Two.';
    expect(seg.tokenize(t).map((k) => k.text)).toEqual(['One', '.', 'Two', '.']);
  });

  it('agrees with segmentParagraph on a multi-sentence paragraph', () => {
    const t = 'Mr. Darcy said, “No.” She left (quickly)! Then... silence?! Yes.';
    const fromSentences = seg.segmentParagraph(t).flatMap((s) => s.tokens);
    expect(seg.tokenize(t)).toEqual(fromSentences);
  });
});

describe('performance', () => {
  function makeParagraph(wordCount: number): string {
    const vocab = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'Mr.', 'Darcy', 'well-known', 'don’t', '3.50', 'etc.', 'Dr.', 'Smith', '“quoted”', 'U.S.', 'J.', 'K.'];
    const out: string[] = [];
    for (let i = 0; i < wordCount; i++) {
      let w = vocab[i % vocab.length];
      if (i % 13 === 12) w += '.';
      out.push(w);
    }
    return out.join(' ');
  }

  it('segments a 5,000-word paragraph in well under 500 ms', () => {
    const big = makeParagraph(5000);
    expect(big.split(' ').length).toBe(5000);
    seg.segmentParagraph(makeParagraph(500)); // warm up ICU and the JIT
    const t0 = performance.now();
    const out = seg.segmentParagraph(big);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(500);
    expect(out.length).toBeGreaterThan(100);
    const tokens = out.reduce((n, s) => n + s.tokens.length, 0);
    expect(tokens).toBeGreaterThan(5000);
    checkInvariants(big, out);
  });

  it('tokenizes a 5,000-word paragraph in well under 500 ms', () => {
    const big = makeParagraph(5000);
    const t0 = performance.now();
    const out = seg.tokenize(big);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out.length).toBeGreaterThan(5000);
    checkTokens(big, out);
  });

  it('is linear: the merge pass does not rescan the whole sentence at every boundary', () => {
    // Long run of initials forces ~2,500 merges into one growing sentence.
    const t = Array.from({ length: 2500 }, () => 'J.').join(' ') + ' Tolkien wrote it. Done.';
    const t0 = performance.now();
    const out = seg.segmentParagraph(t);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out.length).toBe(2);
  });
});
