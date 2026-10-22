import type { Book } from '@core/model';
import type { Segmenter } from '@core/segment';

/**
 * Importers turn a file (or pasted text) into a Book. They run in the Electron main process (Node),
 * so they may use Node APIs and npm packages that work without a DOM (jszip, htmlparser2, pdfjs-dist legacy build).
 * Every importer must: produce plain-text paragraphs (no HTML), keep headings as their own paragraphs,
 * join hyphenated line breaks, drop running headers/footers/page numbers where detectable,
 * segment every paragraph with the given Segmenter, and compute Book.stats and Book.names (see names.ts).
 */
export interface ImportContext {
  segmenter: Segmenter;
  /** sha256 hex of the source bytes/text; the importer must copy it to Book.id */
  id: string;
  sourcePath?: string;
}

export interface Importer {
  kind: 'epub' | 'pdf' | 'text';
  importBytes(bytes: Uint8Array, ctx: ImportContext): Promise<Book>;
}
