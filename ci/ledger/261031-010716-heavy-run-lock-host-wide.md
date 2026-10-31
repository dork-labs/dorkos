---
id: 261031-010716
title: Heavy local runs take a host-wide slot held by flock
kind: incident-fix
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

`scripts/heavy-run-lock.sh` now caps heavy runs across the whole host, not per
clone, and the root `build`, `typecheck`, `test` and `verify` scripts take a
slot as well as the commit lint. `pnpm heavy <command>` wraps anything else
(DOR-3274, Phase 1).

Why: on 2026-10-24 parallel team jobs (load ~40, 12 GB of disk) panicked this
Mac and took every agent down for hours. The DOR-2160 lock never saw them: it
lived in each clone's git common dir and only wrapped the commit lint.

What changed:

- The slots live in `/tmp/dorkos-heavy-locks-<uid>`, shared by every clone,
  worktree and agent of the user.
- A slot is an exclusive `flock`, held by a perl sidecar for as long as the
  wrapper lives. A holder that dies in any way frees its slot at once, so the
  mkdir slots, the pid reclaim and `heavy_lock_max_hold_seconds` are gone.
- Waiters queue on a flock and print each holder's pid, age, command and
  directory.
- A `--job` waits `heavy_job_wait_seconds` (1800). The commit gate keeps
  `heavy_lock_wait_seconds` (45). Past the bound the command runs anyway, with a
  `lock_timeout` note, as before.
- A nested call runs straight through, so the lock can't deadlock on its own
  parent. `CI` set means no lock at all, so CI is never blocked.

It claims no CI speed or flake change, because CI never takes the lock. Revert
if the local timings show `lock_timeout` on most job runs: that means 3 slots
are too few for this team. Raise the slots or the job wait instead of removing
the cap.
