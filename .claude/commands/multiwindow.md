---
description: Drive a running DorkOS through several browser windows at once and report what an operator would see
argument-hint: '[windows] [base-url] [--headed]'
category: testing
---

# Multi-window check

Open several cockpit windows against a **running** DorkOS, send a real message in
each, and report a PASS/FAIL table. Use it to go looking — for the regression
guard that runs in CI, see `apps/e2e/tests/streams/multi-window.spec.ts`.

## Parse `$ARGUMENTS`

- A bare number → `--windows` (default `6`)
- Anything starting with `http` → `--base` (default `http://localhost:6241`)
- `--headed` → watch it happen

## Preflight

An instance must already be running, with at least one agent. Confirm it and
report the agent count before driving anything:

```bash
BASE="${BASE:-http://localhost:6241}"
curl -sf "$BASE/api/health" | grep -q '"ok"' || echo "no server at $BASE — start one with 'pnpm dev' or 'pnpm dev:dogfood'"
curl -s "$BASE/api/config" | python3 -c "import sys,json;print('dorkHome:', json.load(sys.stdin)['dorkHome'])"
```

If there is no server, stop and say so — do not start one silently, because the
data directory and ports are the operator's choice.

## Run

```bash
pnpm --filter @dorkos/e2e multi-window -- --windows <N> --base <URL>
```

It exits non-zero if any check fails.

## Report

Give the PASS/FAIL table verbatim, then interpret it. What the failures mean:

| Failing check                                                  | Read it as                                                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| the app still answers with N windows open                      | the connection budget is exhausted — every other failure in the run is probably this one, so fix it before believing anything else |
| every window shows its own reply                               | streaming is broken under concurrency                                                                                              |
| no window shows another window's conversation                  | per-session state is leaking between windows                                                                                       |
| the browser matches the runtime transcript                     | the agent answered and the UI never showed it — check the stream, not the runtime                                                  |
| returning to an agent reopens the conversation you were having | session resolution regressed (DOR-928's shape)                                                                                     |
| each window showed the agent working                           | usually the list stream, which the connection budget starves first                                                                 |

**Two turns are more windows than you think.** Windows wrap around the available
agents, so `--windows 6` with 3 agents puts two live conversations on each — a
case that has broken independently of the window count. Say which agents were
used when reporting.

**A green run at 6 is not a green run at 9.** The failure this exists to catch is
a ceiling, so if you are checking a fix, run it above the number that used to
break.

## Before concluding anything

Read `contributing/browser-verification.md`. Several ways of writing this check
produce a green run that proves nothing, and two of them have shipped here.
