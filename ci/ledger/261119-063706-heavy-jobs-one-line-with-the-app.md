---
id: 261119-063706
title: The repo's heavy local runs wait in the same line as agents' heavy jobs
kind: experiment
status: proposed
actor: agent
gates: [wf.scripts-test.harness]
prs: []
hypothesis:
  metric: 'local-commit'
  slo: 'local-commit'
  baseline: 149
  baseline_source: 'origin/ci-steward-data latest.json for 2026-11-17 (collected 2026-11-18T13:45Z): SLO local-commit over 2026-11-11..2026-11-17, n=2440 hook runs, p90 149 s, killed_share 0.0041, status breach. Beside it, the machine block: load_per_core_p90 2.43, mem_available_mb_p10 265, swap_used_mb_p50 7710.'
  target: 130
  after_days: 14
ratchet-release: []
field-changes: []
---

## What changed

DOR-4209 PR5a. Until now the machine had two separate lines for heavy work: the
app's load gate (`/tmp/dorkos-load-gate-<uid>`, agents' heavy shell jobs,
`runtimes.loadGate`, default one at a time) and this repo's own lock
(`scripts/heavy-run-lock.sh`, `/tmp/dorkos-heavy-locks-<uid>`, three slots).
An agent's gated `pnpm build` and a person's or another agent's `pnpm test`
could run at once, each line seeing only its own.

Now a `--job` or `--tests` run first takes a turn in the app's line, through
`scripts/load-gate/turn.ts` (run by `tsx`), which opens the server's own
`TicketQueue` rather than copying its folder protocol, and only then, inside
the turn, takes its slot in the repo's lock and passes its load guard (the
helper runs the wrapper again with `DORKOS_LOAD_GATE_IN_TURN=1`). That is the
agents' order: an agent's gated command already holds the app's slot when its
nested `heavy-run-lock --job` asks for a repo slot, so repo runs holding repo
slots while they wait for the app's could stall it, and the commit gate. It
uses the installed app's `runtimes.loadGate` settings (slots, max load, hard
cap), so both lines' jobs wait for each other, first come first served.

- Ticket labels are the program word only (`turbo`, `pnpm`, never arguments).
- A run nested inside a job the app already let run (an agent's gated command,
  whose DorkOS server is an ancestor and owns the slot) goes straight through.
  `TicketQueue.runningOwners()` is the one addition to the server code.
- Not in the line: the commit gate (no `--job`), a bare `turbo` run's `--hold`
  slot, CI, `DORKOS_HEAVY_LOCK=0`, and `DORKOS_LOAD_GATE_LINE=0` (line alone,
  recorded as a new `line_off` note).
- Fail-open: no `tsx`, an unusable folder, a helper that dies before starting,
  one that has not reached the line in 60 s (`DORKOS_LOAD_GATE_START_SECONDS`),
  or ancestry `ps` cannot read while a job runs: the run goes on with the repo's
  lock alone, with one line. A signal during the wait runs nothing.
- A held slot is refreshed until a lease past the hard cap, as the server's are.
- `.temp/coord/heavy.sh` and the lane-brief rules are untouched (PR5b).

New tests: `scripts/__tests__/load-gate-turn.test.ts` (labels, settings,
ancestry) and the fixtures `scripts/test-load-gate-turn.sh`, in `harness` (it needs
`node_modules`). `scripts/test-heavy-run-lock.sh` sets `DORKOS_LOAD_GATE_LINE=0`
so its lock-only cases never touch the machine's real line. The harness scope
gains `apps/server/src/services/core/load-gate/`.

## Why `local-commit`

No metric scores the host's load. The commit gate is the heavy path left
outside both lines on purpose, so capacity freed by one line instead of two
shows there first, as with `261116-024324` and `261117-194143`.

Confounder: the app's gate itself (DOR-4209 PR1/PR2) reaches agents in the same
window and moves the same SLO. Read an improvement as shared.

## What would make us revert

Repo jobs waiting hours behind agents' jobs on a quiet machine (the app's one
slot is too few for this host: raise `runtimes.loadGate.slots` first), a run
that hangs in the line instead of failing open, or `DORKOS_LOAD_GATE_LINE=0`
becoming a habit.
