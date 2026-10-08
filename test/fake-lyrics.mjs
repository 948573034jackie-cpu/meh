// A stand-in for the LRCLIB lyrics API used by the tests (made-up lines, so no
// real lyrics are stored here). Lines are 2 s apart: "Line 7 (0:12)" at 12 s.
export function lyricsFor(track, artist, duration = 30, id = 1) {
  const lines = [];
  // The video "Song ACAPELLA" is searched as plain "Song" (the word acapella is
  // dropped); in the original recording the singing starts 3 s later.
  const shift = track === 'Song' ? 3 : 0;
  for (let t = shift, i = 1; t < duration; t += 2, i++) {
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(t % 60).padStart(2, '0');
    lines.push(`[${mm}:${ss}.00] Line ${i} (${Math.floor(t / 60)}:${ss})`);
  }
  return {
    id, trackName: track, artistName: artist, albumName: 'Test Album', duration, instrumental: false,
    plainLyrics: lines.map((l) => l.replace(/^\[[^\]]+\]\s*/, '')).join('\n'),
    syncedLyrics: lines.join('\n'),
  };
}

// Installs the fake API on a Playwright context; returns the list of requests seen.
export async function installFakeLyrics(ctx) {
  const seen = [];
  await ctx.route('https://lrclib.net/**', (route) => {
    const u = new URL(route.request().url());
    const p = Object.fromEntries(u.searchParams);
    seen.push(p);
    let body = [];
    if (p.track_name && p.artist_name === 'Test Artist') {
      body = [lyricsFor(p.track_name, 'Test Artist', 30, 1), lyricsFor(p.track_name + ' (Live)', 'Test Artist', 200, 2)];
    } else if (p.q) {
      body = [lyricsFor(p.q.replace(/^Test Artist\s*/, ''), 'Someone', 30, 3)];
    }
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  return seen;
}
