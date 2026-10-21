# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/); while on 0.x, minor versions may
include breaking changes to the CLI or the WebSocket protocol.

## [Unreleased]

### Added
- Several Redis targets in one rivulet: `--config file.json`, repeatable
  `--target name=url`, or several URLs. The UI gets a picker, and the choice is
  kept in the URL hash.
- Targets connect lazily: no Redis connections or commands while nobody is
  watching; disconnect 60 s after the last viewer leaves.
- Startup check of every target; `/healthz` reports per-target state.
- CI runs against Redis 8.

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
- systemd unit, Dockerfile, demo traffic generator.

[Unreleased]: https://github.com/tferreira/rivulet/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tferreira/rivulet/releases/tag/v0.1.0
