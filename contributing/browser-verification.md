# Browser verification

How to check a change in a real browser against a real DorkOS, and how to avoid
the traps that make such a check pass while proving nothing.

Written after DOR-927 and DOR-928, where four separate defects — including two
paths to a terminal on the host — were found by _running_ the code and missed by
reading it, in some cases because the surrounding documentation asserted the
behaviour was already correct.

## Which tool

| You want to                       | Use                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------- |
| prove a known bug stays fixed     | a spec in `apps/e2e/tests/`, running in CI against the test-mode runtime         |
| go looking, with real agent turns | `pnpm --filter @dorkos/e2e multi-window` (see `apps/e2e/multi-window/README.md`) |
| regenerate marketing/docs media   | `apps/e2e/capture/`                                                              |

The first spends nothing and is deterministic. The second costs model time and
is not. Reach for the second when you do not yet know what is wrong.

## Standing up an instance

`apps/e2e/capture/boot.ts` does this properly — isolated ports, an isolated
`DORK_HOME`, pidfile reconciliation, and a teardown that escalates SIGTERM to
SIGKILL over a process group. Read it before hand-rolling process management.

If you do stand one up by hand:

- **`DORKOS_BOUNDARY` defaults to `$HOME`.** A `DORK_HOME` under `/private/tmp`
  answers **403** on `/api/commands`, `/api/files` and `/api/directory`. The
  failure is asymmetric, which is more confusing than a uniform wall: the session
  routes pass `allowDorkHome` to `assertBoundary` (`routes/sessions.ts`,
  `lib/boundary.ts`), so `/api/sessions` keeps working for agents under that same
  out-of-bounds `DORK_HOME`.
- **Give every concurrent instance its own `DORK_HOME`, not just its own port.**
  The server refuses to boot when another process holds the same data directory
  and names the PID — a port clash is the obvious collision, a data-directory
  clash is the one that surprises you. The check is off under `NODE_ENV=test` and
  behind `DORKOS_SKIP_INSTANCE_LOCK` (`lib/instance-lock.ts`), so it will not save
  you in the e2e leg.
- **In development, set `VITE_PORT` on the _server_ process too**, not only the
  client. The trusted-origin list is built from `DORKOS_PORT` and `VITE_PORT`, and
  since ADR 260805-041016 it gates WebSocket upgrades as well as CORS. Get it
  wrong and the SPA renders, REST works, turns run, transcripts fill — and the
  browser shows nothing. **This does not apply in production:**
  `getStaticLocalOrigins()` deliberately drops the Vite origin when
  `NODE_ENV=production`, because the server serves the SPA itself and anything
  else listening on that port would otherwise be trusted — which on the socket
  path now includes the terminal.
- **Copying a `DORK_HOME` between paths carries stale absolute agent paths** in
  its SQLite. Recreate agents via `POST /api/agents` at the new path instead.
- Dismiss onboarding headlessly with `PATCH /api/config`
  (`{onboarding:{dismissedAt},profile:{rolePromptDismissedAt}}`) —
  `apps/e2e/global-setup.ts` already does this idempotently, so call it rather
  than restating it. Pin a cheap model with
  `{runtimes:{claudeCode:{defaultModel:"sonnet"}}}`; new sessions otherwise start
  on the default, which makes plumbing checks slow and expensive.

## Writing a check that can actually fail

A verification that cannot fail is worse than none: it converts "we did not look"
into "we looked and it was fine". Before trusting a green run, make it red on
purpose — break the thing it watches and confirm it complains.

Specific traps, each of which has produced a false green here:

- **Gate every probe on a health check.** A probe that runs before the server is
  listening reports the _shape_ of a refusal for every case, including the ones
  meant to succeed. Two separate runs during DOR-927 read "all refused" against a
  server that had not started.
- **A completed WebSocket handshake is not access.** Refusals ride a close frame
  (close code `4000 + status`), so a probe that resolves on `open` reports success
  for a rejected connection. Wait for a data frame. A first pass at the DOR-927
  origin probe reported nine leaks that were all correct refusals.
- **A router-level test cannot pin a defence-in-depth guard** whose case is also
  caught downstream. Two mutations of the upgrade origin check stayed green
  because a later layer refused the same request; only a direct test of the
  predicate reddened them. See `apps/server/src/lib/__tests__/trusted-origins-upgrade.test.ts`.
- **Scan the right role.** A transcript check that scans every entry matches the
  marker inside the _user's own_ message ("reply with X") and reports that the
  agent answered when it never did.
- **Sample transient UI immediately.** A working indicator is only up between
  submit and turn end; a loop that sleeps before its first look reports "never
  showed it" for a fast turn.
- **Rebuild `@dorkos/shared` after pulling.** A stale `dist/` fails to resolve a
  newly added subpath, which surfaces as an unrelated-looking import error in
  whichever test file happens to load first.

### Dev-mode quirks when standing one up in a worktree

- A fresh worktree needs `pnpm install` **and**
  `pnpm --filter "@dorkos/server^..." build` before anything runs, and has no
  `.env` — pass `DORKOS_PORT` and `VITE_PORT` explicitly (4242/6241 are usually
  taken by the real instances).
- **`turbo.json`'s `globalPassThroughEnv` is the env allowlist.** `DORKOS_PORT`,
  `VITE_PORT`, `DORKOS_DEFAULT_CWD`, `DORKOS_CORS_ORIGIN`, `DORK_HOME` pass
  through; `CLAUDE_CONFIG_DIR` does not, so `pnpm dev` cannot inherit an alternate
  Claude account a shell exported.
- Running the server **outside** turbo (`npx tsx src/index.ts`) needs
  `DORKOS_CORS_ORIGIN=http://localhost:<VITE_PORT>` or every client query dies on
  CORS and reads as a wall of 500s.
- **`pnpm dev` restart-loops on a fresh `DORK_HOME`**: the server writes
  `<DORK_HOME>/cache/extensions/server/_run/*.js` at boot, tsx-watch sees the
  change, restarts, forever. Run the server without watch (`npx tsx src/index.ts`
  from `apps/server`) and Vite separately; skip `pnpm dev`'s site task, which
  binds a fixed port the real instance may hold.
- **Two fields mislead.** `workingDirectory` in `GET /api/config` is
  `process.cwd()`, not the session-listing root — verify `DORKOS_DEFAULT_CWD` via
  `GET /api/sessions` instead. And the session list is cwd-scoped, so a worktree
  instance shows zero sessions until pointed at the repo whose project slug holds
  them.
- `lsof` hangs on some machines — probe port occupancy with
  `curl -s -m 2 -o /dev/null http://localhost:<p>/` and prefer a fresh port pair
  over reclaiming a held one.
- Driving the UI: the right panel boots collapsed but still renders its tab strip,
  so clicks inside it fail with "subtree intercepts pointer events" — open the
  panel first. Radix comboboxes ignore synthetic JS clicks (focus the trigger,
  then real key events). `navigator.clipboard.readText()` hangs on a permission
  prompt under automation — spy on `writeText` instead.

For the browser-specific traps — one context vs many, and why
`page.request.get()` silently bypasses the socket pool — see
`apps/e2e/GOTCHAS.md`.

## Verifying a security guard

Drive it. Every origin-policy hole in DOR-927 survived a careful diff read, twice
because three separate comments asserted the policy matched the HTTP CORS path
when it did not.

- Enumerate the branches and say what each admits. The recurring bug shape was an
  **unpaired early `return true`** sitting above the branch that checks `Host`.
- Attack both directions. Too narrow is a silent outage; too wide is a breach.
  Both have shipped here.
- Test the deployment shapes, not just the attacks: loopback, LAN IP, bind
  address, reverse-proxied name, and no `Origin` at all (CLI and desktop clients
  legitimately omit it).
- Mutate each branch and confirm a test goes red. **Confirm the mutation actually
  applied** by inspecting the diff first — a patch that silently fails to apply
  leaves the test green and reads as proof.
