import { test } from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import { guard, isAllowed } from '../src/guard.js';

test('allows the observer commands', () => {
  for (const [name, args] of [
    ['xinfo', ['STREAM', 's']],
    ['XINFO', ['groups', 's']],
    ['xinfo', [Buffer.from('CONSUMERS'), 's', 'g']],
    ['xread', ['BLOCK', '1000', 'STREAMS', 's', '$']],
    ['xrange', ['s', '-', '+']],
    ['xrevrange', ['s', '+', '-', 'COUNT', '5']],
    ['xpending', ['s', 'g']],
    ['scan', ['0']],
    ['time', []],
    ['info', ['server']],
  ]) assert.ok(isAllowed(name, args), `${name} ${args[0] ?? ''}`);
});

test('refuses anything that writes, acks or claims', () => {
  for (const [name, args] of [
    ['xadd', ['s', '*', 'a', '1']],
    ['xack', ['s', 'g', '1-0']],
    ['xreadgroup', ['GROUP', 'g', 'c', 'STREAMS', 's', '>']],
    ['xclaim', ['s', 'g', 'c', '0', '1-0']],
    ['xautoclaim', ['s', 'g', 'c', '0', '0']],
    ['xgroup', ['CREATE', 's', 'g', '$']],
    ['xtrim', ['s', 'MAXLEN', '0']],
    ['xdel', ['s', '1-0']],
    ['xsetid', ['s', '1-0']],
    ['del', ['s']],
    ['flushall', []],
    ['config', ['SET', 'x', 'y']],
    ['eval', ['return 1', '0']],
    ['xinfo', ['HELP']],
    ['xinfo', []],
  ]) assert.equal(isAllowed(name, args), false, `${name} ${args[0] ?? ''}`);
});

test('guarded ioredis client rejects writes before they reach the socket', async () => {
  const r = guard(new Redis({ lazyConnect: true, enableOfflineQueue: false }));
  await assert.rejects(r.xadd('s', '*', 'a', '1'), /read-only: blocked XADD/);
  await assert.rejects(r.call('xack', 's', 'g', '1-0'), /blocked XACK/);
  await assert.rejects(r.xreadgroup('GROUP', 'g', 'c', 'STREAMS', 's', '>'), /blocked XREADGROUP/);
  r.disconnect();
});
