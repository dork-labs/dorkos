---
id: 261031-072224
title: A bare turbo run takes a heavy slot, and the lock only uses a directory it owns
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Two follow-ups to `261031-010716` (DOR-3274 Phase 1).

**A bare `turbo build` no longer bypasses the cap (DOR-3274 Phase 2).** Phase 1
wrapped the root `pnpm build`, `typecheck`, `test` and `verify` scripts, but a
`turbo build` typed by hand, or run by Playwright's web server, the capture
harness or an agent, went straight past it. turbo has no pre-run hook, so the cap
rides on the task graph: every build, typecheck, test and lint task in
`turbo.json` (and every package override of one) depends on the root task
`//#heavy-slot`. That runs `scripts/heavy-turbo-slot.mjs` once per invocation,
which finds the turbo process and takes a slot for its lifetime with
`heavy-run-lock.sh --hold <pid>`. It is a no-op under `CI`, with
`DORKOS_HEAVY_LOCK=0`, inside `pnpm build` (which already holds a slot) and on
Windows; a `turbo dev` or `turbo watch` run is let through, since it never ends.
It never fails the run.

A nested lock call inside a turbo task loses `DORKOS_HEAVY_SLOT_HELD` to turbo's
strict env mode, so the lock now also treats a call as nested when one of its
ancestors holds a slot. Without that, a turbo inside a turbo task (Playwright's
web server under `turbo e2e`) would wait the whole job bound on its own parent.

**The lock directory must be ours (DOR-3509).** `/tmp/dorkos-heavy-locks-<uid>`
can be created first by another user. A symlink or a foreign directory there is
now refused, with one line, and the command runs uncapped, as for an unwritable
directory. Every slot and queue open uses `O_NOFOLLOW`; before this, a planted
symlink slot file made the holder truncate the file it pointed at. A directory of
ours left open to others is closed to `go-rwx`.

`scripts-test-scope.sh` gains `^turbo\.json$`, because the new
`scripts/__tests__/heavy-turbo-slot.test.ts` pins turbo.json and a turbo.json-only
PR is the shape that drops the dependency.

Cost: the guard is a dependency of every heavy task, so its hash is part of
theirs. A change to the root `package.json` or `turbo.json` (every release bumps
the version) now invalidates the local turbo cache once. There is no remote
cache, and CI never takes the lock, so this claims no CI speed or flake change.
It is `hygiene`, not `incident-fix`: there is no measured baseline for how
often a heavy local run went uncapped, so no hypothesis to state. The
`lock_timeout` share in `tracked.gate-cut-short` is what to read afterwards.

Revert the turbo half if a bare `turbo` run hangs at the end (the sidecar kept
an output open) or the local timings show `lock_timeout` on most job runs; raise
the slots before removing the cap. Revert the directory check only with a
replacement that still refuses a directory another user controls.
