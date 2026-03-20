# Subagent Lifecycle Visibility — Task Breakdown

**Spec:** `specs/subagent-lifecycle-visibility/02-specification.md`
**Generated:** 2026-03-16
**Mode:** Full decomposition

---

## Phase 1: Schema + Server (Foundation)

### Task 1.1 — Add shared schemas for subagent lifecycle events and SubagentPart

**Size:** Medium | **Priority:** High | **Dependencies:** None

Add the three subagent lifecycle event schemas (`SubagentStartedEventSchema`, `SubagentProgressEventSchema`, `SubagentDoneEventSchema`), the `SubagentPartSchema` message part type, and all type re-exports to the shared package.

**Files:**

- `packages/shared/src/schemas.ts` — Add 3 enum values to `StreamEventTypeSchema`, 3 event schemas, 3 event schemas to `StreamEventSchema` data union, `SubagentPartSchema` + add to `MessagePartSchema` discriminated union
- `packages/shared/src/types.ts` — Add 4 type re-exports (`SubagentStartedEvent`, `SubagentProgressEvent`, `SubagentDoneEvent`, `SubagentPart`)

---

### Task 1.2 — Add server event mapping and SDK scenario builders with tests

**Size:** Large | **Priority:** High | **Dependencies:** 1.1

Add three mapping branches to `sdk-event-mapper.ts` for `task_started`, `task_progress`, `task_notification` system subtypes. Add SDK scenario builders and create a dedicated mapper test file.

**Files:**

- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — 3 new mapping branches after `system/init` check
- `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts` — 3 new builders (`sdkTaskStarted`, `sdkTaskProgress`, `sdkTaskNotification`)
- `apps/server/src/services/runtimes/claude-code/__tests__/sdk-event-mapper.test.ts` — NEW: 6 test cases for mapper
- `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.test.ts` — 3 new builder tests

---

## Phase 2: Client Integration

### Task 2.1 — Add subagent event handling to stream-event-handler.ts

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 2.2

Add three switch cases (`subagent_started`, `subagent_progress`, `subagent_done`) to the client's stream event handler. Add `findSubagentPart` helper. Update `deriveFromParts` to skip SubagentParts.

**Files:**

- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — New imports, `findSubagentPart` helper, 3 switch cases, `deriveFromParts` update

---

### Task 2.2 — Create SubagentBlock.tsx component

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 2.1

Create the `SubagentBlock` collapsible inline component with `formatDuration`, `buildToolSummary` helpers, status icons, AnimatePresence expand/collapse, and `toolStatus` CVA integration.

**Files:**

- `apps/client/src/layers/features/chat/ui/SubagentBlock.tsx` — NEW: Full component implementation

---

### Task 2.3 — Add SubagentBlock dispatch in AssistantMessageContent.tsx

**Size:** Small | **Priority:** High | **Dependencies:** 2.1, 2.2

Add SubagentBlock rendering branch in the `AssistantMessageContent` parts iteration, before the `AutoHideToolCall` fallback.

**Files:**

- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` — Import + dispatch branch for `part.type === 'subagent'`

---

### Task 2.4 — Add SubagentBlock component tests

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.2 | **Parallel with:** 2.3

Create component tests covering running/complete/error states, tool summary formatting, expand/collapse behavior, lastToolName visibility rules, and formatDuration via rendered output.

**Files:**

- `apps/client/src/layers/features/chat/ui/__tests__/SubagentBlock.test.tsx` — NEW: ~12 test cases

---

## Phase 3: Verification

### Task 3.1 — Run full verification and update API documentation

**Size:** Small | **Priority:** Medium | **Dependencies:** 2.3, 2.4

Run `pnpm typecheck`, `pnpm lint`, `pnpm test -- --run`. Update `contributing/api-reference.md` to include the three new event types in the SSE events list.

**Files:**

- `contributing/api-reference.md` — Add `subagent_started`, `subagent_progress`, `subagent_done` to event types list

---

## Dependency Graph

```
1.1 ─────────────┬──────────────────────────────┐
                 │                              │
                 v                              v
1.2              2.1 ◄──── parallel ────► 2.2
                 │                         │   │
                 │                         │   v
                 │                         │  2.4 (parallel with 2.3)
                 │                         │
                 v                         v
                2.3 ◄─── depends on ──── 2.1, 2.2
                 │
                 v
                3.1 ◄─── depends on ──── 2.3, 2.4
```

## Summary

| Phase                  | Tasks | Parallel Opportunities    |
| ---------------------- | ----- | ------------------------- |
| P1: Schema + Server    | 2     | None (1.2 depends on 1.1) |
| P2: Client Integration | 4     | 2.1 ∥ 2.2; 2.3 ∥ 2.4      |
| P3: Verification       | 1     | None (final gate)         |
| **Total**              | **7** | **2 parallel pairs**      |
