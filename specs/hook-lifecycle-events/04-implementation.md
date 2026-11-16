# Implementation Summary: Surface SDK Hook Lifecycle Events in Chat UI

**Created:** 2026-03-16
**Last Updated:** 2026-03-16
**Spec:** specs/hook-lifecycle-events/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 7 / 7

## Tasks Completed

### Session 1 - 2026-03-16

1. **[P1] Add hook lifecycle Zod schemas and event types to shared package** — Added `HookStartedEventSchema`, `HookProgressEventSchema`, `HookResponseEventSchema`, `HookPartSchema` to shared schemas. Extended `ToolCallPartSchema` with `hooks` field. Added type re-exports.

2. **[P2] Add hook lifecycle branches to sdk-event-mapper** — Added `TOOL_CONTEXTUAL_HOOK_EVENTS` constant and three routing branches. Tool-contextual hooks yield typed events; session-level hooks yield `system_status` or `error`. 9 unit tests.

3. **[P3] Add HookState type and hook handler cases to stream-event-handler** — Added `HookState` type alias, `orphanHooksRef` (Map-based), `findHookById` helper, three switch cases (`hook_started`, `hook_progress`, `hook_response`), orphan buffer drain on `tool_call_start`, `deriveFromParts` hooks propagation.

4. **[P3] Add stream-event-handler unit tests** — 12 tests covering hook_started (4), hook_progress (2), hook_response (3), orphan drain (3).

5. **[P4] Add HookRow component and hook rendering to ToolCallCard** — `HookRow` with 4 visual states (running/success/error/cancelled), auto-expand on error, expand/collapse with animation. 8 component tests.

6. **[P5] Add auto-hide suppression for tool cards with failed hooks** — Updated `useToolCallVisibility` and `AutoHideToolCall` in `AssistantMessageContent.tsx` to suppress auto-hide when any hook has `status === 'error'`. Passed `hooks` through to `ToolCallCard`.

7. **[P5] Update interactive-tools documentation** — Added "Hook Lifecycle Events" section to `contributing/interactive-tools.md` covering routing logic, orphan handling, visual states, and auto-hide suppression.

## Files Modified/Created

**Source files:**

- `packages/shared/src/schemas.ts` — 3 event schemas, HookPartSchema, ToolCallPartSchema hooks extension
- `packages/shared/src/types.ts` — Type re-exports
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — Hook routing branches
- `apps/client/src/layers/features/chat/model/chat-types.ts` — HookState type, ToolCallState hooks field
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Hook handler cases, orphan buffering
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — orphanHooksRef, re-exports
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx` — HookRow component
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` — Auto-hide suppression, hooks passthrough

**Test files:**

- `apps/server/src/services/runtimes/claude-code/__tests__/sdk-event-mapper.test.ts` — 9 hook tests
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-hooks.test.ts` — 12 handler tests
- `apps/client/src/layers/features/chat/ui/__tests__/ToolCallCard.test.tsx` — 8 hook component tests

**Documentation:**

- `contributing/interactive-tools.md` — Hook Lifecycle Events section

## Known Issues

None.

## Implementation Notes

### Deviation from Spec

- **orphanHooksRef**: Spec called for `HookState[]` (flat array). Implementation uses `Map<string, HookPart[]>` keyed by `toolCallId` for O(1) lookup on `tool_call_start`. This is a strict improvement.
- **HookState**: Spec defined a full interface. Implementation uses a type alias `export type HookState = HookPart` since the shapes are identical. Avoids duplication.

### Test Results

- All 2017 client tests passing (167 test files)
- TypeScript compilation clean across all packages
