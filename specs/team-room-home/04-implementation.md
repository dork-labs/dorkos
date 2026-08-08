---
slug: team-room-home
status: In Progress
started: 2026-08-08
last-updated: 2026-08-08
---

# Implementation: The home is a room (#team)

**Status:** In Progress
**Tasks Completed:** 11 / 31

## Sessions

### Session 1 - 2026-08-08

**Orchestrator:** Claude Code session c94c2d2a (host: Dorian's machine)
**Workers:** _(recorded per task below)_

Phase worktrees:

- P0: `/Users/doriancollier/.dork/workspaces/dorkos/trh-p0` → branch `feat/team-room-home-p0-foundations`
- Spec docs: `/Users/doriancollier/.dork/workspaces/dorkos/trh-specify` → branch `docs/team-room-home-specify` (PR #866)

Linear: project Team Room Home; umbrella DOR-1026; phases DOR-1027 (P0, claimed), DOR-1028 (P1),
DOR-1029 (P2), DOR-1030 (P3), DOR-1031 (P4); xl swap DOR-1033; RP3 = DOR-665 (claimed).

Assumptions logged:

- Task-API projection is per-phase, not per-task (context economy; canonical descriptions in
  03-tasks.json which workers read directly).
- Task 0.2 (ADR promotion) held by the orchestrator until PR #866 merges, to avoid a same-file
  conflict with the draft ADRs that PR introduces.
- Task 0.4 scope-guarded away from apps/server/src/services/rooms/ (task 0.1 owns that area
  concurrently).

Tasks completed:

- Task #0.1: RP3 ambient pending context (DOR-665) — worker: opus implementation agent; commit
  64b3782e1. Two-stage adversarial review passed. Design notes: third clamp is a SQL LIMIT on
  qualifying entries (a literal seq floor undercounts when exclusions remove positions);
  listUnreadEntries gained a throughSeq ceiling (no double-show across the claim-time cursor
  advance); cursor advance sits in claimTargets immediately before holdClaim, monotonic.
- Task #0.4: presence truthfulness in runtimeConformance — worker: opus implementation agent;
  commit 8ba4d0585. Review round 1 found two criticals (inert gate: sendMessage never fed the
  projector; empty-array turn passed as "shown") — both fixed via drivePresenceTurn through the
  real getOrCreateProjector/feedProjector seam and a non-empty-turn rule; round 2 passed, one
  new finding (N1 false-red on honest blocked-mid-turn) fixed by narrowing the else-arm to
  idle-only. All proofs seeded-and-reverted in test-mode.

- Task #0.3: read-cursor broadcast (room_read_cursor on eventFanOut, cancel-then-min client
  reconciliation) — worker: opus implementation agent; commit "read state follows you between
  devices". Review passed with 2 importants (route-level exactly-one-frame proof; list-badge
  race vs in-flight refetch) — both fixed with red-then-green evidence.
- Task #0.2: thread-over-sessions ADR 260808-140954 draft→accepted — orchestrator, after the
  branch rebased onto post-#866 main.

Phase 0 complete: 4/4. Phase 1 complete: 7/7 (tasks 1.1-1.7: tab shell, Jump back in + the
room-origin overlay, sidebar 7→4 + viewport-safe tours, composer popover with shared identity
marks, dashboard slimmed + extensions on Activity, 50 e2e tests incl. 375px + keyboard gates).
Every task two-stage adversarially reviewed; criticals fixed red-then-green (hollow
active-state tests, mobile tour death, room-turn double-listing, unreachable popover, DM
letter-disc regression, dishonest week summary). Follow-ups: DOR-1036 (parallel branch),
DOR-1039 (summary subject mismatch), promo dead-code on DOR-1031. Product-media cockpit shot
stale — regen after merge. 31-task programme: 11 done; P3 running in parallel.

## Files Modified/Created

See commits 64b3782e1 (0.1: packages/db migration 0057, packages/shared room-schemas,
apps/server/src/services/rooms/\*, 29 client fixture files, openapi.json, changelog fragment)
and 8ba4d0585 (0.4: packages/test-utils runtime-conformance + presence tests,
session/**tests**/durable-turn-harness.ts, four runtime conformance wirings,
contributing/adding-a-runtime.md).

## Known Issues

- Presence conformance gates the runtime layer (lifecycle + cwd binding); the room-level
  busyWith/working_late half is RP9's territory and NOT covered by this gate — Phase 2's
  presence strip must not assume otherwise (review finding I3, accepted as scope).
- claude-code's binding rules are skipped in the mocked-SDK suite (getSession honestly null,
  no JSONL on disk) — disclosed in adding-a-runtime.md.
