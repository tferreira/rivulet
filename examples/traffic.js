#!/usr/bin/env node
// Generates realistic Redis Streams traffic to try rivulet against.
// This WRITES to Redis (XADD, XGROUP, XREADGROUP, XACK) — point it at a scratch instance.
//
//   node examples/traffic.js redis://127.0.0.1:6379
//   npx rivulet-redis redis://127.0.0.1:6379
import Redis from 'ioredis';

const url = process.argv[2] || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const prefix = 'demo:';

const STREAMS = [
  { key: 'orders', rate: 6, events: ['order.created', 'order.paid', 'order.shipped'], groups: { billing: [['billing-1', 30], ['billing-2', 30]], fulfillment: [['ship-a', 90], ['ship-b', 90]], analytics: [['etl-0', 260]] } },
  { key: 'payments', rate: 2, events: ['payment.captured', 'payment.declined'], groups: { ledger: [['ledger-1', 80]], 'fraud-check': [['fraud-scan', 300]] } },
  { key: 'user-events', rate: 14, events: ['page_view', 'click', 'search'], groups: { 'search-indexer': [['idx-1', 40], ['idx-2', 40], ['idx-3', 40]] } },
  { key: 'clicks', rate: 150, events: ['click', 'scroll'], groups: { 'realtime-agg': [['agg-1', 1], ['agg-2', 1]] } }, // ~1 ms consumers
  { key: 'audit.log', rate: 0.5, events: ['login', 'deploy'], groups: {} },
];

const producer = new Redis(url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const s of STREAMS) {
  s.key = prefix + s.key;
  for (const g of Object.keys(s.groups)) {
    await producer.xgroup('CREATE', s.key, g, '$', 'MKSTREAM').catch((e) => {
      if (!/BUSYGROUP/.test(e.message)) throw e;
    });
  }
}

async function produce(s) {
  for (;;) {
    await sleep(-Math.log(Math.random()) * (1000 / s.rate));
    const event = s.events[Math.floor(Math.random() * s.events.length)];
    await producer.xadd(s.key, 'MAXLEN', '~', 10000, '*', 'event', event, 'n', String(Math.random()).slice(2, 8), 'at', new Date().toISOString());
  }
}

async function consume(s, group, name, procMs) {
  const r = new Redis(url);
  let hangAt = Date.now() + 20000 + Math.random() * 60000;
  for (;;) {
    // Now and then a consumer "hangs" for a while, leaving its pending entries unacked.
    if (Date.now() > hangAt) {
      await sleep(6000 + Math.random() * 6000);
      hangAt = Date.now() + 30000 + Math.random() * 60000;
    }
    const res = await r.xreadgroup('GROUP', group, name, 'COUNT', 5, 'BLOCK', 2000, 'STREAMS', s.key, '>');
    for (const [, entries] of res || []) {
      for (const [id] of entries) {
        await sleep(procMs * (0.5 + Math.random()));
        await r.xack(s.key, group, id);
      }
    }
  }
}

console.log(`writing demo traffic to ${url} (keys ${prefix}*) — Ctrl-C to stop`);
for (const s of STREAMS) {
  produce(s);
  for (const [g, consumers] of Object.entries(s.groups)) for (const [name, ms] of consumers) consume(s, g, name, ms);
}
