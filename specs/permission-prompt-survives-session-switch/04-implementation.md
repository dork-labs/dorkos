# Implementation Summary: Permission prompts survive session switch & refresh

**Created:** 2026-06-09
**Last Updated:** 2026-06-09
**Spec:** specs/permission-prompt-survives-session-switch/02-specification.md
**Branch:** feat/permission-prompt-survives-session-switch
**Linear:** DOR-73

## Progress

**Status:** In Progress
**Tasks Completed:** 2 / 15

## Tasks Completed

### Session 1 - 2026-06-09

- Task #1 (1.1): Add startedAt + snapshot to PendingInteraction and populate in interactive-handlers
- Task #4 (1.4): Add remainingMs to shared event schemas and a PendingInteractionDTO schema

## Files Modified/Created

**Source files:**

- apps/server/src/services/runtimes/claude-code/messaging/interactive-handlers.ts — `startedAt` + per-type `snapshot` (Approval/Question/Elicitation) on every `PendingInteraction`; exported snapshot interfaces (one source of truth).
- packages/shared/src/schemas.ts — optional `remainingMs` (+ `startedAt` on question/elicitation) on the three interaction event schemas; new `PendingInteractionDTOSchema` (discriminated union) + `PendingInteractionsResponseSchema`.
- packages/shared/src/types.ts — re-export `PendingInteractionDTO` + `PendingInteractionsResponse`.

**Test files:**

- apps/server/src/services/runtimes/claude-code/messaging/**tests**/interactive-handlers.test.ts — +3 snapshot-capture tests (8 total green).
- packages/shared/src/**tests**/schemas.test.ts — +7 DTO/remainingMs tests (14 total green).

## Known Issues

_(None yet)_

## Implementation Notes

### Session 1

Executing in 9 dependency batches with batch-level verification gates and per-batch commits. Tasks #5 and #9 serialized (both edit `apps/server/src/routes/sessions.ts`). Task #14 (browser acceptance) is a main-context step run after a dev-server restart on this branch.

**Batch 1 (#1, #4) — done.** Gate: `@dorkos/server` + `@dorkos/shared` typecheck clean; tests green (server 8/8, shared 14/14).

**Key facts for downstream batches:**

- Snapshot interfaces (`ApprovalSnapshot`/`QuestionSnapshot`/`ElicitationSnapshot`) are exported from `interactive-handlers.ts`. Canonical routing key is `toolCallId` (snapshot excludes the id). `ElicitationSnapshot.mode` = `'form'|'url'|undefined`.
- **No root `@dorkos/shared` barrel.** Import DTO types from `@dorkos/shared/types` (`PendingInteractionDTO`, `PendingInteractionsResponse`) and schemas from `@dorkos/shared/schemas`. The DTO is SDK-free (plain JSON).
