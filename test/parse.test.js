import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cmpId,
  parseConsumers,
  parseEntries,
  parseGroups,
  parsePendingRange,
  parseRedisVersion,
  parseStreamInfo,
} from '../src/parse.js';

test('XINFO STREAM (Redis 7.2 reply)', () => {
  const raw = [
    'length', 3, 'radix-tree-keys', 1, 'radix-tree-nodes', 2,
    'last-generated-id', '1700000000003-0', 'max-deleted-entry-id', '0-0',
    'entries-added', 3, 'recorded-first-entry-id', '1700000000001-0', 'groups', 1,
    'first-entry', ['1700000000001-0', ['a', '1']], 'last-entry', ['1700000000003-0', ['a', '3']],
  ];
  assert.deepEqual(parseStreamInfo(raw), {
    length: 3, lastId: '1700000000003-0', firstId: '1700000000001-0', entriesAdded: 3,
  });
});

test('XINFO STREAM (Redis 6 reply has no entries-added)', () => {
  const raw = ['length', 0, 'last-generated-id', '0-0', 'groups', 0, 'first-entry', null, 'last-entry', null];
  assert.deepEqual(parseStreamInfo(raw), { length: 0, lastId: '0-0', firstId: null, entriesAdded: null });
});

test('XINFO GROUPS keeps nil lag as null', () => {
  const raw = [
    ['name', 'billing', 'consumers', 2, 'pending', 4, 'last-delivered-id', '1-0', 'entries-read', 10, 'lag', 2],
    ['name', 'old', 'consumers', 0, 'pending', 0, 'last-delivered-id', '0-0', 'entries-read', null, 'lag', null],
  ];
  assert.deepEqual(parseGroups(raw), [
    { name: 'billing', pending: 4, lastDeliveredId: '1-0', entriesRead: 10, lag: 2 },
    { name: 'old', pending: 0, lastDeliveredId: '0-0', entriesRead: null, lag: null },
  ]);
});

test('XINFO CONSUMERS with and without inactive', () => {
  assert.deepEqual(parseConsumers([['name', 'c1', 'pending', 2, 'idle', 830, 'inactive', 830]]), [
    { name: 'c1', pending: 2, idle: 830, inactive: 830 },
  ]);
  assert.equal(parseConsumers([['name', 'c1', 'pending', 0, 'idle', 5]])[0].inactive, null);
});

test('XPENDING range', () => {
  assert.deepEqual(parsePendingRange([['1-0', 'c1', 1200, 3]]), [{ id: '1-0', consumer: 'c1', idle: 1200, deliveries: 3 }]);
});

test('entries: truncation, field cap and redaction', () => {
  const long = 'x'.repeat(250);
  const [[id, f]] = parseEntries([['1-0', ['a', long, 'b', '2']]], { maxFields: 1 });
  assert.equal(id, '1-0');
  assert.deepEqual(Object.keys(f), ['a']);
  assert.equal(f.a.length, 201);
  assert.deepEqual(parseEntries([['1-0', ['a', '1']]], { redact: true }), [['1-0']]);
  assert.deepEqual(parseEntries([['1-0', null]]), [['1-0']]);
});

test('ids and version', () => {
  assert.ok(cmpId('10-0', '9-5') > 0);
  assert.ok(cmpId('10-1', '10-2') < 0);
  assert.equal(cmpId('10-0', '10'), 0);
  assert.equal(parseRedisVersion('# Server\r\nredis_version:7.2.5\r\nredis_git_sha1:0'), '7.2.5');
});
