# dsh-trigger-hub

> Give DeepSeek Harness agents something to react to: cron/interval schedules,
> authenticated webhooks and file watchers that start or wake agent sessions —
> with one ledger, one console and one concurrency limit.

`dsh-trigger-hub` is a small, dependency-free DSH bundle. It is an event source,
not a workflow engine: it turns one external event into one agent run and records
what happened. The agent itself decides what the run means.

## Why

DSH sessions are reactive: a person opens a chat, or another plugin creates a
session and prompts it. Recurring jobs, CI notifications and file changes usually
end up as bespoke glue scripts around the host.

This bundle keeps that glue in one place:

- **Schedule**: `cron: "0 9 * * *"` or `every: 6h`.
- **Webhook**: `POST /dsh-trigger-hub/hook/<id>` with a per-source token.
- **Watch**: `fs.watch` on a path, debounced.
- **Sink**: create/resume a DSH session and prompt it, or POST the event to an
  HTTP endpoint (for example a super-agent router).
- **Policy**: enable/pause, duplicate suppression, concurrency limit, quiet hours.
- **Ledger**: last 200 runs, counters and a read-only console page.

## Install

The package is a DSH bundle (no build step, no runtime dependencies):

```bash
npm pack
# then install the tarball with your DSH plugin manager, or point it at this checkout
```

On a profile that manages bundles with a patch file, install the package and add
the row from `cordis.patch.yml`. Configuration lives on that row; see
`examples/profile.cordis.patch.yml` for a full example.

After the host reloads:

```bash
curl -s http://127.0.0.1:59434/dsh-trigger-hub/health
# {"ok":true,"state":"ready","paused":false,"sources":3,"failed":0}
```

The example origin `http://127.0.0.1:59434` is the DSH Web UI on a default local
setup. Replace it with your host's origin.

## Configuration

```yaml
config:
  stateDir: /path/to/trigger-hub-state   # default: $DSH_HOME/dsh-trigger-hub
  concurrency: 2                          # runs in flight across all sources
  dedupeWindowMs: 60000                   # webhook delivery suppression
  sources:
    - id: nightly-review
      kind: schedule
      cron: "0 9 * * *"                   # or every: 6h
      prompt: |
        Review the repository and report a short summary.
      sink:
        kind: session
        cwd: /path/to/repository
        preset: standard
```

### Source fields

| Field | Applies to | Meaning |
| --- | --- | --- |
| `id` | all | Stable id used in routes, the ledger and the console. Required |
| `kind` | all | `schedule`, `webhook` or `watch` |
| `enabled` | all | `false` disables the source without removing it |
| `cron` / `every` | schedule | Five-field cron or an interval (`30s`, `5m`, `6h`, `2d`); exactly one |
| `token` / `tokenEnv` | webhook | Shared token; `tokenEnv` reads it from the environment at request time |
| `path` | watch | File or directory to watch |
| `debounceMs` | watch | Coalescing window, default `1500` |
| `prompt` | all | Text for the session sink; `{{payload}}` is replaced with the event JSON |
| `quietHours` | all | `{from: "22:00", to: "07:00"}` suppresses fires, wrapping midnight |
| `sink` | all | `{kind: "session", cwd?, preset?}` (default) or `{kind: "http", url, method?, headers?}` |

A `schedule` source fires its sink and reschedules itself. A `watch` source
debounces filesystem events. A `webhook` source only fires when called with the
right token.

### Session sink

The hub creates a Session named `trigger-hub-<source>-<runId>` in the configured
`cwd`, using the optional agent preset, then queues the prompt. If a Session with
that id already exists it is resumed and prompted instead. The hub never runs
tools itself; the agent session owns the work.

### HTTP sink

The hub POSTs `{source, runId, payload}` as JSON to the configured URL. Any
non-2xx response marks the run failed. This is the integration point for an
external router or task queue.

## HTTP surface

| Method | Path | Auth | Meaning |
| --- | --- | --- | --- |
| POST | `/dsh-trigger-hub/hook/<source-id>` | `x-trigger-token` header or `?token=` | Fire a webhook source |
| POST | `/dsh-trigger-hub/run/<source-id>` | loopback only | Fire any source manually |
| GET | `/dsh-trigger-hub/state` | loopback or same origin | Ledger snapshot (JSON) |
| GET | `/dsh-trigger-hub/health` | loopback or same origin | Health (JSON) |
| GET | `/dsh-trigger-hub/panel` | loopback or same origin | Console page |

Webhook bodies must be JSON and are limited to 64 KiB. A repeated delivery with
the same `id`/`delivery`/`key` inside `dedupeWindowMs` is suppressed and counted
as `deduped`, without calling the sink.

## Security

- Webhook sources require a token; a missing token, an empty token, or a source
  without `token`/`tokenEnv` is rejected.
- Use `tokenEnv` so the token lives in the environment, not in a profile file.
- The console and state routes are available only to loopback clients or
  same-origin requests.
- The hub does not start a public listener of its own: it uses the DSH web
  server. If the host is exposed beyond loopback, put it behind your normal
  authentication and TLS.
- The ledger stores prompts, event payloads and error strings. Do not send
  secrets in webhook payloads.

## Limits

- At-most-once delivery: a run is recorded before the sink executes; a crash
  leaves it `running` in the ledger. There is no retry queue.
- One host, one process. No HA, no sharding.
- File watching is best-effort and platform-dependent.
- The console is read-only except for "Run now"; pause and source changes are
  configuration edits followed by a reload.
- This is not a workflow engine. For multi-step, multi-agent work, point the HTTP
  sink at an agent router.

## Development

```bash
node --test
npm pack --dry-run
```

The test suite covers duration/cron parsing, policy decisions, the ledger and a
fake host that verifies session creation and prompting. No DSH process is needed.

## License

MIT. See [LICENSE](LICENSE).
