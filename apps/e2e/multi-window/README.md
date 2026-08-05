# Multi-window check

Drives a **running** DorkOS cockpit through several browser windows at once and
reports what an operator would actually see.

```bash
pnpm --filter @dorkos/e2e multi-window                      # 6 windows, http://localhost:6241
pnpm --filter @dorkos/e2e multi-window -- --windows 9       # push past the old ceiling
pnpm --filter @dorkos/e2e multi-window -- --base http://localhost:6261 --headed
```

Flags: `--windows N` (default 6), `--base URL` (the client), `--api URL`
(defaults to `--base`), `--headed`.

## What this is, and what it is not

This is a **diagnostic you point at a live instance** — it sends real messages
and waits for real agent replies, so it costs model time and is not
deterministic. Reach for it when you want to go _looking_.

The regression guard is `tests/streams/multi-window.spec.ts`. That one runs in
CI against the test-mode runtime, spends nothing, and proves a known bug stays
fixed. The two are not substitutes.

Both exist because three cockpit windows once made the app stop responding
(DOR-927) and clicking an agent opened a blank chat instead of resuming it
(DOR-928). The checks below are the ones those bugs failed.

## Setup

Point it at anything you are already running — `pnpm dev`, `pnpm dev:dogfood`,
or a worktree cockpit. It discovers agents from `<dorkHome>/agents/*`, reading
`dorkHome` from `GET /api/config`, so the instance needs at least one agent.

More windows than agents is fine and useful: windows wrap around, which puts two
conversations on one agent — a case that has broken independently of the window
count.

## The checks

| Check                                                          | Why it is here                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| every window loads                                             | past the socket ceiling, a new window's own HTML never arrives |
| the app still answers with N windows open                      | the DOR-927 symptom, measured from inside a window             |
| every window accepts a message                                 | a starved window cannot even be typed into                     |
| every window shows its own reply                               | streaming survives concurrency                                 |
| no window shows another window's conversation                  | per-session state is not shared                                |
| each window showed the agent working                           | the sidebar dot and stop button still fire                     |
| the browser matches the runtime transcript                     | catches "the agent answered but the UI never showed it"        |
| the app still answers after all those turns                    | connections are released, not leaked                           |
| returning to an agent reopens the conversation you were having | DOR-928                                                        |
| switching to another agent opens its existing conversation     | DOR-928, the cache-miss path                                   |
| reloading a window keeps the conversation                      | hydration                                                      |
| no uncaught errors in any window                               | —                                                              |

## Which checks are known to discriminate

Stated per check, because "the harness discriminates" is not a property a harness
has — each check either can fail or cannot, and the ones that cannot are the
defect this repo's `contributing/browser-verification.md` warns about.

**Shown to fail on a genuinely broken build** (API killed, Vite left serving):
the health probe before and after, "every window accepts a message", "every
window shows its own reply", "each window showed the agent working", agent
switching (both), and "reloading a window keeps the conversation".

**Shown red-before/green-after against a real fix** — the same live instance,
twice, with only the client changing:

```
before DOR-928 merged   FAIL  switching to another agent opens its existing
                              conversation — landed with 0 messages
after  DOR-928 merged   PASS  switching to another agent opens its existing
                              conversation — landed with 2 messages
```

**Pinned by unit test:** the runtime comparison's role filter and its
unknown-is-not-agreement rule (`__tests__/assistant-said.test.ts`, both
mutation-checked).

**Not independently demonstrated:** "every window loads", and
"no uncaught errors in any window". They are cheap and honest, but nobody has
made them fail on purpose.

If you add a check, add it to the right list — and if you cannot make it fail,
that is the finding.

## Traps this harness already avoids

Worth knowing before you change it, because each one produces a **green run that
proves nothing**:

- **One browser context, several pages.** Separate contexts get separate socket
  pools, so a multi-window test built that way passes on broken code.
- **The health probe runs inside the page** (`page.evaluate(() => fetch(...))`).
  Playwright's `page.request` / `APIRequestContext` run in Node and bypass the
  browser's socket pool entirely.
- **The transcript check reads assistant text only.** A user message repeats the
  marker verbatim ("reply with X"), so scanning every role reports that the agent
  answered when it never did.
- **The working indicator is sampled immediately and often.** It is only up
  between submit and turn end — a loop that sleeps first reports "never showed
  it" for a window whose turn was simply fast.
- **The runtime comparison is asked through the server, not read off disk.**
  Reconstructing the transcript path means reimplementing the SDK's project-slug
  (every non-alphanumeric character becomes a dash, plus a hash-truncation branch)
  and the active-account resolution in front of `CLAUDE_CONFIG_DIR`. An earlier
  version replaced only `/`, so for any agent path containing a dot — including
  the default `~/.dork/agents/*` — it resolved to a directory that never existed
  and returned "no transcript" every time. Its PASS meant nothing.
- **It retries before reporting disagreement.** The runtime's history lags the
  stream: the browser paints a reply as tokens arrive, the SDK writes it down
  slightly later. Asking once produced a false "the browser is showing something
  the runtime never recorded" in one window of two.

See also `../GOTCHAS.md`, and `contributing/browser-verification.md` for the
wider set.
