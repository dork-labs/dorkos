# Task Breakdown: system-status-compact-boundary

**Spec**: `specs/system-status-compact-boundary/02-specification.md`
**Generated**: 2026-03-16
**Mode**: Full

---

## Phase 1: Foundation

### Task 1.1 — Add system_status and compact_boundary event schemas to shared package

**Size**: Small | **Priority**: High | **Dependencies**: None

Add two new SSE event types (`system_status`, `compact_boundary`) and their Zod schemas to `packages/shared/src/schemas.ts`, plus type re-exports in `types.ts`.

**Files modified**:

- `packages/shared/src/schemas.ts` — Add to `StreamEventTypeSchema` enum, add `SystemStatusEventSchema` and `CompactBoundaryEventSchema`, add both to `StreamEventSchema` data union
- `packages/shared/src/types.ts` — Add `SystemStatusEvent` and `CompactBoundaryEvent` type re-exports

**Acceptance criteria**:

- `StreamEventTypeSchema` includes both new types
- `SystemStatusEventSchema` validates `{ message: string }`
- `CompactBoundaryEventSchema` validates `{}`
- Types are exported from `@dorkos/shared/types`
- TypeScript compiles cleanly

---

## Phase 2: Server Mapper

### Task 2.1 — Map SDK system/status and system/compact_boundary messages in sdk-event-mapper

**Size**: Medium | **Priority**: High | **Dependencies**: 1.1

Add two branches to the system message dispatch block in `sdk-event-mapper.ts` to translate SDK `system/status` (ephemeral operational messages) and `system/compact_boundary` (compaction marker) into DorkOS stream events.

**Files modified**:

- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — Add `status` and `compact_boundary` subtype handling
- `apps/server/src/services/runtimes/claude-code/__tests__/sdk-event-mapper.test.ts` — Add new describe block with 4 tests, update existing unknown-subtype test

**Acceptance criteria**:

- `system/status` with text yields `system_status` event
- `system/status` without text yields nothing
- `system/compact_boundary` yields `compact_boundary` event with empty data
- Existing unknown-subtype test updated (was using `'status'` which is now known)
- All mapper tests pass

---

## Phase 3: Client Stream Handler

### Task 3.1 — Add system_status and compact_boundary handlers to client stream-event-handler

**Size**: Large | **Priority**: High | **Dependencies**: 1.1

This is the largest task, touching three client files plus updating all existing stream-event-handler test files.

**Files modified**:

- `apps/client/src/layers/shared/lib/constants.ts` — Add `SYSTEM_STATUS_DISMISS_MS: 4_000` to TIMING
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Add `setSystemStatus` to deps interface, add `system_status` and `compact_boundary` switch cases, clear status on `done`
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Add `systemStatus` state, auto-clear timer with 4s debounce, pass into handler deps, return from hook
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-status.test.ts` — New test file
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-error.test.ts` — Add `setSystemStatus: vi.fn()` to deps
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-part-id.test.ts` — Add `setSystemStatus: vi.fn()` to deps
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-remap.test.ts` — Add `setSystemStatus: vi.fn()` to deps
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-thinking.test.ts` — Add `setSystemStatus: vi.fn()` to deps

**Acceptance criteria**:

- `system_status` calls `setSystemStatus` with message text
- `compact_boundary` injects ChatMessage with `messageType: 'compaction'`
- `done` clears systemStatus to null
- Auto-clear timer dismisses after 4s, resets on new message
- All existing tests pass with updated deps
- New test file covers both event types

---

## Phase 4: UI Integration

### Task 4.1 — Create SystemStatusZone component and wire into ChatPanel

**Size**: Medium | **Priority**: High | **Dependencies**: 3.1

Create the ephemeral status display component and integrate it into the chat layout.

**Files created**:

- `apps/client/src/layers/features/chat/ui/SystemStatusZone.tsx` — AnimatePresence + motion.div with Info icon and message text
- `apps/client/src/layers/features/chat/ui/__tests__/SystemStatusZone.test.tsx` — 3 test cases

**Files modified**:

- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — Import SystemStatusZone, destructure `systemStatus` from useChatSession, render between message area and CelebrationOverlay

**Acceptance criteria**:

- Renders nothing when message is null
- Shows message with Info icon and muted styling when present
- Animate in/out with opacity + height (0.2s)
- Positioned between message list and task panel in ChatPanel
- No new component needed for compact_boundary (reuses existing UserMessageContent)
- Full test suite passes
- TypeScript compiles

---

## Dependency Graph

```
1.1 (schemas)
 ├── 2.1 (server mapper)
 └── 3.1 (client handler)
       └── 4.1 (UI)
```

Tasks 2.1 and 3.1 can run in parallel after 1.1 completes.

## Total Estimated Changes

| File                                                 | Change                                    | ~Lines   |
| ---------------------------------------------------- | ----------------------------------------- | -------- |
| `packages/shared/src/schemas.ts`                     | 2 enum values, 2 schemas, 2 union members | ~20      |
| `packages/shared/src/types.ts`                       | 2 type re-exports                         | ~2       |
| `apps/server/.../sdk-event-mapper.ts`                | 2 system message branches                 | ~20      |
| `apps/server/.../__tests__/sdk-event-mapper.test.ts` | New describe + update existing            | ~50      |
| `apps/client/.../constants.ts`                       | 1 timing constant                         | ~2       |
| `apps/client/.../stream-event-handler.ts`            | 2 switch cases, 1 dep, 1 import           | ~25      |
| `apps/client/.../use-chat-session.ts`                | State, timer, wrapper, return             | ~25      |
| `apps/client/.../SystemStatusZone.tsx`               | New component                             | ~30      |
| `apps/client/.../ChatPanel.tsx`                      | Import + wire + render                    | ~5       |
| Test files (new + updates)                           | 2 new + 4 updated                         | ~80      |
| **Total**                                            |                                           | **~260** |
