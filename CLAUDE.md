# CLAUDE.md

Realtime, animated, **read-only** visualizer for Redis Streams. Node bridge (ioredis) ↔ browser over WebSocket; the whole UI is one self-contained HTML file.

## Layout

- `bin/rivulet.js` — CLI (`node:util` parseArgs). npm package name is `rivulet-redis` (`rivulet` was taken on npm); the binary is `rivulet`.
- `src/guard.js` — command allowlist patched into ioredis `sendCommand`. **Every** Redis command passes through it.
- `src/bridge.js` — `Bridge` (EventEmitter): SCAN discovery, topology poll (`XINFO STREAM/GROUPS/CONSUMERS`, `XPENDING`, `TIME`), and a tail loop on a second connection (`XREAD BLOCK`). Emits `topology`, `entries`, `status`.
- `src/parse.js` — raw RESP replies → plain objects. Handles Redis 5/6/7 differences (missing `lag`, `entries-read`, `inactive` → `null`).
- `src/server.js` — HTTP (serves `public/index.html`, `/healthz`) + `ws` at `/ws`. Injects `window.RIVULET={ws:true}` at the `<!--RIVULET_CONFIG-->` marker so the page knows to connect.
- `public/index.html` — the UI: Canvas 2D renderer, built-in simulator, 3 themes (neon / clean / cockpit). No build step, no dependencies. Opened standalone (or on GitHub Pages) it runs the simulator; on a `hello` message it flips to live.
- `examples/traffic.js` — demo traffic generator (this one *does* write; scratch Redis only). `examples/rivulet.service` — systemd unit.

## Hard rules

- **Never** let the bridge write, ack, claim or move a group cursor. No `XADD`, `XACK`, `XREADGROUP`, `XCLAIM`, `XAUTOCLAIM`, `XGROUP`, `XTRIM`, `XDEL`, `CONFIG`, `EVAL`, `CLIENT`… If a feature needs a new read command, add it to `ALLOWED` in `src/guard.js`, add it to the tests in `test/guard.test.js`, and update the command list + ACL line in `README.md` and the CLI help.
- Keep `public/index.html` a single dependency-free file that works from `file://`. Simulator and live feed must go through the same `handle()` → `applyTopology` / `applyEntries` path; the sim emits exactly the bridge's message shapes.
- Plain Node is the primary way to run it (users run it on servers without Docker). Docker is optional. Node ≥ 20, ESM only.
- Default bind is `127.0.0.1`; the UI has no auth.

## Wire protocol

Documented in the README ("WebSocket messages"). If you change a message shape, change the bridge, the simulator in `index.html`, and the README together.

## Visual model (index.html)

- Lane x-position = entry age (`now - ms` from the entry ID, using Redis `TIME` offset). Left = now.
- Group cursor = age of `last-delivered-id`; pinned at "now" when caught up (`lag === 0`, or `lastDeliveredId === lastId` without lag).
- Deliveries are inferred from snapshot diffs (`entries-read` delta, per-consumer `pending` increase / `idle` reset) and drawn as sparks; consumer pending clusters reconcile toward `pending` (pops = acks).
- Themes are JS objects in `THEMES` + matching CSS vars on `body[data-theme]`.

## Testing

```sh
npm test                                     # unit tests (guard, parse); integration tests skip
REDIS_URL=redis://127.0.0.1:6379 npm test    # + integration against a real Redis
```

`npm test` runs `node --test test/*.test.js` (Node 25 no longer accepts a bare directory). CI runs Node 20/22/24 × Redis 6.2/7.4 and builds the Docker image. For UI changes, run `node examples/traffic.js` + the CLI and check sim and live mode in a browser at desktop and ~400px widths, in all three themes.

## Release

- Push to `main` → GitHub Pages demo from `public/`.
- Tag `v*` → multi-arch image to `ghcr.io/tferreira/rivulet`.
- npm publish is manual (`npm publish`).
