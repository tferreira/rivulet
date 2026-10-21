// Turn raw RESP2 replies (as returned by ioredis `call`) into plain objects.

export function toObject(flat) {
  const o = {};
  if (!flat) return o;
  for (let i = 0; i + 1 < flat.length; i += 2) o[flat[i]] = flat[i + 1];
  return o;
}

const num = (v) => (v == null ? null : Number(v));

export function idMs(id) {
  const i = id.indexOf('-');
  return Number(i < 0 ? id : id.slice(0, i));
}

export function cmpId(a, b) {
  const [am, as = 0] = a.split('-').map(Number);
  const [bm, bs = 0] = b.split('-').map(Number);
  return am - bm || as - bs;
}

export function parseStreamInfo(raw) {
  const o = toObject(raw);
  return {
    length: Number(o.length),
    lastId: o['last-generated-id'],
    firstId: o['first-entry']?.[0] ?? null,
    entriesAdded: num(o['entries-added']), // Redis >= 7.0
  };
}

export function parseGroups(raw) {
  return (raw || []).map((r) => {
    const o = toObject(r);
    return {
      name: o.name,
      pending: Number(o.pending),
      lastDeliveredId: o['last-delivered-id'],
      entriesRead: num(o['entries-read']), // Redis >= 7.0
      lag: num(o.lag), // Redis >= 7.0, nil when Redis can't tell
    };
  });
}

export function parseConsumers(raw) {
  return (raw || []).map((r) => {
    const o = toObject(r);
    return {
      name: o.name,
      pending: Number(o.pending),
      idle: Number(o.idle),
      inactive: num(o.inactive), // Redis >= 7.2
    };
  });
}

export function parsePendingRange(raw) {
  return (raw || []).map(([id, consumer, idle, deliveries]) => ({
    id,
    consumer,
    idle: Number(idle),
    deliveries: Number(deliveries),
  }));
}

export function parseEntries(raw, { redact = false, maxFields = 12, maxValue = 200 } = {}) {
  return (raw || []).map(([id, flat]) => {
    if (redact || !flat) return [id];
    const fields = {};
    const n = Math.min(flat.length, maxFields * 2);
    for (let i = 0; i + 1 < n; i += 2) {
      const v = String(flat[i + 1]);
      fields[flat[i]] = v.length > maxValue ? v.slice(0, maxValue) + '…' : v;
    }
    return [id, fields];
  });
}

export function parseRedisVersion(info) {
  return /redis_version:([^\r\n]+)/.exec(info || '')?.[1] ?? null;
}
