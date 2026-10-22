#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Bridge } from '../src/bridge.js';
import { buildTargets, loadConfigFile } from '../src/config.js';
import { startServer } from '../src/server.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `rivulet ${pkg.version} — realtime Redis Streams visualizer (read-only)

Usage
  npx ${pkg.name} [redis-url ...] [options]

Options
  -c, --config <file>    JSON config with several targets (see README)
  -t, --target <n=url>   add a named target, repeatable: -t "prod=redis://host:6379/0"
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
      --show-fields <a,b> send only these fields (values included), drop the rest
      --color-by <field> color entries by this field's value (default: first --show-fields)
      --open             open the UI in a browser
  -h, --help
  -v, --version

With several targets the UI shows a picker; a target only connects to Redis
while someone is watching it. redis-url defaults to $REDIS_URL, then
redis://127.0.0.1:6379. Credentials can
also go in the URL (redis://user:pass@host:6379/0), but an env var keeps the
password out of shell history and \`ps\`.
rivulet only issues XINFO, XREAD, XRANGE, XREVRANGE, XPENDING, SCAN, TYPE,
TIME and INFO; anything else is refused before it reaches the socket.`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      target: { type: 'string', short: 't', multiple: true },
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
      'show-fields': { type: 'string' },
      'color-by': { type: 'string' },
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

const env = process.env;
let file = null, targets;
try {
  file = o.config ? loadConfigFile(o.config) : null;
  // precedence: CLI flag > environment > config file > default
  const interval = Number(o.interval || file?.interval || 500);
  targets = buildTargets({
    file,
    flags: o.target ?? [],
    positionals,
    env,
    defaults: {
      username: o.user || env.REDIS_USERNAME || file?.username || undefined,
      password: env[o['password-env'] || file?.passwordEnv || 'REDIS_PASSWORD'] || undefined,
      tls: Boolean(o.tls || file?.tls),
      streams: o.streams?.split(',').map((s) => s.trim()).filter(Boolean) || file?.streams,
      match: o.match || file?.match || '*',
      interval,
      maxStreams: Number(o['max-streams'] || file?.maxStreams || 50),
      redact: Boolean(o.redact || file?.redact),
      showFields: o['show-fields']?.split(',').map((s) => s.trim()).filter(Boolean) || file?.showFields,
      colorBy: o['color-by'] || file?.colorBy,
    },
  });
} catch (err) {
  console.error(`rivulet: ${err.message}`);
  process.exit(2);
}
const port = Number(o.port || env.PORT || file?.port || 7380);
const host = o.host || env.RIVULET_HOST || file?.host || '127.0.0.1';
const { redact, interval } = targets[0].opts;
const shownAnywhere = targets.some((t) => t.opts.showFields);

// Check every target once up front. A single unreachable target is a usage
// error; with several, the others are still worth serving.
const probes = await Promise.all(targets.map((t) => Bridge.probe(t.opts).then((v) => ({ v }), (err) => ({ err }))));
console.log(`rivulet ${pkg.version} · read-only${redact ? ' · redacted' : ''}`);
targets.forEach((t, i) => {
  const { v, err } = probes[i];
  const name = t.name === t.label ? t.label : `${t.name} (${t.label})`;
  const { showFields, colorBy, redact: r } = t.opts;
  let shown = showFields ? ` · fields shown: ${showFields.join(', ') || 'none'}` : '';
  if (colorBy) shown += ` · colored by ${colorBy}`;
  if (colorBy && (showFields ? !showFields.includes(colorBy) : r)) shown += ` (⚠ ${colorBy} is redacted, nothing to color)`;
  if (err) console.error(`  ✗ ${name}: ${err.message}`);
  else console.log(`  ✓ ${name} · Redis ${v ?? '?'}${shown}`);
});
if (targets.length === 1 && probes[0].err) process.exit(1);

const srv = await startServer({ targets, port, host, version: pkg.version, redact, interval });
const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
const link = `http://${shown}:${port}`;
console.log(`→ ${link}`);
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !redact && !shownAnywhere) {
  console.warn('⚠ bound to a non-loopback address: the UI has no auth and shows stream contents (consider --redact).');
}
if (o.open) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [link], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).on('error', () => {}).unref();
}

const shutdown = async () => {
  await srv.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
