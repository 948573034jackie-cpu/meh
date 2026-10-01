importScripts('modes.js');

chrome.commands.onCommand.addListener(async (command) => {
  const { mode, lastMode } = { ...EYECARE_DEFAULTS, ...(await chrome.storage.sync.get(null)) };
  if (command === 'toggle') {
    await chrome.storage.sync.set(mode === 'original' ? { mode: lastMode } : { mode: 'original', lastMode: mode });
  } else if (command === 'next-mode') {
    const i = EYECARE_MODES.findIndex((m) => m.id === mode);
    const next = EYECARE_MODES[(i + 1) % EYECARE_MODES.length].id;
    await chrome.storage.sync.set(next === 'original' ? { mode: next } : { mode: next, lastMode: next });
  }
});
