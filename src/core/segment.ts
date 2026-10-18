import type { Sentence, Token, TokenKind } from './model';

/**
 * Sentence and word segmentation for English prose.
 *
 * Built on Intl.Segmenter (ICU) with a merge pass that repairs the known ICU failures on literary
 * text: title abbreviations ("Mr. Darcy"), initials ("J. K. Rowling"), common Latin abbreviations
 * ("e.g.", "etc."), closing quotes/brackets after sentence punctuation, and ellipses.
 * Word tokens keep internal apostrophes ("don't", "Darcy's") and single hyphens ("well-known").
 *
 * Implemented in src/core/segment.ts by the segmentation module; see test/unit/segment.test.ts.
 */
export interface Segmenter {
  /** Splits one paragraph of plain text into sentences with word/number/punct tokens. Offsets index into `text`. */
  segmentParagraph(text: string): Sentence[];
  /** Tokenises arbitrary text (used for popups and phrase selection). */
  tokenize(text: string): Token[];
}

export type { Sentence, Token, TokenKind };
