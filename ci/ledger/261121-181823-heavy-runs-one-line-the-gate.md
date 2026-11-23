---
id: 261121-181823
title: DorkOS's load gate becomes the one line for heavy local runs, with the coordinator's order line and a raw-command guard
kind: experiment
status: proposed
actor: agent
gates: [wf.scripts-test.fixtures, claude.PreToolUse.heavy-command-guard]
prs: []
hypothesis:
  metric: 'local-commit'
  slo: 'local-commit'
  baseline: 182
  baseline_source: 'origin/ci-steward-data latest.json for 2026-11-20 (collected 2026-11-21T13:20Z): SLO local-commit over 2026-11-14..2026-11-20, n=1310 hook runs, p90 182 s, killed_share 0.0046, status breach. The collector was unhealthy that day (two clones last exported 2026-11-17), so the sample is thin at the end. Machine block: load_per_core_p90 2.68, mem_available_mb_p10 248, swap_used_mb_p50 8792.'
  target: 160
  after_days: 14
ratchet-release: []
field-changes: []
---

## What changed

DOR-4209, the part Dorian set on Nov 21: the machine had three lines for heavy
work (`.temp/coord/heavy.sh`, git-ignored; `scripts/heavy-run-lock.sh`; and the
app's load gate from #3986/#3993/#4000/#4003). Only the gate covers every agent
whatever its repo, runtime or account, and only it has a person's view and an
audit trail. So:

- **Inside a gate turn, `heavy-run-lock.sh` runs the command at once.** It no
  longer takes one of its own slots or reads the one-minute load a second time;
  the turn already judged both. Its flock slots stay for what never joins the
  gate: the commit gate, a bare `turbo` run's `--hold`, and the fall-through
  when the gate cannot be reached.
- **The coordinator's order line moves into the repo** (`--label`, `--done`,
  `--status`; `scripts/lib/heavy-order.sh`), with its files in
  `$DORK_HOME/load-gate/` (else `~/.dork/load-gate/`), not `.temp/coord`. Only
  the top label may start; others exit 75. **DOR-4901:** a top label with no
  live run for 15 minutes moves down one place, with a dated note, and its owner
  is told. `slots.max` is gone; the gate's `runtimes.loadGate.slots` decides.
- **`.claude/hooks/heavy-command-guard.mjs`** refuses a raw whole `vitest run`,
  `playwright test` or heavy `turbo` task in a bare Claude Code session and
  names `pnpm heavy` instead. Left alone in a DorkOS chat, where the server's
  hook already holds the command.
- `contributing/ci.md` and `AGENTS.md` describe the gate as the one line.

`.temp/coord/heavy.sh` becomes a thin wrapper over the committed script only
once this Mac runs DorkOS 0.140.0 (the first release with the full gate).

## Why `local-commit`

No metric scores the host's load. The commit gate is the heavy path left on the
flock lock, so a job that no longer holds one of its three slots while it runs
in the gate shows there first, as with `261119-063706`.

Confounders: the gate reaching agents in 0.140.0 moves the same SLO in the same
window, and the collector was stale when the baseline was read. Read an
improvement as shared.

## What would make us revert

Two heavy jobs running at once on this Mac because a gate turn no longer takes a
local slot (watch `load_per_core_p90`), the guard refusing a targeted run an
agent needs (any false refusal is a bug, fixed in the guard), or the order line
moving a label that was in fact running.
