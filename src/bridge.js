'use strict';
// Local link between the app and the Chrome extension. Listens on 127.0.0.1 only and accepts
// ONLY the Claude Eyes extension (checked by its fixed extension ID), never a web page.
const { WebSocketServer } = require('ws');
const { EXT_ID } = require('./ext-id');

const PORTS = [47613, 47614, 47615, 47616, 47617];

class Bridge {
  constructor({ extId = EXT_ID, ports = PORTS, onChange = () => {} } = {}) {
    this.extId = extId;
    this.ports = ports;
    this.onChange = onChange;
    this.client = null;
    this.pending = new Map();
    this.nextId = 1;
    this.wss = null;
    this.port = null;
    this.pinger = null;
  }

  async start() {
    for (const port of this.ports) {
      try {
        await this._listen(port);
        this.port = port;
        break;
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
      }
    }
    if (!this.port) throw new Error('no free port for the Chrome link');
    this.pinger = setInterval(() => this.client && this.client.readyState === 1 && this.client.send('{"type":"ping"}'), 20000);
    this.pinger.unref();
    return this.port;
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port,
        maxPayload: 32 * 1024 * 1024,
        verifyClient: ({ origin }) => origin === `chrome-extension://${this.extId}`,
      });
      wss.once('error', reject);
      wss.once('listening', () => {
        wss.removeListener('error', reject);
        wss.on('error', () => {});
        wss.on('connection', (ws) => this._onClient(ws));
        this.wss = wss;
        resolve();
      });
    });
  }

  _onClient(ws) {
    if (this.client) { try { this.client.close(); } catch (_) {} }
    this.client = ws;
    this.onChange(true);
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch (_) { return; }
      if (m.type === 'result' && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve(m);
      }
    });
    ws.on('close', () => {
      if (this.client === ws) { this.client = null; this.onChange(false); }
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'disconnected' }); this.pending.delete(id); }
    });
    ws.on('error', () => {});
  }

  get connected() {
    return !!this.client && this.client.readyState === 1;
  }

  // -> { ok, where?, method?, error? }
  send({ mime, data, name }, timeoutMs = 5000) {
    if (!this.connected) return Promise.resolve({ ok: false, error: 'not-connected' });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.client.send(JSON.stringify({ type: 'shot', id, mime, data, name }), (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(id); resolve({ ok: false, error: 'send-failed' }); }
      });
    });
  }

  close() {
    clearInterval(this.pinger);
    if (this.client) try { this.client.close(); } catch (_) {}
    if (this.wss) this.wss.close();
  }
}

module.exports = { Bridge, PORTS };
