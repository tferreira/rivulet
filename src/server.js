import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { Bridge } from './bridge.js';

export { redisLabel } from './config.js';

const MAX_BUFFERED = 2 * 1024 * 1024; // slow clients drop entry batches, never topology
const RETRY_MS = 5000;

const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));

// One Redis target and the browsers watching it. Its Bridge (and so its Redis
// connections) only exists while someone is watching, plus `linger` ms after
// the last viewer leaves.
class Target {
  constructor({ id, name, label, opts }, { linger, hello }) {
    Object.assign(this, { id, name, label, opts, linger, makeHello: hello });
    this.clients = new Set();
    this.bridge = null;
    this.starting = null;
    this.error = null;
    this.version = null;
  }

  hello() {
    return this.makeHello(this);
  }

  broadcast(msg, droppable = false) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (droppable && ws.bufferedAmount > MAX_BUFFERED) continue;
      send(ws, data);
    }
  }

  ensure() {
    if (this.bridge) return this.starting;
    const b = (this.bridge = new Bridge(this.opts));
    b.on('topology', (m) => this.broadcast(m));
    b.on('entries', (m) => this.broadcast(m, true));
    b.on('status', (m) => this.broadcast(m));
    this.starting = b.start().then(
      () => {
        this.error = null;
        this.version = b.redisVersion;
      },
      (err) => {
        if (this.bridge !== b) return;
        this.bridge = null;
        this.error = err.message;
        this.broadcast({ type: 'status', redis: 'down', error: err.message });
        clearTimeout(this.retry);
        this.retry = setTimeout(() => {
          if (this.clients.size) this.ensure().then(() => this.bridge && this.broadcast(this.hello()));
        }, RETRY_MS);
      },
    );
    return this.starting;
  }

  async attach(ws) {
    this.clients.add(ws);
    clearTimeout(this.idle);
    await this.ensure();
    if (ws.readyState !== ws.OPEN) return;
    send(ws, this.hello());
    if (this.bridge?.topology) send(ws, this.bridge.topology);
    else if (this.error) send(ws, { type: 'status', redis: 'down', error: this.error });
  }

  detach(ws) {
    this.clients.delete(ws);
    if (!this.clients.size) this.idle = setTimeout(() => this.shutdown(), this.linger);
  }

  shutdown() {
    clearTimeout(this.idle);
    clearTimeout(this.retry);
    this.bridge?.stop();
    this.bridge = null;
    this.starting = null;
  }
}

export async function startServer({ targets, port, host, version, redact = false, interval = 500, linger = 60_000 }) {
  const config = `<script>window.RIVULET=${JSON.stringify({ ws: true })}</script>`;
  const html = (await readFile(new URL('../public/index.html', import.meta.url), 'utf8'))
    .replace('<!--RIVULET_CONFIG-->', config);

  const list = targets.map(({ id, name, label }) => ({ id, name, label }));
  const hello = (t) => ({
    type: 'hello',
    version,
    target: t.id,
    targets: list,
    redis: { label: t.label, version: t.version },
    redacted: redact,
    interval,
  });
  const pool = new Map(targets.map((t) => [t.id, new Target(t, { linger, hello })]));
  const first = pool.values().next().value;

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } else if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        targets: [...pool.values()].map((t) => ({
          id: t.id,
          active: Boolean(t.bridge),
          viewers: t.clients.size,
          streams: t.bridge?.topology?.streams.length ?? null,
          error: t.error,
        })),
      }));
    } else {
      res.writeHead(404).end();
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  wss.on('connection', (ws, req) => {
    const id = new URL(req.url, 'http://localhost').searchParams.get('target');
    const target = pool.get(id) || first;
    ws.on('close', () => target.detach(ws));
    ws.on('message', async (data) => {
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      const b = target.bridge;
      if (m?.type === 'inspect' && typeof m.stream === 'string' && b?.knows(m.stream)) {
        try {
          send(ws, { type: 'inspect', stream: m.stream, entries: await b.inspect(m.stream) });
        } catch (err) {
          send(ws, { type: 'error', error: err.message });
        }
      }
    });
    target.attach(ws);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    server,
    wss,
    targets: pool,
    close: () => new Promise((r) => {
      for (const t of pool.values()) t.shutdown();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(r);
    }),
  };
}
