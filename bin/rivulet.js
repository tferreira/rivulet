#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Bridge } from '../src/bridge.js';
import { redisLabel, startServer } from '../src/server.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `rivulet ${pkg.version} — realtime Redis Streams visualizer (read-only)

Usage
  npx ${pkg.name} [redis-url] [options]

Options
  -p, --port <n>         HTTP port                      (default 7380, env PORT)
  -H, --host <addr>      bind address                   (default 127.0.0.1, env RIVULET_HOST)
  -u, --user <name>      Redis ACL username             (env REDIS_USERNAME)
      --password-env <V> read the password from env var V (default REDIS_PASSWORD)
      --tls              use TLS (same as a rediss:// URL)
  -s, --streams <a,b>    watch only these stream keys   (skips SCAN discovery)
  -m, --match <glob>     SCAN pattern for discovery     (default *)
  -i, --interval <ms>    topology poll interval         (default 500)
      --max-streams <n>  cap on discovered streams      (default 50)
      --redact           never send field values to the browser
      --open             open the UI in a browser
  -h, --help
  -v, --version

redis-url defaults to $REDIS_URL, then redis://127.0.0.1:6379. Credentials can
also go in the URL (redis://user:pass@host:6379/0), but an env var keeps the
password out of shell history and \`ps\`.
rivulet only issues XINFO, XREAD, XRANGE, XREVRANGE, XPENDING, SCAN, TYPE,
TIME and INFO; anything else is refused before it reaches the socket.`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'H' },
      user: { type: 'string', short: 'u' },
      'password-env': { type: 'string' },
      tls: { type: 'boolean' },
      streams: { type: 'string', short: 's' },
      match: { type: 'string', short: 'm' },
      interval: { type: 'string', short: 'i' },
      'max-streams': { type: 'string' },
      redact: { type: 'boolean' },
      open: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
} catch (err) {
  console.error(`${err.message}\n\n${HELP}`);
  process.exit(2);
}
const { values: o, positionals } = args;
if (o.help) (console.log(HELP), process.exit(0));
if (o.version) (console.log(pkg.version), process.exit(0));

const url = positionals[0] || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const port = Number(o.port || process.env.PORT || 7380);
const host = o.host || process.env.RIVULET_HOST || '127.0.0.1';

const bridge = new Bridge({
  url,
  username: o.user || process.env.REDIS_USERNAME || undefined,
  password: process.env[o['password-env'] || 'REDIS_PASSWORD'] || undefined,
  tls: Boolean(o.tls),
  streams: o.streams?.split(',').map((s) => s.trim()).filter(Boolean),
  match: o.match || '*',
  interval: Number(o.interval || 500),
  maxStreams: Number(o['max-streams'] || 50),
  redact: Boolean(o.redact),
});

try {
  await bridge.start();
} catch (err) {
  console.error(`rivulet: cannot connect to ${redisLabel(url)}: ${err.message}`);
  process.exit(1);
}
bridge.on('status', (s) => s.redis === 'down' && console.error(`rivulet: redis down${s.error ? `: ${s.error}` : ''}`));

const srv = await startServer({ bridge, port, host, version: pkg.version });
const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
const link = `http://${shown}:${port}`;
console.log(`rivulet ${pkg.version} · watching ${redisLabel(url)} (Redis ${bridge.redisVersion ?? '?'}) · read-only`);
console.log(`→ ${link}`);
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.warn('⚠ bound to a non-loopback address: the UI has no auth and shows stream contents (consider --redact).');
}
if (o.open) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [link], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).on('error', () => {}).unref();
}

const shutdown = async () => {
  await bridge.stop();
  await srv.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
