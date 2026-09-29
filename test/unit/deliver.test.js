'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPasteCommand, pasteIntoApp, safeName } = require('../../src/deliver');

test('macOS: skips switching if Claude is already in front, verifies before pasting, restores exact window', () => {
  const c = buildPasteCommand('darwin', 'Claude');
  assert.equal(c.cmd, 'osascript');
  const script = c.args[1];
  assert.match(script, /exists application process "Claude"/);
  assert.match(script, /if prevName is "Claude" then/); // already in front: no switching
  // must confirm Claude is frontmost BEFORE the keystroke
  assert.ok(script.indexOf('if not isFront then') < script.indexOf('keystroke "v" using command down', script.indexOf('if not isFront then')));
  assert.match(script, /return "wrong-window"/);
  assert.match(script, /set frontmost of application process prevName to true/);
  assert.match(script, /perform action "AXRaise"/); // same window, not just same app
  assert.doesNotMatch(script, /delay 0\.[2-9]/); // no long fixed sleeps
});

test('Windows: verifies foreground before pasting, restores with retry and check', () => {
  const c = buildPasteCommand('win32', 'Claude');
  assert.equal(c.cmd, 'powershell.exe');
  const script = Buffer.from(c.args[c.args.length - 1], 'base64').toString('utf16le');
  assert.match(script, /Get-Process -Name 'Claude'/);
  assert.match(script, /wrong-window/);
  assert.ok(script.indexOf("'wrong-window'") < script.indexOf("SendKeys('^v')", script.indexOf("'wrong-window'")));
  assert.match(script, /AttachThreadInput/); // reliable focus hand-back
  assert.match(script, /ShowWindow\(h, 9\)/); // un-minimise if needed
  assert.match(script, /\$n -lt 3/); // retries
  assert.match(script, /ok-nofocus/);
  assert.doesNotMatch(script, /Start-Sleep -Milliseconds (2|3)\d\d/); // no long fixed sleeps
});

test('Linux uses xdotool with the same safety rules', () => {
  const script = buildPasteCommand('linux', 'Claude').args[1];
  assert.match(script, /xdotool key --clearmodifiers ctrl\+v/);
  assert.match(script, /wrong-window/);
  assert.ok(script.indexOf('echo wrong-window') < script.indexOf('xdotool key', script.indexOf('echo wrong-window')));
});

test('unsupported platform', async () => {
  assert.equal(buildPasteCommand('plan9', 'Claude'), null);
  assert.deepEqual(await pasteIntoApp({ platform: 'plan9' }), { ok: false, reason: 'unsupported' });
});

test('app name cannot inject script', () => {
  assert.throws(() => safeName('Claude" & do shell script "rm -rf /'));
  assert.throws(() => buildPasteCommand('darwin', "x'; rm -rf ~; '"));
  assert.equal(safeName('Claude'), 'Claude');
});

const fake = (code, stdout = '', stderr = '') => async () => ({ code, stdout, stderr });

test('result mapping: ok / not running / wrong window / accessibility / other failure', async () => {
  assert.deepEqual(await pasteIntoApp({ platform: 'darwin', run: fake(0, 'ok 312\n') }), { ok: true, awayMs: 312, focusRestored: true });
  assert.deepEqual(await pasteIntoApp({ platform: 'darwin', run: fake(0, 'ok 0\n') }), { ok: true, awayMs: 0, focusRestored: true });
  assert.deepEqual(await pasteIntoApp({ platform: 'win32', run: fake(0, 'ok-nofocus 900\r\n') }), { ok: true, awayMs: 900, focusRestored: false });
  assert.deepEqual(await pasteIntoApp({ platform: 'darwin', run: fake(0, 'not-running\n') }), { ok: false, reason: 'not-running' });
  assert.deepEqual(await pasteIntoApp({ platform: 'darwin', run: fake(0, 'wrong-window\n') }), { ok: false, reason: 'wrong-window' });
  const a = await pasteIntoApp({ platform: 'darwin', run: fake(1, '', 'execution error: Claude Eyes is not allowed to send keystrokes. (1002)') });
  assert.equal(a.reason, 'no-accessibility');
  const f = await pasteIntoApp({ platform: 'win32', run: fake(1, '', 'boom') });
  assert.equal(f.reason, 'failed');
  // a script that printed "ok" but crashed afterwards must NOT count as success
  assert.equal((await pasteIntoApp({ platform: 'linux', run: fake(1, 'ok 5\n') })).ok, false);
});

test('passes the configured app name through', async () => {
  let seen;
  await pasteIntoApp({ platform: 'darwin', appName: 'Claude Beta', run: async (cmd, args) => { seen = args[1]; return { code: 0, stdout: 'ok', stderr: '' }; } });
  assert.match(seen, /"Claude Beta"/);
});
