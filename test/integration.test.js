// Runs against a real Redis when REDIS_URL is set (CI provides one); skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import Redis from 'ioredis';
import WebSocket from 'ws';
import { Bridge } from '../src/bridge.js';
import { startServer } from '../src/server.js';

const url = process.env.REDIS_URL;
const key = `rivulet:test:${process.pid}`;

test('bridge observes streams, groups and new entries without writing', { skip: !url && 'REDIS_URL not set' }, async (t) => {
  const writer = new Redis(url);
  t.after(async () => { await writer.del(key); writer.disconnect(); });

  await writer.del(key);
  await writer.xadd(key, '*', 'n', '1');
  await writer.xgroup('CREATE', key, 'g1', '0');
  await writer.xreadgroup('GROUP', 'g1', 'c1', 'COUNT', 1, 'STREAMS', key, '>'); // leaves 1 pending

  const bridge = new Bridge({ url, streams: [key], interval: 100 });
  await bridge.start();
  const srv = await startServer({ bridge, port: 0, host: '127.0.0.1', version: 'test' });
  t.after(async () => { await bridge.stop(); await srv.close(); });

  const [topo] = await once(bridge, 'topology');
  const s = topo.streams.find((x) => x.key === key);
  assert.equal(s.length, 1);
  const g = s.groups[0];
  assert.equal(g.name, 'g1');
  assert.equal(g.pending, 1);
  assert.equal(g.consumers[0].name, 'c1');
  assert.equal(g.consumers[0].pending, 1);
  assert.equal(g.pel.length, 1);

  // The browser side: hello, then topology, then live entries.
  const ws = new WebSocket(`ws://127.0.0.1:${srv.server.address().port}/ws`);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d)));
  await once(ws, 'open');
  const id = await writer.xadd(key, '*', 'n', '2');
  const deadline = Date.now() + 5000;
  while (!msgs.some((m) => m.type === 'entries' && m.entries.some(([eid]) => eid === id)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(msgs[0].type, 'hello');
  assert.ok(msgs.some((m) => m.type === 'entries' && m.entries.some(([eid, f]) => eid === id && f.n === '2')));

  ws.send(JSON.stringify({ type: 'inspect', stream: key }));
  const [reply] = await once(ws, 'message');
  const inspect = JSON.parse(reply);
  assert.equal(inspect.type, 'inspect');
  assert.equal(inspect.entries[0][0], id);
  ws.close();

  // Observing must not have changed anything.
  const summary = await writer.xpending(key, 'g1');
  assert.equal(Number(summary[0]), 1);
  await assert.rejects(bridge.cmd.xadd(key, '*', 'x', '1'), /blocked XADD/);
});

test('discovery finds streams via SCAN TYPE', { skip: !url && 'REDIS_URL not set' }, async (t) => {
  const writer = new Redis(url);
  t.after(async () => { await writer.del(key); writer.disconnect(); });
  await writer.xadd(key, '*', 'n', '1');
  const bridge = new Bridge({ url, match: 'rivulet:test:*' });
  await bridge.start();
  t.after(() => bridge.stop());
  const [topo] = await once(bridge, 'topology');
  assert.ok(topo.streams.some((s) => s.key === key));
});
