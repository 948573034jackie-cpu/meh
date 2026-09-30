'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings, DEFAULTS } = require('../../src/settings');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-')), 'sub', 's.json');

test('defaults: on, paste on, start at login on', () => {
  const s = new Settings(tmp());
  assert.deepEqual(s.data, DEFAULTS);
  assert.equal(s.get('enabled'), true);
  assert.equal(s.get('launchAtLogin'), true);
});

test('changes persist across restarts', () => {
  const f = tmp();
  const a = new Settings(f);
  a.set('enabled', false);
  a.set('sensitivity', 'high');
  const b = new Settings(f);
  assert.equal(b.get('enabled'), false);
  assert.equal(b.get('sensitivity'), 'high');
});

test('corrupt file falls back to defaults', () => {
  const f = tmp();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{not json');
  assert.deepEqual(new Settings(f).data, DEFAULTS);
});

test('wrong-typed values in the file are ignored', () => {
  const f = tmp();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ enabled: 'yes', sensitivity: 5, allScreens: false }));
  const s = new Settings(f);
  assert.equal(s.get('enabled'), true);
  assert.equal(s.get('sensitivity'), 'normal');
  assert.equal(s.get('allScreens'), false);
});

test('unknown keys rejected; unwritable path does not throw', () => {
  const blocker = tmp(); fs.mkdirSync(path.dirname(blocker), { recursive: true }); fs.writeFileSync(blocker, 'x');
  const s = new Settings(path.join(blocker, 'child', 's.json')); // parent is a file => cannot write
  assert.throws(() => s.set('bogus', 1));
  assert.doesNotThrow(() => s.set('enabled', false));
});

test('picture goes to Chrome by default', () => {
  assert.equal(new Settings(tmp()).get('target'), 'chrome');
});
