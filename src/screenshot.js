'use strict';
const { desktopCapturer, screen } = require('electron');

const MAX_EDGE = 1920; // plenty for Claude to read, and fast to capture/paste

// Screenshot of the display the mouse cursor is on. Returns an Electron nativeImage.
async function captureScreen() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = Math.round(display.size.width * display.scaleFactor);
  const h = Math.round(display.size.height * display.scaleFactor);
  const k = Math.min(1, MAX_EDGE / Math.max(w, h));
  const thumbnailSize = { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  if (!sources.length) throw new Error('no-screen-source');
  const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!src.thumbnail || src.thumbnail.isEmpty()) throw new Error('empty-capture');
  return src.thumbnail;
}

module.exports = { captureScreen };
