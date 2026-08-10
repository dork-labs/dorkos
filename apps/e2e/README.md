# @dorkos/e2e — Playwright browser tests

End-to-end browser tests for the DorkOS cockpit and the marketing site.

For how to write and maintain tests, use the `browser-testing` skill and read
`GOTCHAS.md`. This file covers how to _run_ the suite, especially in an isolated
environment (a worktree, or any machine whose default ports are busy).

## Projects

- `chromium` — the cockpit suite. Runs every spec except `chat-mock.spec.ts`
  (and the site specs — `marketplace.spec.ts`, `features.spec.ts` — unless the
  site leg is enabled; see below).
- `chromium-mock` — `chat-mock.spec.ts` only, against a `TestModeRuntime` server
  (no real Claude API calls).
- `chromium-connections` — `tests/connections/`, also against the test-mode
  server: its `DORKOS_TEST_RUNTIME` gate is what makes the scripted
  `test-connector` provider exist, so these specs can walk the real save-key →
  connect → attach flow with no vendor anywhere.

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

The site leg (`Next.js` + Turbopack + a fumadocs file watcher) is heavy, and only
the site specs need it: `marketplace.spec.ts` and `features.spec.ts` (the
`SITE_SPECS` list in `playwright.config.ts`), which point their baseURL at the
marketing site instead of the cockpit. The leg boots only when `E2E_SITE=1`. When
it is off, those specs are skipped so they never hang on an unreachable site.

In CI the leg is on: the config defaults it on whenever `CI` is set (unless
`E2E_SITE=0`), and the gate that runs this suite —
`.github/workflows/browser-test.yml` — also sets `E2E_SITE=1` explicitly so its
coverage does not ride the conditional.

If you add another spec that targets the site, add it to `SITE_SPECS`. Grep
`tests/` for `6244` and `SITE_BASE_URL` to keep the list complete.

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

## Tests that need real model credentials are off by default (`E2E_INTEGRATION`)

Specs tagged `@integration` start a real agent turn and wait for a model to
answer. They need model credentials, and they spend real money per run. A PR
runner has neither, so **they never run unless you ask for them** — in CI or on
your machine:

```bash
E2E_INTEGRATION=1 pnpm --filter @dorkos/e2e e2e --project chromium
```

Off by default everywhere, not just in CI. Forgetting the flag costs you a
skipped test; forgetting the opposite default costs you money.

Tag a spec `@integration` whenever it cannot pass without a live model. If you
can express it against `TestModeRuntime` instead, put it on the mock leg (next
section) and it runs everywhere.

## Adding a mock-server suite

`chromium-mock` matches exactly one file, `chat-mock.spec.ts`, and that is a
safety property rather than tidiness. The test-mode server is global mutable
state — `POST /api/test/reset` wipes scenarios and **deletes every tracked
session's transcript**, and that file calls it before each of its tests — while
`fullyParallel` schedules separate spec **files** onto concurrent workers. A
second mock spec file would have its transcript deleted mid-run by a neighbour.

So a new mock-server suite takes one of two shapes, never a second spec file:

- **Write it into `chat-mock.spec.ts`.** The default, for a handful of tests
  that share the file's `beforeEach` (reset, dismiss onboarding, seed agent).
- **Put it in a module that exports a register function**, and call that from
  `chat-mock.spec.ts`. For a coherent feature suite worth finding by name, or one
  big enough to push the spec file past `max-lines`.
  `tests/chat/session-read-state.ts` is the worked example. Playwright groups
  workers by the file it **loaded**, so the registered tests run on
  `chat-mock.spec.ts`'s worker in its order — as safe from the resets as if they
  were written inline — while living under the feature they test. Name the module
  `*.ts`, never `*.spec.ts`: the extension is the whole thing keeping it off the
  cockpit leg.

Either way the suite needs no new project and no new server leg.

## The suite turns on the features it tests

`DORKOS_TASKS_ENABLED` and `DORKOS_RELAY_ENABLED` are off by default in the
server, and the Tasks and Relay dialogs render a "start DorkOS with…"
placeholder instead of the real panel when they are. The `Express API` leg sets
both, so the specs assert the real thing. Do not rely on your own `.env` for
this — it is untracked, so it would make "does this spec pass" a property of
your machine.

## Isolated run recipe

To run the cockpit suite (or one spec) on a machine whose default ports are busy
— for example your live cockpit on 4242 — override every port and point the
server at a throwaway `DORK_HOME`. `E2E_SITE` stays unset, so no site leg boots.

```bash
# from apps/e2e
env -u E2E_SITE \
  DORKOS_PORT=4252 VITE_PORT=4251 \
  DORKOS_MOCK_PORT=4253 DORKOS_MOCK_VITE_PORT=4258 \
  DORK_HOME=/tmp/dork-e2e-iso \
  pnpm exec playwright test tests/smoke/app-loads.spec.ts --project chromium
```

Notes:

- **Every run boots the mock leg, whichever spec you asked for.** The web
  servers are configured per-run, not per-project, so selecting a single cockpit
  spec still starts the test-mode server and its Vite client. Overriding
  `DORKOS_PORT` / `VITE_PORT` alone therefore is not an isolated run — the mock
  leg stays on 4243/4248 and collides with any other worktree already there,
  failing a run whose specs never touch it.
- Override the mock ports too (`DORKOS_MOCK_PORT` / `DORKOS_MOCK_VITE_PORT`).
  No run adopts a server it did not start, so a leg whose port is already busy
  is a **startup error naming that port** — not, as it once was, a silent
  attachment to whatever was answering. Fresh ports are what let this run
  alongside a live cockpit; without them you get a loud refusal instead of a
  quiet one. The mock leg also deletes its `DORK_HOME` on boot, and that
  directory is keyed by `DORKOS_MOCK_PORT`, so overriding the port is also what
  keeps two concurrent runs from wiping each other's.
- Use a fresh `DORK_HOME` so the run never touches your real `~/.dork` data. Any
  path works, including one inside the checkout — the API legs no longer run
  under a file watcher, so a `DORK_HOME` the server writes to on boot can no
  longer restart it (see "Why the API legs do not watch" below).
- A never-onboarded `DORK_HOME` opens on the first-run wizard, which renders
  _instead of_ the app shell — so every spec would time out waiting for
  `[data-testid="app-shell"]`. `global-setup.ts` dismisses it on every API leg
  before the first spec runs, which is what makes a throwaway `DORK_HOME` usable
  at all.
- `--project chromium` runs the cockpit project; add `-g "<title>"` to run a
  single test by name.

## Why the API legs do not watch

Both Express legs boot with `turbo run build` + a plain `tsx` — never
`turbo dev`, which is `tsx watch`.

On boot the server compiles each core extension to
`DORK_HOME/cache/extensions/server/_run/<id>.js` and `require()`s it. `tsx watch`
watches everything the process requires, so it treats that write as a source
change and restarts, which rewrites the file, which restarts again: a measured
~23 restarts in 45 seconds until the run dies.

The default `DORK_HOME` (`apps/server/.temp/.dork`) hides this by accident,
because `tsx` ignores dot-directories under its own cwd. Point `DORK_HOME`
anywhere else and the loop is back — which is why the isolated recipe above used
to be unrunnable. Tests never edit source, so nothing is lost by not watching.

- Moving the site leg to another port takes two env vars, not one.
  `DORKOS_SITE_PORT` relocates the leg, and both site specs
  (`marketplace.spec.ts`, `features.spec.ts`) default their base URL to
  `http://localhost:6244` unless `SITE_BASE_URL` says otherwise — so set
  `DORKOS_SITE_PORT` and `SITE_BASE_URL` together.

## Common commands

```bash
pnpm --filter @dorkos/e2e e2e          # run all projects
pnpm --filter @dorkos/e2e e2e:ui       # Playwright UI mode
pnpm --filter @dorkos/e2e typecheck    # tsc --noEmit
pnpm test:browser                      # from repo root, via turbo + dotenv
```
