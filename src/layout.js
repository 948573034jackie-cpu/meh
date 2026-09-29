'use strict';
// Pure helpers (no Electron) for capturing several monitors into ONE picture.

// displays: [{ id, bounds:{x,y,width,height} (in points), scaleFactor }]
// -> { width, height, tiles:[{ id, x, y, w, h }] } in output pixels, long edge <= maxEdge.
function layoutDisplays(displays, maxEdge = 1920) {
  if (!displays.length) throw new Error('no displays');
  const minX = Math.min(...displays.map((d) => d.bounds.x));
  const minY = Math.min(...displays.map((d) => d.bounds.y));
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  const dipW = maxX - minX;
  const dipH = maxY - minY;
  const sfMax = Math.max(...displays.map((d) => d.scaleFactor || 1));
  const k = Math.min(sfMax, maxEdge / Math.max(dipW, dipH)); // never bigger than native, never bigger than maxEdge
  const width = Math.max(1, Math.round(dipW * k));
  const height = Math.max(1, Math.round(dipH * k));
  const tiles = displays.map((d) => {
    const x = Math.round((d.bounds.x - minX) * k);
    const y = Math.round((d.bounds.y - minY) * k);
    return {
      id: d.id, x, y,
      w: Math.max(1, Math.min(Math.round(d.bounds.width * k), width - x)),
      h: Math.max(1, Math.min(Math.round(d.bounds.height * k), height - y)),
    };
  });
  return { width, height, tiles };
}

// parts: [{ bitmap: Buffer (BGRA, w*h*4 bytes), x, y, w, h }] -> BGRA Buffer of width*height.
// Gaps between non-rectangular monitor arrangements are opaque black.
function stitchBitmaps(parts, width, height) {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  for (const p of parts) {
    if (p.bitmap.length !== p.w * p.h * 4) throw new Error('bitmap size mismatch');
    const rows = Math.min(p.h, height - p.y);
    const cols = Math.min(p.w, width - p.x);
    for (let r = 0; r < rows; r++) {
      const src = r * p.w * 4;
      p.bitmap.copy(out, ((p.y + r) * width + p.x) * 4, src, src + cols * 4);
    }
  }
  return out;
}

// macOS only hides other apps' windows when Screen Recording is not 'granted'.
// Other systems have no such switch.
function screenGranted(platform, status) {
  return platform !== 'darwin' || status === 'granted';
}

module.exports = { layoutDisplays, stitchBitmaps, screenGranted };
