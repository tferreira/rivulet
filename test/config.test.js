import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTargets, redisLabel, slug } from '../src/config.js';

test('labels never contain credentials', () => {
  assert.equal(redisLabel('redis://user:secret@10.0.0.5:6380/10'), '10.0.0.5:6380/10');
  assert.equal(redisLabel('redis://localhost'), 'localhost:6379');
});

test('slugs', () => {
  assert.equal(slug('Prod · EU'), 'prod-eu');
  assert.equal(slug('  Staging/2  '), 'staging-2');
  assert.equal(slug('···'), 'redis');
});

test('defaults to $REDIS_URL then localhost', () => {
  assert.equal(buildTargets({})[0].opts.url, 'redis://127.0.0.1:6379');
  assert.equal(buildTargets({ env: { REDIS_URL: 'redis://r:1' } })[0].opts.url, 'redis://r:1');
});

test('file targets, then --target flags, then positionals, with unique ids', () => {
  const t = buildTargets({
    file: { targets: [{ name: 'Prod · EU', url: 'redis://prod:6379/0', match: 'orders:*' }] },
    flags: ['Prod · EU=redis://prod:6379/1'],
    positionals: ['redis://na:6379'],
    defaults: { match: '*', interval: 500, redact: true },
  });
  assert.deepEqual(t.map((x) => [x.id, x.name, x.label]), [
    ['prod-eu', 'Prod · EU', 'prod:6379/0'],
    ['prod-eu-2', 'Prod · EU', 'prod:6379/1'],
    ['na-6379', 'na:6379', 'na:6379'],
  ]);
  assert.equal(t[0].opts.match, 'orders:*');
  assert.equal(t[1].opts.match, '*');
  assert.ok(t.every((x) => x.opts.redact === true && x.opts.interval === 500));
});

test('a default password never overrides one in the URL; passwordEnv is per target', () => {
  const t = buildTargets({
    file: {
      targets: [
        { url: 'redis://a:6379' },
        { url: 'redis://:own@b:6379' },
        { url: 'redis://c:6379', passwordEnv: 'C_PASS' },
      ],
    },
    env: { C_PASS: 'cpw' },
    defaults: { password: 'default-pw', username: 'viewer' },
  });
  assert.equal(t[0].opts.password, 'default-pw');
  assert.equal(t[0].opts.username, 'viewer');
  assert.equal(t[1].opts.password, undefined);
  assert.equal(t[2].opts.password, 'cpw');
});

test('showFields: global default, per-target override, validated', () => {
  const t = buildTargets({
    file: { targets: [{ url: 'redis://a' }, { url: 'redis://b', showFields: ['type', 'source'] }, { url: 'redis://c', showFields: [] }] },
    defaults: { showFields: ['type'] },
  });
  assert.deepEqual(t.map((x) => x.opts.showFields), [['type'], ['type', 'source'], []]);
  assert.throws(() => buildTargets({ file: { targets: [{ url: 'redis://a', showFields: 'type' }] } }), /list of field names/);
  // colorBy: explicit, else the first shown field, else none
  assert.deepEqual(t.map((x) => x.opts.colorBy), ['type', 'type', null]);
  assert.equal(buildTargets({ defaults: { colorBy: 'kind' } })[0].opts.colorBy, 'kind');
  assert.equal(buildTargets({ file: { targets: [{ url: 'redis://a', colorBy: 'kind', showFields: ['type'] }] } })[0].opts.colorBy, 'kind');
});

test('rejects malformed targets', () => {
  assert.throws(() => buildTargets({ flags: ['no-equals-sign'] }), /name=url/);
  assert.throws(() => buildTargets({ file: { targets: [{ name: 'x' }] } }), /missing "url"/);
});
