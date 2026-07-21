# @dorkos/e2e — Playwright browser tests

End-to-end browser tests for the DorkOS cockpit and the marketing site.

For how to write and maintain tests, use the `browser-testing` skill and read
`GOTCHAS.md`. This file covers how to _run_ the suite, especially in an isolated
environment (a worktree, or any machine whose default ports are busy).

## Projects

- `chromium` — the cockpit suite. Runs every spec except `chat-mock.spec.ts`
  (and `marketplace.spec.ts` unless the site leg is enabled — see below).
- `chromium-mock` — `chat-mock.spec.ts` only, against a `TestModeRuntime` server
  (no real Claude API calls).

## webServer legs

Playwright's `webServer` array is global: whatever legs are listed boot for
every run, regardless of `--project`. The legs are:

| Leg                     | Default port | Env override                           |
| ----------------------- | ------------ | -------------------------------------- |
| Express API             | 4242         | `DORKOS_PORT`                          |
| Vite client             | 4241         | `VITE_PORT`                            |
| Express API (test-mode) | 4243         | `DORKOS_MOCK_PORT`                     |
| Vite client (test-mode) | 4248         | `DORKOS_MOCK_VITE_PORT`                |
| Marketing site          | 6244         | `DORKOS_SITE_PORT` (opt-in, see below) |

## The marketing-site leg is opt-in (`E2E_SITE`)

The site leg (`Next.js` + Turbopack + a fumadocs file watcher) is heavy and only
`marketplace.spec.ts` needs it. It is booted only when `E2E_SITE=1` (and on by
default in CI; set `E2E_SITE=0` to force it off there). When the site leg is off,
`marketplace.spec.ts` is skipped so it never hangs on an unreachable site.

Leaving it off for cockpit-only runs is not just a speed win. On a machine with
many recursive file watchers already running (several worktrees, several dev
servers), the site's watcher hits `EMFILE` ("too many open files"). Turbopack
then fails to discover the `src/app` routes, so every route — including `/` —
falls through to `_not-found` and returns **404**. The site leg's readiness gate
polls `/`, so it never clears and the whole run stalls for 180s. This is what
blocked isolated runs in DOR-407.

If you do need the site leg under watcher pressure, run it with polling watchers,
which avoids `EMFILE` entirely:

```bash
E2E_SITE=1 WATCHPACK_POLLING=true CHOKIDAR_USEPOLLING=1 pnpm --filter @dorkos/e2e e2e --project chromium
```

`apps/site/next.config.ts` also pins `turbopack.root` to the monorepo root, so a
nested-worktree checkout no longer watches the entire outer repo tree.

## Isolated run recipe

To run the cockpit suite (or one spec) on a machine whose default ports are busy
— for example your live cockpit on 4242 — override every port and point the
server at a throwaway `DORK_HOME`. `E2E_SITE` stays unset, so no site leg boots.

```bash
# from apps/e2e
env -u E2E_SITE \
  DORKOS_PORT=4252 VITE_PORT=4251 \
  DORKOS_MOCK_PORT=4253 DORKOS_MOCK_VITE_PORT=4258 \
  DORK_HOME="$PWD/../../.temp/dork-e2e-iso" \
  pnpm exec playwright test tests/smoke/app-loads.spec.ts --project chromium
```

Notes:

- Override the mock ports too (`DORKOS_MOCK_PORT` / `DORKOS_MOCK_VITE_PORT`).
  `reuseExistingServer` is on outside CI, so a mock leg left on its default port
  would silently attach to another run's server. Fresh ports keep the run yours.
- Use a fresh `DORK_HOME` so the run never touches your real `~/.dork` data.
- `--project chromium` runs the cockpit project; add `-g "<title>"` to run a
  single test by name.

## Common commands

```bash
pnpm --filter @dorkos/e2e e2e          # run all projects
pnpm --filter @dorkos/e2e e2e:ui       # Playwright UI mode
pnpm --filter @dorkos/e2e typecheck    # tsc --noEmit
pnpm test:browser                      # from repo root, via turbo + dotenv
```
