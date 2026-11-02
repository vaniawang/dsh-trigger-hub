# Design

## Shape

```text
schedule timer ─┐
webhook POST ───┼─▶ policy ─▶ ledger (run: running) ─▶ sink ─▶ ledger (done/failed)
file watch ─────┘                                   ├─ session: create/resume + prompt
                                                    └─ http: POST JSON
```

- **Sources** are declarative configuration. They do not hold code.
- **Policy** is a pure function over the ledger: enabled, paused, quiet hours,
  duplicate suppression and concurrency.
- **Sink** is the only place with side effects. Two sinks exist on purpose:
  `session` for a DSH-native agent run, `http` for an external router.
- **Ledger** is a JSON file with atomic writes. Runs are recorded before the sink
  executes, so a crash is visible rather than silent.

## Why not a workflow engine

A workflow engine owns steps, retries and state transitions between steps. That
duplicates what an agent session already does, and it adds a second scheduler to
reason about. The hub deliberately stops at "one event, one run, one record".
Multi-step work belongs in the agent; the hub can point its HTTP sink at a router
that dispatches workers.

## Exactly one of cron/every

Cron is good for wall-clock jobs; intervals are good for "every 6 hours from
now". Accepting both on one source makes the schedule ambiguous, so the config
validator rejects it.

## At-most-once

A run is appended to the ledger with `status: running` before the sink runs, then
updated to `done` or `failed`. If the process dies mid-run, the ledger shows a
stale `running` entry. That is intentional: a retry queue would need idempotency
keys for every sink, and the two sinks have different semantics. Operators can
fire manually after inspecting the ledger.

## Dedupe

Webhook delivery is often retried by the sender. The hub hashes the explicit
event id (`id`, `delivery`, `key`) with the source id and suppresses repeats
inside `dedupeWindowMs`. Without an explicit id the payload itself is hashed,
which is useful for small events and noisy for large ones; send an id when the
sender offers one.

## Concurrency

The limit is global, not per source: the host has one set of agent sessions and
one model quota. A run occupies a slot from the moment it is recorded until the
sink settles. Manual runs are subject to the same limit.

## Secrets

Tokens are read from `tokenEnv` at request time and compared in constant time.
Webhook bodies are capped at 64 KiB. State and the console are loopback or
same-origin only.
