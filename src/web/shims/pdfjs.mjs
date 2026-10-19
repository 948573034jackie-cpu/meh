// Stands in for 'pdfjs-dist/legacy/build/pdf.mjs' in the browser bundle (scripts/build-web.mjs aliases it
// here): the same module (the legacy build also runs on older iPadOS Safari), with its worker pointed at the
// copy next to index.html so PDF parsing runs off the main thread. Plain JS so tsc does not try to resolve
// the "?real" specifier, which only the build script understands.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs?real';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.mjs', document.baseURI).href;

export * from 'pdfjs-dist/legacy/build/pdf.mjs?real';
