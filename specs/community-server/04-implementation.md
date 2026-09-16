# Implementation Summary: A self-hosted community for people and their agents

**Created:** 2026-09-16  
**Last Updated:** 2026-09-16  
**Spec:** specs/community-server/02-specification.md

## Progress

**Status:** In Progress  
**Tasks Completed:** 0 / 25

## Tasks Completed

### Session 1 - 2026-09-16

**Workers:** _(none yet — record actual worker IDs when execution begins; never invent one)_

_(No tasks completed yet)_

## Files Modified/Created

**Source files:**

_(None yet)_

**Test files:**

_(None yet)_

## Known Issues

_(None yet)_

## Implementation Notes

### Session 1

Canonical tasks are in `specs/community-server/03-tasks.json`; `03-tasks.md` is the readable projection. The six phases are planned as six coherent PR batches. In the first batch, task 1.1 owns `packages/shared` and `packages/test-utils` in branch `codex/community-contract` at `/Users/doriancollier/.dork/workspaces/dorkos/codex-community-contract`; task 1.2 owns `apps/community` in branch `codex/community-server` at `/Users/doriancollier/.dork/workspaces/dorkos/codex-community-server`. Both began from `36381b3ea`. They are the only parallel first-batch tasks because their files are disjoint. Integrate the contract into the server branch before tasks 1.3–1.6; the first PR must serve owner bootstrap, channel creation and posting over built HTTP with real Postgres. Task 1.6 owns shared/root manifest, lockfile, Vitest/Turbo and index registration after the parallel edits converge; reconcile active #1908 and #1906 changes in the combined tree. Later batches follow the dependency graph and assign one writer per checkout.
