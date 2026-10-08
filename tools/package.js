// Builds dist/dj-wave-looper.zip with only the files Chrome needs
// (for the Chrome Web Store, or to share). Run: npm run zip
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const files = ['manifest.json',
  ...fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'src', 'vendor')).map((f) => `src/vendor/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'icons')).map((f) => `icons/${f}`)];

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const local = [];
const central = [];
let offset = 0;
for (const name of files) {
  const data = fs.readFileSync(path.join(ROOT, name));
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(name);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(8, 8);
  h.writeUInt32LE(crc32(data), 14);
  h.writeUInt32LE(comp.length, 18);
  h.writeUInt32LE(data.length, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  local.push(h, nameBuf, comp);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0);
  c.writeUInt16LE(20, 4);
  c.writeUInt16LE(20, 6);
  c.writeUInt16LE(8, 10);
  c.writeUInt32LE(crc32(data), 16);
  c.writeUInt32LE(comp.length, 20);
  c.writeUInt32LE(data.length, 24);
  c.writeUInt16LE(nameBuf.length, 28);
  c.writeUInt32LE(offset, 42);
  central.push(c, nameBuf);
  offset += 30 + nameBuf.length + comp.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12);
end.writeUInt32LE(offset, 16);
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', 'dj-wave-looper.zip');
fs.writeFileSync(out, Buffer.concat([...local, cd, end]));
console.log(`wrote ${out} (${files.length} files)`);
