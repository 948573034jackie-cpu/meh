/** The two node:path helpers the PDF importer uses, for the browser bundle (file names only, POSIX style). */
export function extname(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i) : '';
}
export function basename(p: string, ext?: string): string {
  const base = String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return ext && base.endsWith(ext) && base !== ext ? base.slice(0, -ext.length) : base;
}
const path = { extname, basename, sep: '/' };
export default path;
