# Implementation Summary: Permission prompts survive session switch & refresh

**Created:** 2026-06-09
**Last Updated:** 2026-06-09
**Spec:** specs/permission-prompt-survives-session-switch/02-specification.md
**Branch:** feat/permission-prompt-survives-session-switch
**Linear:** DOR-73

## Progress

**Status:** In Progress
**Tasks Completed:** 12 / 15

## Tasks Completed

### Session 1 - 2026-06-09

- Task #1 (1.1): startedAt + snapshot on PendingInteraction (server)
- Task #4 (1.4): remainingMs + PendingInteractionDTO schema (shared)
- Task #2 (1.2): listPendingInteractions selector (remainingMs + expiry exclusion)
- Task #6 (1.6): idempotent client renderers (upsert by id; elicitation dedup fix; countdown seed from remainingMs)
- Task #3 (1.3): getPendingInteractions on AgentRuntime/session-store/runtime (+ TestModeRuntime, FakeAgentRuntime)
- Task #5 (1.5): GET /api/sessions/:id/pending-interactions (Path A) + Transport/HttpTransport/DirectTransport + OpenAPI
- Task #9 (2.1): re-emit pending interactions on GET /:id/stream connect (Path B); pendingInteractionToStreamEvent mapper (lib/)
- Task #7 (1.7): usePendingInteractions fetch-on-mount + wire into use-session-history (returns replayInteractionEvent for #10)
- Task #8 (1.8): single-resolve guard verified (ZERO prod changes) + test-hardened (409 INTERACTION*ALREADY_RESOLVED / 404 NO_PENDING*\*; client swallows 409)
- Task #15 (3.4): docs — OpenAPI entry + contributing/interactive-tools.md & data-fetching.md (Path A/B, idempotency, ADR-0117/0262, no-restart boundary)
- Task #10 (2.2): route Path-B re-emitted events through syncEventHandlers via replayInteractionEvent ref — cross-path dedup = ONE card (integration-verified)
- Task #12 (3.1): server cross-cutting tests (+7) — real selector→HTTP expiry, Path A/B consistency, single-resolve matrix (38 across 3 files)

## Files Modified/Created

**Source files:**

- apps/server/src/services/runtimes/claude-code/messaging/interactive-handlers.ts — startedAt + snapshot
- apps/server/src/services/runtimes/claude-code/messaging/pending-interactions.ts — `listPendingInteractions(session, now)` selector (NEW)
- packages/shared/src/schemas.ts — interaction event remainingMs/startedAt; PendingInteractionDTO + Response schemas; part-type fields `ToolCallPart.approvalRemainingMs`, `ElicitationPart.startedAt/remainingMs`
- packages/shared/src/types.ts — DTO type re-exports
- apps/client/src/layers/features/chat/model/stream/stream-event-types.ts — `findElicitationPart` on StreamHandlerHelpers
- apps/client/src/layers/features/chat/model/stream/stream-event-helpers.ts — `findElicitationPart` impl
- apps/client/src/layers/features/chat/model/stream/stream-tool-handlers.ts — upsert idempotency (approval/question/elicitation) + remainingMs seed
- apps/client/src/layers/features/chat/ui/tools/ToolApproval.tsx — deadline from `remainingMs` when present
- apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx — thread approvalRemainingMs

**Test files:**

- apps/server/.../messaging/**tests**/interactive-handlers.test.ts (8/8)
- apps/server/.../messaging/**tests**/pending-interactions.test.ts (5/5, NEW)
- packages/shared/src/**tests**/schemas.test.ts (14/14)
- apps/client/.../chat/model/**tests**/stream-event-handler-pending-recovery.test.ts (3/3, NEW)

## Known Issues

- Benign React warning ("Cannot update a component while rendering") when the Path A pull's `usePendingInteractions` hydrate `setMessages` fires — harmless (no test failure); fix by deferring the hydrate write. To address in #13 cleanup.

## Implementation Notes

### Session 1

Executing in 9 dependency batches with batch-level gates + per-batch commits. #5/#9 serialized (both edit `routes/sessions.ts`). #14 (browser acceptance) is a main-context step after a dev-server restart.

**Batch 1 (#1, #4) — done.** Gate: server+shared typecheck clean; tests 8/8, 14/14.
**Batch 2 (#2, #6) — done.** Gate: shared+server+client typecheck clean (exit 0); tests 5/5, 3/3.

**Key facts for downstream batches:**

- Selector: `listPendingInteractions(session: InteractiveSession, now: number): PendingInteractionDTO[]` at `messaging/pending-interactions.ts` — pure, `now` injected (callers pass `Date.now()`). `SESSIONS.INTERACTION_TIMEOUT_MS` from `apps/server/src/config/constants.ts`.
- No root `@dorkos/shared` barrel — types from `/types`, schemas from `/schemas`.
- Client handlers (`handleApprovalRequired`/`handleQuestionPrompt`/`handleElicitationPrompt` in `stream-tool-handlers.ts`) now upsert by id. To recover, feed events through the dispatch in `stream-event-handler.ts` (cases at ~172-179), mapping DTO `id` → `toolCallId` (approval/question) or `interactionId` (elicitation) and carrying `remainingMs`. New fields: `ToolCallPart.approvalRemainingMs`, `ElicitationPart.startedAt/remainingMs`.
- Client test scoping: use `pnpm --filter @dorkos/client exec vitest run <path>` (the `test -- --run <path>` form does NOT path-filter). The 2 `route-error-fallback` failures on the full bare-vitest run are the known `import.meta.env.DEV` gotcha — use `pnpm test -- --run` for the authoritative full gate.
