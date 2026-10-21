import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';

const MAX_BUFFERED = 2 * 1024 * 1024; // slow clients drop entry batches, never topology

export function redisLabel(url) {
  try {
    const u = new URL(url);
    const db = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return `${u.hostname}:${u.port || 6379}${db}`;
  } catch {
    return 'redis';
  }
}

export async function startServer({ bridge, port, host, version }) {
  const config = `<script>window.RIVULET=${JSON.stringify({ ws: true })}</script>`;
  const html = (await readFile(new URL('../public/index.html', import.meta.url), 'utf8'))
    .replace('<!--RIVULET_CONFIG-->', config);

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } else if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, streams: bridge.topology?.streams.length ?? 0 }));
    } else {
      res.writeHead(404).end();
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  const hello = () => ({
    type: 'hello',
    version,
    redis: { label: redisLabel(bridge.opts.url), version: bridge.redisVersion },
    redacted: bridge.opts.redact,
    interval: bridge.opts.interval,
  });
  const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  const broadcast = (msg, droppable = false) => {
    const data = JSON.stringify(msg);
    for (const ws of wss.clients) {
      if (droppable && ws.bufferedAmount > MAX_BUFFERED) continue;
      send(ws, data);
    }
  };

  wss.on('connection', (ws) => {
    send(ws, hello());
    if (bridge.topology) send(ws, bridge.topology);
    ws.on('message', async (data) => {
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      if (m?.type === 'inspect' && typeof m.stream === 'string' && bridge.knows(m.stream)) {
        try {
          send(ws, { type: 'inspect', stream: m.stream, entries: await bridge.inspect(m.stream) });
        } catch (err) {
          send(ws, { type: 'error', error: err.message });
        }
      }
    });
  });

  bridge.on('topology', (m) => broadcast(m));
  bridge.on('entries', (m) => broadcast(m, true));
  bridge.on('status', (m) => broadcast(m));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { server, wss, close: () => new Promise((r) => { wss.close(); server.close(r); }) };
}
