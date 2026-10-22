# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/); while on 0.x, minor versions may
include breaking changes to the CLI or the WebSocket protocol.

## [Unreleased]

## [0.1.1] - 2026-10-22

### Fixed
- The "recent entries" drawer was empty on streams that delete entries once
  every group acked them (`XACKDEL … ACKED`), even with entries visibly
  flowing: Redis holds almost nothing, and the drawer showed only that. It now
  merges what Redis still holds with the last 50 entries the page saw arrive,
  independent of the time window, and its header shows stored vs. total added.

## [0.1.0] - 2026-10-22

First release.

- Read-only bridge: SCAN discovery, topology polling (`XINFO`, `XPENDING`, `TIME`)
  and tailing with `XREAD BLOCK`. Every command passes an allowlist enforced
  inside the Redis client.
- Single-file Canvas UI with a built-in simulator and three themes (Neon, Clean,
  Cockpit) behind a one-click toggle; switches to live data on a WebSocket feed.
- Per-group lag gauge and delivered/s rate (Redis 7+), deliveries drawn as sparks
  scaled by throughput, pending entries per consumer, sampling for busy streams.
- CLI with ACL username, password from an env var, TLS, stream filters and
  `--redact`.
- Several Redis targets in one rivulet (`--config file.json`, repeatable
  `--target name=url`, or several URLs) with a picker in the UI; the choice is
  kept in the URL hash. Targets connect lazily: no Redis commands while nobody
  is watching.
- Startup check of every target; `/healthz` reports per-target state.
- systemd unit, Dockerfile, demo traffic generator. CI on Redis 6.2, 7.4, 8.

[Unreleased]: https://github.com/tferreira/rivulet/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/tferreira/rivulet/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tferreira/rivulet/releases/tag/v0.1.0
