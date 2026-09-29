'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPasteCommand, pasteIntoApp, safeName } = require('../../src/deliver');

test('macOS uses osascript, pastes with Cmd+V, and returns to the previous app', () => {
  const c = buildPasteCommand('darwin', 'Claude');
  assert.equal(c.cmd, 'osascript');
  const script = c.args[1];
  assert.match(script, /exists application process "Claude"/);
  assert.match(script, /keystroke "v" using command down/);
  assert.match(script, /set frontmost of application process prevName to true/);
});

test('Windows uses PowerShell with an encoded script, Ctrl+V, and restores focus', () => {
  const c = buildPasteCommand('win32', 'Claude');
  assert.equal(c.cmd, 'powershell.exe');
  const encoded = c.args[c.args.length - 1];
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(script, /Get-Process -Name 'Claude'/);
  assert.match(script, /SendKeys\('\^v'\)/);
  assert.match(script, /SetForegroundWindow\(\$prev\)/);
});

test('Linux uses xdotool', () => {
  assert.match(buildPasteCommand('linux', 'Claude').args[1], /xdotool key --clearmodifiers ctrl\+v/);
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

test('result mapping: ok / not running / accessibility / other failure', async () => {
  assert.deepEqual(await pasteIntoApp({ platform: 'darwin', run: fake(0, 'ok\n') }), { ok: true });
  assert.deepEqual(await pasteIntoApp({ platform: 'darwin', run: fake(0, 'not-running\n') }), { ok: false, reason: 'not-running' });
  const a = await pasteIntoApp({ platform: 'darwin', run: fake(1, '', 'execution error: Claude Eyes is not allowed to send keystrokes. (1002)') });
  assert.equal(a.reason, 'no-accessibility');
  const f = await pasteIntoApp({ platform: 'win32', run: fake(1, '', 'boom') });
  assert.equal(f.reason, 'failed');
});

test('passes the configured app name through', async () => {
  let seen;
  await pasteIntoApp({ platform: 'darwin', appName: 'Claude Beta', run: async (cmd, args) => { seen = args[1]; return { code: 0, stdout: 'ok', stderr: '' }; } });
  assert.match(seen, /"Claude Beta"/);
});
