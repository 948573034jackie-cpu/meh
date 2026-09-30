'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { Bridge } = require('../../src/bridge');
const { EXT_ID } = require('../../src/ext-id');

const ORIGIN = `chrome-extension://${EXT_ID}`;
const connect = (port, origin = ORIGIN) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
  ws.on('open', () => resolve(ws));
  ws.on('error', reject);
  ws.on('unexpected-response', () => reject(new Error('refused')));
});

test('not connected -> clear answer, no hang', async () => {
  const b = new Bridge({ ports: [47701] });
  await b.start();
  assert.equal(b.connected, false);
  assert.deepEqual(await b.send({ mime: 'image/jpeg', data: 'AAAA' }), { ok: false, error: 'not-connected' });
  b.close();
});

test('sends a picture and returns the extension\'s answer', async () => {
  const b = new Bridge({ ports: [47702] });
  await b.start();
  const ws = await connect(47702);
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'shot') ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, where: 'claude.ai', method: 'file-input', echo: m.data })); });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.connected, true);
  const r = await b.send({ mime: 'image/jpeg', data: 'QUJD', name: 'a.jpg' });
  assert.equal(r.ok, true); assert.equal(r.where, 'claude.ai'); assert.equal(r.echo, 'QUJD');
  ws.close(); b.close();
});

test('an extension that never answers times out instead of hanging the app', async () => {
  const b = new Bridge({ ports: [47703] });
  await b.start();
  const ws = await connect(47703);
  await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  const r = await b.send({ mime: 'image/jpeg', data: 'AA' }, 300);
  assert.deepEqual(r, { ok: false, error: 'timeout' });
  assert.ok(Date.now() - t0 < 1500);
  ws.close(); b.close();
});

test('extension closes mid-send -> answered "disconnected"', async () => {
  const b = new Bridge({ ports: [47704] });
  await b.start();
  const ws = await connect(47704);
  ws.on('message', () => ws.close());
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await b.send({ mime: 'image/jpeg', data: 'AA' }, 3000)).error, 'disconnected');
  b.close();
});

test('only the Claude Eyes extension may connect (not a website, not another extension, not a bare program)', async () => {
  const b = new Bridge({ ports: [47705] });
  await b.start();
  await assert.rejects(connect(47705, 'https://evil.example'));
  await assert.rejects(connect(47705, 'https://claude.ai'));
  await assert.rejects(connect(47705, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  await assert.rejects(connect(47705, null));
  (await connect(47705)).close();
  b.close();
});

test('port busy -> uses the next one', async () => {
  const a = new Bridge({ ports: [47706, 47707] });
  const c = new Bridge({ ports: [47706, 47707] });
  assert.equal(await a.start(), 47706);
  assert.equal(await c.start(), 47707);
  a.close(); c.close();
});

test('a new extension connection replaces the old one', async () => {
  const b = new Bridge({ ports: [47708] });
  await b.start();
  const first = await connect(47708);
  const second = await connect(47708);
  second.on('message', (raw) => { const m = JSON.parse(raw); second.send(JSON.stringify({ type: 'result', id: m.id, ok: true, where: 'chatgpt.com' })); });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await b.send({ mime: 'image/jpeg', data: 'AA' })).where, 'chatgpt.com');
  first.close(); second.close(); b.close();
});
