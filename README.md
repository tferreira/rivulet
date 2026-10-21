# rivulet

A realtime, animated viewer for **Redis Streams**. Watch entries flow down each
stream, consumer groups pick them up, consumers pulse as they read, pending
entries hang unacked, and lag build up and drain, live.

![rivulet watching five streams: entries flowing down lanes, consumer groups picking them up, a lagging analytics group](docs/demo.gif)

**[Live demo →](https://tferreira.github.io/rivulet/)** (runs on the built-in simulator)

```sh
npx rivulet-redis redis://localhost:6379
# → http://127.0.0.1:7380
```

It is **read-only by construction**, so it is safe to point at production.

## What you see

| On screen | In Redis |
| --- | --- |
| A lane per stream; dots spawn at the left and drift right as they age | `XADD` entries, positioned by the timestamp in their ID |
| A vertical cursor on the lane, one per group | the group's `last-delivered-id`; it waits at "now" when the group is caught up and slides right as it falls behind |
| Red tint between "now" and a lagging cursor | entries not yet delivered to that group |
| Group box with a gauge | `lag` from `XINFO GROUPS` (Redis ≥ 7.0) |
| Sparks travelling from the cursor to a consumer, which pulses | deliveries (`entries-read` / `last-delivered-id` advancing, per-consumer `pending` and `idle`) |
| Shaking dots next to a consumer | its pending entries (PEL); they pop when acked and turn red when the consumer goes idle |
| Ringed, shaking dots on the lane | sampled pending IDs from `XPENDING` |

Hover anything for details; click a stream for its most recent entries.
Three themes, switched with the button in the header (or `t`): **Neon**,
**Clean** and **Cockpit**.

| Neon | Clean | Cockpit |
| --- | --- | --- |
| ![Neon theme](docs/theme-neon.png) | ![Clean theme](docs/theme-clean.png) | ![Cockpit theme](docs/theme-cockpit.png) |

## Install and run

rivulet is a small Node.js process (the *bridge*) that talks to Redis and serves
the UI over HTTP + WebSocket. Browsers can't speak the Redis protocol, which is
why the bridge exists. Run it anywhere that can reach Redis: your laptop, the
Redis host itself, or a box in the same network. It does not need to sit on the
Redis server.

### Node (no Docker)

Requires Node.js 20+.

```sh
# one-off
npx rivulet-redis redis://10.0.0.5:6379

# installed
npm install -g rivulet-redis
rivulet redis://10.0.0.5:6379

# from a checkout
git clone https://github.com/tferreira/rivulet && cd rivulet
npm ci --omit=dev
node bin/rivulet.js redis://10.0.0.5:6379
```

Until the package is on npm, `npm install -g github:tferreira/rivulet` installs
straight from this repo.

To keep it running on a server, use the systemd unit in
[`examples/rivulet.service`](examples/rivulet.service).

### Docker

```sh
docker run --rm -p 7380:7380 ghcr.io/tferreira/rivulet redis://host.docker.internal:6379
```

The image binds `0.0.0.0` inside the container; publish the port only where you
want the UI reachable.

### Seeing it remotely

By default the bridge listens on `127.0.0.1` only. From your machine:

```sh
ssh -L 7380:127.0.0.1:7380 my-server   # then open http://localhost:7380
```

The UI has **no authentication** and shows stream contents. If you bind it to a
public interface (`--host 0.0.0.0`), put it behind a reverse proxy with auth, and
consider `--redact`.

## Options

```
rivulet [redis-url] [options]

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
```

`redis-url` falls back to `$REDIS_URL`, then `redis://127.0.0.1:6379`.

### Passwords, ACL users and TLS

Any of these work:

```sh
rivulet redis://:secret@10.0.0.5:6379                  # requirepass
rivulet redis://rivulet:secret@10.0.0.5:6379/2         # ACL user, db 2
REDIS_PASSWORD=secret rivulet redis://10.0.0.5:6379 -u rivulet   # keeps it out of ps / history
rivulet rediss://10.0.0.5:6380                         # TLS
```

## Safety

rivulet only ever sends these commands:

`XINFO STREAM` · `XINFO GROUPS` · `XINFO CONSUMERS` · `XREAD` · `XRANGE` ·
`XREVRANGE` · `XPENDING` · `SCAN` · `TYPE` · `TIME` · `INFO` (plus `AUTH`,
`SELECT`, `PING` for the connection).

This is enforced in code ([`src/guard.js`](src/guard.js)): every command goes
through an allowlist before it reaches the socket, so it never writes, never
`XACK`s, never `XREADGROUP`s or claims, and never changes a group's position.
Tailing uses plain `XREAD BLOCK`, which leaves consumer groups untouched.

For defence in depth, give it a Redis user that can't do anything else:

```
ACL SETUSER rivulet on >CHANGE_ME ~* resetchannels -@all +xinfo|stream +xinfo|groups +xinfo|consumers +xread +xrange +xrevrange +xpending +scan +type +time +info +ping
```

**Load.** Each poll costs about `2 + 2 × groups` cheap commands per stream
(default every 500 ms), plus one blocking `XREAD` connection. Discovery runs
`SCAN … TYPE stream` every 15 s; on a large keyspace, pass `--streams` or a
narrow `--match` instead.

## Redis versions

Works with Redis 5+. Some details need newer servers:

- `lag` and `entries-read` (group gauge, precise delivery counts): **7.0+**
- consumer `inactive`: **7.2+**
- `SCAN … TYPE`: 6.0+ (older servers fall back to `TYPE` per key)

Redis Cluster isn't supported yet.

## Try it locally

```sh
docker run -d -p 6379:6379 redis:7
node examples/traffic.js redis://localhost:6379   # writes demo streams under demo:*
npx rivulet-redis redis://localhost:6379
```

## The UI is one file

[`public/index.html`](public/index.html) is the whole frontend: no build step,
no dependencies. Opened on its own it runs the simulator; served by the bridge it
switches to live data as soon as the WebSocket says hello. You can also point the
page at any bridge with `?ws=ws://host:7380/ws`.

<details>
<summary>WebSocket messages (bridge → browser)</summary>

```jsonc
{ "type": "hello", "version": "0.1.0", "redis": { "label": "10.0.0.5:6379", "version": "7.2.5" }, "redacted": false, "interval": 500 }

{ "type": "topology", "time": 1792625082027,          // Redis TIME, ms
  "streams": [{ "key": "orders", "length": 5321, "lastId": "1792625082027-0", "firstId": "…", "entriesAdded": 91234,
    "groups": [{ "name": "billing", "pending": 3, "lastDeliveredId": "…", "entriesRead": 91230, "lag": 4,
      "consumers": [{ "name": "billing-1", "pending": 2, "idle": 120, "inactive": 120 }],
      "pel": [{ "id": "…", "consumer": "billing-1", "idle": 950, "deliveries": 1 }] }] }] }

{ "type": "entries", "stream": "orders", "entries": [["1792625082027-0", { "sku": "kbd-75" }]], "skipped": false }

{ "type": "status", "redis": "down", "error": "…" }
```

The browser may send `{ "type": "inspect", "stream": "orders" }` and receives the
last 30 entries back.

</details>

## Development

```sh
npm ci
npm test                                     # unit tests
REDIS_URL=redis://localhost:6379 npm test    # + integration tests against a real Redis
```

## License

MIT
