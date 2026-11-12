/**
 * Must be the FIRST import of web.ts: it tells bg.ts (bundled into the same file) not to install the whole background
 * of the YouTube window on a web page (no vocabulary file, no online copy, nothing at start), and tts-cache.ts not to
 * keep sounds in the web site's own database.
 */
(globalThis as { __drLightBg?: boolean }).__drLightBg = true;
export {};
