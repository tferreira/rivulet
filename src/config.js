import { readFileSync } from 'node:fs';

// host:port/db without credentials, safe to show in the UI and logs.
export function redisLabel(url) {
  try {
    const u = new URL(url);
    const db = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return `${u.hostname}:${u.port || 6379}${db}`;
  } catch {
    return 'redis';
  }
}

export function slug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'redis';
}

function urlHas(url, part) {
  try {
    return Boolean(new URL(url)[part]);
  } catch {
    return false;
  }
}

function fieldList(v, what) {
  if (v == null) return null;
  if (!Array.isArray(v) || !v.every((f) => typeof f === 'string' && f)) throw new Error(`${what} must be a list of field names`);
  return v; // [] is kept: an empty allowlist shows nothing
}

export function loadConfigFile(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read config ${path}: ${err.message}`);
  }
  if (raw.targets != null && !Array.isArray(raw.targets)) throw new Error(`${path}: "targets" must be an array`);
  return raw;
}

// Targets, in order: config file, --target name=url flags, positional URLs,
// then $REDIS_URL / localhost if nothing else was given.
//
// `defaults` holds the global Bridge options. A default username/password only
// applies to targets whose URL carries none, so one Redis's credentials are
// never sent to another; a target can name its own `passwordEnv`.
export function buildTargets({ file = null, flags = [], positionals = [], env = {}, defaults = {} }) {
  const list = [...(file?.targets ?? [])];
  for (const spec of flags) {
    const i = spec.indexOf('=');
    if (i < 1) throw new Error(`--target expects name=url, got "${spec}"`);
    list.push({ name: spec.slice(0, i).trim(), url: spec.slice(i + 1).trim() });
  }
  for (const url of positionals) list.push({ url });
  if (!list.length) list.push({ url: env.REDIS_URL || 'redis://127.0.0.1:6379' });

  const seen = new Set();
  return list.map((t, i) => {
    if (!t || typeof t.url !== 'string' || !t.url) throw new Error(`target ${i + 1}: missing "url"`);
    const name = t.name || redisLabel(t.url);
    const base = slug(t.id || name);
    let id = base;
    for (let n = 2; seen.has(id); n++) id = `${base}-${n}`;
    seen.add(id);
    const password = t.passwordEnv ? env[t.passwordEnv] : urlHas(t.url, 'password') ? undefined : defaults.password;
    const username = t.username ?? (urlHas(t.url, 'username') ? undefined : defaults.username);
    const showFields = fieldList(t.showFields ?? defaults.showFields, `target ${i + 1} showFields`);
    // Color by an explicit field, else by the first field you chose to show; never guessed.
    const colorBy = t.colorBy ?? defaults.colorBy ?? showFields?.[0] ?? null;
    if (colorBy != null && (typeof colorBy !== 'string' || !colorBy)) throw new Error(`target ${i + 1} colorBy must be a field name`);
    return {
      id,
      name,
      label: redisLabel(t.url),
      opts: {
        ...defaults,
        url: t.url,
        username,
        password,
        tls: t.tls ?? defaults.tls,
        streams: t.streams ?? defaults.streams,
        match: t.match ?? defaults.match,
        maxStreams: t.maxStreams ?? defaults.maxStreams,
        showFields,
        colorBy,
      },
    };
  });
}
