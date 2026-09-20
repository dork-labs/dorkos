# Browser verification

How to check a change in a real browser against a real DorkOS, and how to avoid
the traps that make such a check pass while proving nothing.

Written after DOR-927 and DOR-928, where four separate defects — including two
paths to a terminal on the host — were found by _running_ the code and missed by
reading it, in some cases because the surrounding documentation asserted the
behaviour was already correct.

## Which tool

| You want to                                           | Use                                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| prove a known bug stays fixed                         | a spec in `apps/e2e/tests/`, running in CI against the test-mode runtime         |
| go looking, with real agent turns                     | `pnpm --filter @dorkos/e2e multi-window` (see `apps/e2e/multi-window/README.md`) |
| regenerate marketing/docs media                       | `apps/e2e/capture/`                                                              |
| act on a third-party site as the operator (signed in) | the agent browser: [below](#the-agent-browser-signed-in-third-party-sites)       |

The first spends nothing and is deterministic. The second costs model time and
is not. Reach for the second when you do not yet know what is wrong. The fourth
is not about testing DorkOS at all: it is how an agent uses GitHub, Linear or any
other site as the operator without ever holding a password.

## The agent browser (signed-in third-party sites)

The operator signs in once, in their own Chrome on a dedicated, orange-framed
profile (`<dorkHome>/browser/profile`), and saves the session as a Playwright
storage-state file (`<dorkHome>/browser/storage-state.json`, `0600`). Every agent
browser then starts from that file. User guide: `docs/guides/agent-browser.mdx`;
design: `specs/agent-browser-sessions/`.

```bash
dorkos browser login <site>   # sign in, press Enter; raw CDP over --remote-debugging-pipe, no port
dorkos browser status         # sites and cookie expiry, never a value (--json)
dorkos browser forget <site>  # out of the file first, then out of the profile (--all)
```

The server an agent runs is `npx -y @playwright/mcp@0.0.82 --isolated --headless
--storage-state <file>` (the version is pinned in `AGENT_BROWSER_MCP_VERSION`,
`packages/shared/src/agent-browser.ts`, whose TSDoc says what to re-check on a
bump). **`--isolated` is the part that matters for parallel work.** Without it
Playwright MCP keeps one persistent profile per server on disk, and a profile can
be open in only one browser at a time, so the second session (or a second agent,
or you in another window) to open a browser fails on the lock. With it, each
server gets its own in-memory browser seeded from the file, and nothing an agent
does is written back. The same applies to the Playwright MCP you use in this
repo: two of your sessions sharing its default profile collide.

Things that are easy to get wrong:

- **A missing state file is not "signed out".** Playwright MCP 0.0.82 fails every
  tool with `ENOENT`. DorkOS keeps an empty `{cookies:[],origins:[]}` file in place
  (`ensureAgentBrowserStateFile`, on every managed-server write and injection), and
  `forget --all` empties the file rather than deleting it.
- **"Each session gets its own browser" is per server process, not per session.**
  Claude Code starts one per session. Codex runs `codex exec` per turn, so the
  browser restarts every turn. OpenCode registers servers per directory in its
  sidecar, so concurrent sessions of one agent likely share one browser. Only the
  Playwright layer (two isolated servers side by side) is verified by the smoke
  test; the runtime behaviour is expected, not measured.
- **The dev server looks somewhere else.** `pnpm dev` without `DORK_HOME` resolves
  the data directory to `apps/server/.temp/.dork`, while the CLI defaults to
  `~/.dork`. The Tools & MCP card then offers a state file the CLI never writes. Run
  `DORK_HOME=apps/server/.temp/.dork dorkos browser login` (absolute path) against
  a dev server, or set the same `DORK_HOME` for both.
- **Agents can read the saved cookies through their own browser tools.** Playwright
  MCP's always-on core set includes `browser_run_code_unsafe` and
  `browser_network_request`, with no flag, capability or config key to drop them
  (checked in 0.0.82's `filteredTools`). Give the browser only to agents trusted
  with every account in the file.

Inside DorkOS, give an agent the browser from Tools & MCP → Signed-in browser (the
`mcp.browser_preset` read feeds the gated `mcp.add`). Outside DorkOS, register it
under a name other than `playwright` (the Claude Code Playwright plugin owns that
one); the guide has the exact `claude`, `codex` and `opencode` config.

Claude in Chrome drives the operator's everyday browser instead. It works, but it
shares their real tabs and accounts with the agent, and it is not the recommended
path here; prefer the agent browser.

To verify the whole chain on a Mac with Chrome (temp profile, local cookie page,
two parallel isolated servers):
`DORKOS_BROWSER_SMOKE=1 pnpm vitest run packages/cli/src/lib/agent-browser/__tests__/agent-browser-smoke.test.ts`.
It is never run by CI.

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
  predicate reddened them. See `apps/server/src/lib/__tests__/trusted-origins-browser.test.ts`.
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
