'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('the iPad/iPhone app carries the same attach script as the Chrome extension', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', '..', 'extension', 'attach.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', '..', 'ios-eyes', 'ClaudeEyes', 'Resources', 'attach.js'), 'utf8');
  assert.equal(b, a, 'run ios-eyes/sync-scripts.sh');
});

test('the Swift voice detector uses the same numbers as the Mac app detector', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'vad.js'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '..', '..', 'ios-eyes', 'ClaudeEyes', 'Vad.swift'), 'utf8');
  for (const [jsName, swName] of [['onsetMs', 'onsetMs'], ['hangoverMs', 'hangoverMs'], ['warmupMs', 'warmupMs'], ['maxSpeechMs', 'maxSpeechMs'], ['floorInitDb', 'floorInitDb'], ['floorMinDb', 'floorMinDb'], ['floorMaxDb', 'floorMaxDb']]) {
    const j = new RegExp(`${jsName}:\\s*(-?[\\d_]+)`).exec(js)[1].replace(/_/g, '');
    const s = new RegExp(`${swName}\\s*=\\s*(-?[\\d_.]+)`).exec(sw)[1].replace(/_/g, '').replace(/\.0$/, '');
    assert.equal(s, j, `${jsName} differs: JS ${j}, Swift ${s}`);
  }
  for (const [name, m, min] of [['low', 18, -42], ['normal', 12, -48], ['high', 8, -54]]) {
    assert.ok(js.includes(`${name}: { marginDb: ${m}, minDb: ${min} }`), `JS ${name} preset`);
    assert.ok(new RegExp(`case \\.${name}: return ${m}\\b`).test(sw), `Swift ${name} margin ${m}`);
    assert.ok(new RegExp(`case \\.${name}: return ${min}\\b`).test(sw), `Swift ${name} min ${min}`);
  }
});
