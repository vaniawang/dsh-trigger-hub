# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-02

### Added

- `procedure` sources: run one shell command without a model call, with
  `timeoutMs`, `expectExitCode`, a bounded output tail and optional
  `onFailure` / `onSuccess` sinks. Procedures may be scheduled with `cron` or
  `every` and fired manually like any other source.

### Notes

- Procedures run as the host user; they are trusted configuration, not a sandbox.
- The ledger keeps the last 2,000 characters of procedure output per run.

## [0.1.0] - 2026-11-02

### Added

- Schedule sources with five-field cron or interval expressions (`30s`…`2d`).
- Webhook sources with per-source tokens (`tokenEnv` recommended), 64 KiB JSON
  body limit, constant-time token comparison and duplicate suppression.
- File-watch sources with debouncing.
- Session sink (create/resume a DSH session and prompt it) and HTTP sink.
- Global concurrency limit and quiet hours.
- JSON ledger with atomic writes, run history and counters.
- Read-only console at `/dsh-trigger-hub/panel` with manual "Run now".
- Unit tests for schedule parsing, policy, the ledger and the runtime.

### Notes

- Delivery is at-most-once; there is no retry queue.
- The plugin uses the DSH web server; it does not open its own listener.
