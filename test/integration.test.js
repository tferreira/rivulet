// Runs against a real Redis when REDIS_URL is set (CI provides one); skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import Redis from 'ioredis';
import WebSocket from 'ws';
import { Bridge } from '../src/bridge.js';
import { buildTargets } from '../src/config.js';
import { startServer } from '../src/server.js';

const url = process.env.REDIS_URL;
const key = `rivulet:test:${process.pid}`;
const skip = !url && 'REDIS_URL not set';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inDb = (db) => { const u = new URL(url); u.pathname = `/${db}`; return u.href; };

function client(port, target) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${target ? `?target=${target}` : ''}`);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d)));
  const until = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = msgs.find(pred);
      if (m) return m;
      await sleep(25);
    }
    throw new Error('timed out waiting for message');
  };
  return { ws, msgs, until };
}

test('bridge observes streams, groups and new entries without writing', { skip }, async (t) => {
  const writer = new Redis(url);
  t.after(async () => { await writer.del(key); writer.disconnect(); });

  await writer.del(key);
  await writer.xadd(key, '*', 'n', '1');
  await writer.xgroup('CREATE', key, 'g1', '0');
  await writer.xreadgroup('GROUP', 'g1', 'c1', 'COUNT', 1, 'STREAMS', key, '>'); // leaves 1 pending

  const bridge = new Bridge({ url, streams: [key], interval: 100 });
  await bridge.start();
  t.after(() => bridge.stop());

  const [topo] = await once(bridge, 'topology');
  const s = topo.streams.find((x) => x.key === key);
  assert.equal(s.length, 1);
  const g = s.groups[0];
  assert.equal(g.name, 'g1');
  assert.equal(g.pending, 1);
  assert.equal(g.consumers[0].name, 'c1');
  assert.equal(g.consumers[0].pending, 1);
  assert.equal(g.pel.length, 1);

  const id = await writer.xadd(key, '*', 'n', '2');
  for (;;) {
    const [m] = await once(bridge, 'entries');
    if (m.entries.some(([eid]) => eid === id)) break;
  }

  // Observing must not have changed anything.
  const summary = await writer.xpending(key, 'g1');
  assert.equal(Number(summary[0]), 1);
  await assert.rejects(bridge.cmd.xadd(key, '*', 'x', '1'), /blocked XADD/);
});

test('server routes each browser to its target and connects lazily', { skip }, async (t) => {
  const w0 = new Redis(inDb(0)), w1 = new Redis(inDb(1));
  t.after(async () => { await w0.del(key); await w1.del(key); w0.disconnect(); w1.disconnect(); });
  await w0.del(key); await w1.del(key);
  await w0.xadd(key, '*', 'db', '0');
  await w1.xadd(key, '*', 'db', '1');

  const targets = buildTargets({
    flags: [`zero=${inDb(0)}`, `one=${inDb(1)}`],
    defaults: { streams: [key], interval: 100 },
  });
  const srv = await startServer({ targets, port: 0, host: '127.0.0.1', version: 'test', linger: 200 });
  t.after(() => srv.close());
  const port = srv.server.address().port;
  const health = async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json();

  // Nobody watching yet: no Redis connections.
  assert.deepEqual((await health()).targets.map((x) => x.active), [false, false]);

  const c = client(port, 'one');
  const hello = await c.until((m) => m.type === 'hello');
  assert.equal(hello.target, 'one');
  assert.deepEqual(hello.targets.map((x) => x.id), ['zero', 'one']);
  assert.match(hello.redis.label, /\/1$/);
  const topo = await c.until((m) => m.type === 'topology');
  assert.equal(topo.streams[0].key, key);
  assert.equal(topo.streams[0].length, 1);
  assert.deepEqual((await health()).targets.map((x) => x.active), [false, true]);

  // Live entries and inspect come from the same target.
  const id = await w1.xadd(key, '*', 'db', '1b');
  await c.until((m) => m.type === 'entries' && m.entries.some(([eid, f]) => eid === id && f.db === '1b'));
  c.ws.send(JSON.stringify({ type: 'inspect', stream: key }));
  const inspect = await c.until((m) => m.type === 'inspect');
  assert.equal(inspect.entries[0][0], id);
  assert.equal(inspect.entries.length, 2);

  // Unknown target falls back to the first one.
  const d = client(port, 'nope');
  assert.equal((await d.until((m) => m.type === 'hello')).target, 'zero');
  d.ws.close();

  // Last viewer leaves: the target disconnects after `linger`.
  c.ws.close();
  await sleep(600);
  assert.deepEqual((await health()).targets.map((x) => x.active), [false, false]);
});

test('redacted targets never send field values', { skip }, async (t) => {
  const w = new Redis(url);
  t.after(async () => { await w.del(key); w.disconnect(); });
  await w.del(key);
  await w.xadd(key, '*', 'secret', 'chat message');
  const targets = buildTargets({ positionals: [url], defaults: { streams: [key], interval: 100, redact: true } });
  const srv = await startServer({ targets, port: 0, host: '127.0.0.1', version: 'test', redact: true });
  t.after(() => srv.close());
  const c = client(srv.server.address().port);
  assert.equal((await c.until((m) => m.type === 'hello')).redacted, true);
  await c.until((m) => m.type === 'topology');
  const id = await w.xadd(key, '*', 'secret', 'another');
  const e = await c.until((m) => m.type === 'entries' && m.entries.some(([eid]) => eid === id));
  assert.deepEqual(e.entries.find(([eid]) => eid === id), [id]);
  c.ws.send(JSON.stringify({ type: 'inspect', stream: key }));
  const inspect = await c.until((m) => m.type === 'inspect');
  assert.ok(inspect.entries.every((x) => x.length === 1));
  assert.ok(!JSON.stringify(c.msgs).includes('chat message'));
  c.ws.close();
});

test('discovery finds streams via SCAN TYPE', { skip }, async (t) => {
  const writer = new Redis(url);
  t.after(async () => { await writer.del(key); writer.disconnect(); });
  await writer.xadd(key, '*', 'n', '1');
  const bridge = new Bridge({ url, match: 'rivulet:test:*' });
  await bridge.start();
  t.after(() => bridge.stop());
  const [topo] = await once(bridge, 'topology');
  assert.ok(topo.streams.some((s) => s.key === key));
});
