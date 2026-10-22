/**
 * Single place that wires the pure text modules (written as separate modules) into the main process.
 * Kept separate so the main process compiles while modules are being developed.
 */
import type { Book } from '@core/model';
import type { Segmenter } from '@core/segment';
import type { Importer, ImportContext } from '@core/import/types';
import type { Dictionary } from '@core/dict/types';
import type { DictData } from '@shared/api';

export interface TextModules {
  createSegmenter(): Segmenter;
  importers: { epub: Importer; pdf: Importer; text: Importer };
  textToBook(title: string, text: string, ctx: ImportContext): Promise<Book>;
  createDictionary(data: DictData): Dictionary;
  detectNames(book: Pick<Book, 'chapters'>, dict: Dictionary): string[];
}

let modules: TextModules | null = null;

export async function loadTextModules(): Promise<TextModules> {
  if (modules) return modules;
  const [segment, epub, text, pdf, dict, names] = await Promise.all([
    import('@core/segment'),
    import('@core/import/epub'),
    import('@core/import/text'),
    import('@core/import/pdf'),
    import('@core/dict/dictionary'),
    import('@core/dict/names'),
  ]);
  modules = {
    createSegmenter: segment.createSegmenter,
    importers: { epub: epub.epubImporter, pdf: pdf.pdfImporter, text: text.textImporter },
    textToBook: text.textToBook,
    createDictionary: dict.createDictionary,
    detectNames: names.detectNames,
  };
  return modules;
}
