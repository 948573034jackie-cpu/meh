declare module 'unbzip2-stream' {
  import type { Duplex } from 'node:stream';
  /** Streaming pure-JS bzip2 decompressor (through stream). */
  function unbzip2Stream(): Duplex;
  export = unbzip2Stream;
}
