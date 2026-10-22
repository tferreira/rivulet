import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import Redis from 'ioredis';
import { guard } from './guard.js';
import {
  idMs,
  parseConsumers,
  parseEntries,
  parseGroups,
  parsePendingRange,
  parseRedisVersion,
  parseStreamInfo,
} from './parse.js';

const DEFAULTS = {
  url: 'redis://127.0.0.1:6379',
  username: undefined, // ACL user; also accepted inside the URL
  password: undefined,
  tls: false, // or use a rediss:// URL
  streams: null, // explicit list skips SCAN discovery
  match: '*',
  interval: 500, // topology poll, ms
  discoverEvery: 15000,
  maxStreams: 50,
  count: 500, // max entries per stream per XREAD
  pelSample: 20,
  redact: false,
  showFields: null, // allowlist of field names sent to browsers; all others dropped
};

// Observes Redis Streams and emits JSON-ready messages:
//   'topology' { type, time, streams: [...] }
//   'entries'  { type, stream, entries: [[id, fields?], ...] }
//   'status'   { type, redis: 'up' | 'down', error? }
export class Bridge extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.keys = this.opts.streams?.length ? [...this.opts.streams] : [];
    this.cursors = new Map(); // stream key -> last id seen by the tail loop
    this.topology = null;
    this.redisVersion = null;
    this.stopped = false;
    this.lastDiscover = 0;
  }

  async start() {
    await this.connect();
    this.pollLoop();
    this.tailLoop();
  }

  // One-off connectivity check: connect, read the version, disconnect.
  static async probe(opts) {
    const b = new Bridge(opts);
    try {
      await b.connect({ tail: false });
      return b.redisVersion;
    } finally {
      b.stop();
    }
  }

  async connect({ tail = true } = {}) {
    const { username, password, tls } = this.opts;
    const base = {
      ...(username && { username }),
      ...(password && { password }),
      ...(tls && { tls: {} }),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: (n) => Math.min(n * 250, 5000),
    };
    this.cmd = guard(new Redis(this.opts.url, base));
    // XREAD BLOCK parks its connection, so tailing gets its own.
    if (tail) this.tail = guard(new Redis(this.opts.url, { ...base, maxRetriesPerRequest: null }));
    for (const c of [this.cmd, this.tail].filter(Boolean)) c.on('error', (err) => { this.lastError = err; }); // surfaced via status
    this.cmd.on('ready', () => this.emit('status', { type: 'status', redis: 'up' }));
    this.cmd.on('close', () => !this.stopped && this.emit('status', { type: 'status', redis: 'down' }));

    try {
      await Promise.all([this.cmd.connect(), this.tail?.connect()]);
    } catch (err) {
      this.stop();
      throw this.lastError || err; // e.g. WRONGPASS rather than "Connection is closed"
    }
    this.redisVersion = parseRedisVersion(await this.cmd.call('info', 'server'));
  }

  async stop() {
    this.stopped = true;
    this.cmd?.disconnect();
    this.tail?.disconnect();
  }

  knows(key) {
    return this.cursors.has(key);
  }

  async inspect(key, count = 30) {
    const raw = await this.cmd.call('xrevrange', key, '+', '-', 'COUNT', count);
    return parseEntries(raw, this.opts);
  }

  async discover() {
    if (this.opts.streams?.length) return;
    const found = new Set();
    let cursor = '0';
    let rounds = 0;
    let typed = true;
    do {
      let reply;
      try {
        reply = typed
          ? await this.cmd.call('scan', cursor, 'MATCH', this.opts.match, 'COUNT', 1000, 'TYPE', 'stream')
          : await this.cmd.call('scan', cursor, 'MATCH', this.opts.match, 'COUNT', 1000);
      } catch (err) {
        if (!typed || !/syntax|TYPE/i.test(err.message)) throw err;
        typed = false; // Redis < 6.0: no SCAN TYPE, check each key instead
        cursor = '0';
        continue;
      }
      cursor = reply[0];
      for (const k of reply[1]) {
        if (typed || (await this.cmd.call('type', k)) === 'stream') found.add(k);
      }
    } while (cursor !== '0' && ++rounds < 500 && found.size < this.opts.maxStreams);
    this.keys = [...found].sort().slice(0, this.opts.maxStreams);
  }

  async describe(key) {
    let info;
    try {
      info = parseStreamInfo(await this.cmd.call('xinfo', 'stream', key));
    } catch (err) {
      if (/no such key|WRONGTYPE/i.test(err.message)) return null;
      throw err;
    }
    if (!this.cursors.has(key)) this.cursors.set(key, info.lastId);

    const groups = parseGroups(await this.cmd.call('xinfo', 'groups', key));
    await Promise.all(
      groups.map(async (g) => {
        g.consumers = parseConsumers(await this.cmd.call('xinfo', 'consumers', key, g.name));
        g.pel = g.pending > 0
          ? parsePendingRange(await this.cmd.call('xpending', key, g.name, '-', '+', this.opts.pelSample))
          : [];
      }),
    );
    return { key, ...info, groups };
  }

  async snapshot() {
    const now = Date.now();
    if (now - this.lastDiscover > this.opts.discoverEvery) {
      this.lastDiscover = now;
      await this.discover();
    }
    const [sec, usec] = await this.cmd.call('time');
    const streams = (await Promise.all(this.keys.map((k) => this.describe(k)))).filter(Boolean);
    const live = new Set(streams.map((s) => s.key));
    for (const k of this.cursors.keys()) if (!live.has(k)) this.cursors.delete(k);
    this.topology = {
      type: 'topology',
      time: Number(sec) * 1000 + Math.floor(Number(usec) / 1000),
      streams,
    };
    this.emit('topology', this.topology);
  }

  async pollLoop() {
    while (!this.stopped) {
      const t0 = Date.now();
      try {
        await this.snapshot();
      } catch (err) {
        if (!this.stopped) this.emit('status', { type: 'status', redis: 'down', error: err.message });
      }
      await sleep(Math.max(50, this.opts.interval - (Date.now() - t0)));
    }
  }

  async tailLoop() {
    while (!this.stopped) {
      const keys = [...this.cursors.keys()];
      if (!keys.length) {
        await sleep(300);
        continue;
      }
      let res;
      try {
        res = await this.tail.call(
          'xread', 'COUNT', this.opts.count, 'BLOCK', 1000,
          'STREAMS', ...keys, ...keys.map((k) => this.cursors.get(k)),
        );
      } catch (err) {
        if (!this.stopped) await sleep(1000);
        continue;
      }
      for (const [key, raw] of res || []) {
        if (!this.cursors.has(key) || !raw.length) continue;
        const entries = parseEntries(raw, this.opts);
        const lastId = entries[entries.length - 1][0];
        this.cursors.set(key, lastId);
        const msg = { type: 'entries', stream: key, entries };
        // Too far behind a firehose: jump to the head rather than replay history.
        const head = this.topology?.streams.find((s) => s.key === key)?.lastId;
        if (raw.length >= this.opts.count && head && idMs(head) - idMs(lastId) > 3000) {
          this.cursors.set(key, head);
          msg.skipped = true;
        }
        this.emit('entries', msg);
      }
    }
  }
}
