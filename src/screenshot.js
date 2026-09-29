'use strict';
const { desktopCapturer, screen, nativeImage, systemPreferences } = require('electron');
const { layoutDisplays, stitchBitmaps } = require('./layout');

const MAX_EDGE = 1920; // plenty for Claude to read, and fast to capture/paste

// macOS Screen Recording state: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'.
// Without 'granted', macOS silently returns only the wallpaper, so callers must check first.
function screenAccess() {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen');
}

// One picture of the screen(s). all=true joins every monitor side by side (as they are
// arranged on the desk); all=false grabs only the monitor the mouse is on.
// Returns an Electron nativeImage.
async function captureScreen({ all = true } = {}) {
  const displays = all ? screen.getAllDisplays() : [screen.getDisplayNearestPoint(screen.getCursorScreenPoint())];
  const layout = layoutDisplays(displays.map((d) => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor })), MAX_EDGE);
  const thumbnailSize = {
    width: Math.max(...layout.tiles.map((t) => t.w)),
    height: Math.max(...layout.tiles.map((t) => t.h)),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  if (!sources.length) throw new Error('no-screen-source');

  const parts = [];
  layout.tiles.forEach((tile, i) => {
    const src = sources.find((s) => s.display_id === String(tile.id)) ||
      (sources.length === layout.tiles.length ? sources[i] : null) || (layout.tiles.length === 1 ? sources[0] : null);
    if (!src || !src.thumbnail || src.thumbnail.isEmpty()) throw new Error('empty-capture');
    const sized = src.thumbnail.getSize();
    const img = sized.width === tile.w && sized.height === tile.h ? src.thumbnail : src.thumbnail.resize({ width: tile.w, height: tile.h, quality: 'good' });
    if (layout.tiles.length === 1) parts.image = img;
    parts.push({ bitmap: img.toBitmap(), x: tile.x, y: tile.y, w: tile.w, h: tile.h });
  });
  if (parts.image && layout.width === parts[0].w && layout.height === parts[0].h) return parts.image; // single monitor: as-is
  return nativeImage.createFromBitmap(stitchBitmaps(parts, layout.width, layout.height), { width: layout.width, height: layout.height });
}

module.exports = { captureScreen, screenAccess };
