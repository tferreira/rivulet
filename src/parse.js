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

// `showFields` is an allowlist: when set, only those fields leave the bridge and
// every other field is dropped, with or without `redact` (an empty list drops all).
// `redact` alone drops all.
export function parseEntries(raw, { redact = false, showFields = null, maxFields = 12, maxValue = 200 } = {}) {
  const only = showFields ? new Set(showFields) : null;
  return (raw || []).map(([id, flat]) => {
    if (!flat || (redact && !only)) return [id];
    const fields = {};
    let n = 0;
    for (let i = 0; i + 1 < flat.length && n < maxFields; i += 2) {
      if (only && !only.has(String(flat[i]))) continue;
      const v = String(flat[i + 1]);
      fields[flat[i]] = v.length > maxValue ? v.slice(0, maxValue) + '…' : v;
      n++;
    }
    return n ? [id, fields] : [id];
  });
}

export function parseRedisVersion(info) {
  return /redis_version:([^\r\n]+)/.exec(info || '')?.[1] ?? null;
}
