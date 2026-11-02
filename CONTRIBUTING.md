# Contributing

Thanks for taking a look. This project favours small, reviewable changes.

## Development

```bash
node --test            # unit tests, no DSH process needed
npm pack --dry-run     # verify the published file set
```

The package has no runtime dependencies and no build step. Keep it that way:
new behaviour should be covered by a unit test that runs on Node 22+.

## Layout

| Path | Responsibility |
| --- | --- |
| `index.js` | Cordis plugin surface, HTTP routes, config validation |
| `src/schedule.js` | duration and cron parsing (pure) |
| `src/policy.js` | fire decisions and ledger transitions (pure) |
| `src/store.js` | JSON ledger with atomic writes |
| `src/runtime.js` | sources, sinks, timers and watchers |
| `src/panel.js` | server-rendered console |

## Guidelines

- Keep `src/schedule.js`, `src/policy.js` and `src/store.js` free of DSH imports
  so they stay testable and reusable.
- Never put a secret in the repository, an example or a test. Use `tokenEnv`.
- A new source or sink needs: config validation, a unit test, a README row and a
  note in `docs/design.md`.
- Commit messages follow Conventional Commits; keep each commit focused.
- Do not add a dependency without a strong reason; prefer Node built-ins.

## Reporting security issues

Do not open a public issue for a vulnerability. Contact the maintainer privately
with a minimal reproduction and the affected version.
