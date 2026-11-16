# Background Task Visibility — Task Breakdown

**Spec:** `specs/background-task-visibility/01-ideation.md`
**Generated:** 2026-03-24
**Mode:** Full decomposition

---

## Overview

Refactor the existing subagent-only indicator into a generic background task system supporting both background agents and background bash commands. Unified `BackgroundTaskBar` replaces `RunningAgentIndicator`, with expandable detail panel, kill controls, and a 5-second visibility threshold for bash tasks.

**Total tasks:** 21
**Phases:** 7

---

## Phase 1: Foundation (3 tasks)

Shared schemas, types, AgentRuntime interface, Transport interface, REST endpoint.

| ID  | Task                                                            | Size   | Priority | Dependencies | Parallel |
| --- | --------------------------------------------------------------- | ------ | -------- | ------------ | -------- |
| 1.1 | Add BackgroundTask schema and SSE event types to shared package | medium | high     | —            | 1.2, 1.3 |
| 1.2 | Add stopTask to AgentRuntime and Transport interfaces           | small  | high     | —            | 1.1, 1.3 |
| 1.3 | Add stopTask REST endpoint to server sessions router            | small  | high     | —            | 1.1, 1.2 |

### 1.1 — Add BackgroundTask schema and SSE event types to shared package

Replace `SubagentPart`, `SubagentStartedEvent`, `SubagentProgressEvent`, `SubagentDoneEvent` in `packages/shared/src/schemas.ts` with:

- `BackgroundTaskTypeSchema` (`'agent' | 'bash'`)
- `BackgroundTaskStatusSchema` (`'running' | 'complete' | 'error' | 'stopped'`)
- `BackgroundTaskPartSchema` (discriminator: `type: 'background_task'`)
- `BackgroundTaskStartedEventSchema`, `BackgroundTaskProgressEventSchema`, `BackgroundTaskDoneEventSchema`

Update `StreamEventTypeSchema` enum (`subagent_*` -> `background_task_*`), `MessagePartSchema` discriminated union, `StreamEventSchema` data union. Update `types.ts` re-exports.

### 1.2 — Add stopTask to AgentRuntime and Transport interfaces

- `AgentRuntime.stopTask(sessionId, taskId): Promise<boolean>`
- `Transport.stopTask(sessionId, taskId): Promise<{ success: boolean; taskId: string }>`

### 1.3 — Add stopTask REST endpoint to server sessions router

`POST /api/sessions/:sessionId/tasks/:taskId/stop` — delegates to `runtime.stopTask()`. Returns 200/404/409.

---

## Phase 2: Server (2 tasks)

SDK event mapper changes and ClaudeCodeRuntime implementation.

| ID  | Task                                                                            | Size   | Priority | Dependencies | Parallel |
| --- | ------------------------------------------------------------------------------- | ------ | -------- | ------------ | -------- |
| 2.1 | Update SDK event mapper to emit background_task events with type discrimination | medium | high     | 1.1          | 2.2      |
| 2.2 | Implement stopTask in ClaudeCodeRuntime                                         | small  | high     | 1.2          | 2.1      |

### 2.1 — Update SDK event mapper

Replace `subagent_started/progress/done` emissions with `background_task_started/progress/done`. Discrimination: `session_id` present and different from parent -> `'agent'`; otherwise -> `'bash'`.

### 2.2 — Implement stopTask in ClaudeCodeRuntime

Delegates to `session.query.stopTask(taskId)`. Returns false if no active query. Catches and logs errors.

---

## Phase 3: Client Core (3 tasks)

Stream handlers, hook, and transport implementations.

| ID  | Task                                                            | Size   | Priority | Dependencies | Parallel |
| --- | --------------------------------------------------------------- | ------ | -------- | ------------ | -------- |
| 3.1 | Update stream-tool-handlers for background task events          | medium | high     | 1.1          | 3.2      |
| 3.2 | Implement useBackgroundTasks hook replacing useRunningSubagents | medium | high     | 1.1          | 3.1      |
| 3.3 | Implement stopTask in HttpTransport and DirectTransport         | small  | high     | 1.2, 1.3     | 3.1, 3.2 |

### 3.1 — Update stream-tool-handlers

Rename handlers: `handleSubagentStarted` -> `handleBackgroundTaskStarted`, etc. Update `StreamHandlerHelpers.findSubagentPart` -> `findBackgroundTask`. Update `stream-event-handler.ts` switch cases. Create `BackgroundTaskPart` with `type: 'background_task'`, `taskType`, `startedAt`.

### 3.2 — Implement useBackgroundTasks hook

New `use-background-tasks.ts` replaces `use-running-subagents.ts`. Key additions:

- 5-second bash visibility threshold with 1s interval timer
- `'stopped'` status handling
- `VisibleTask` interface with both agent and bash fields

### 3.3 — Implement stopTask in transports

- `HttpTransport`: `POST /api/sessions/:id/tasks/:taskId/stop`
- `DirectTransport`: delegates to `services.runtime.stopTask()`
- Mock transport in test-utils: `vi.fn()` stub

---

## Phase 4: Client UI (5 tasks)

New components and integration.

| ID  | Task                                                         | Size   | Priority | Dependencies  | Parallel      |
| --- | ------------------------------------------------------------ | ------ | -------- | ------------- | ------------- |
| 4.1 | Create BackgroundTaskBar shell component                     | large  | high     | 3.1, 3.2      | 4.2, 4.3, 4.4 |
| 4.2 | Create TaskDotSection component for bash task dots           | small  | medium   | 3.2           | 4.1, 4.3, 4.4 |
| 4.3 | Create TaskDetailPanel and TaskDetailRow components          | medium | medium   | 3.2           | 4.1, 4.2, 4.4 |
| 4.4 | Create InlineKillButton with confirmation                    | small  | medium   | —             | 4.1, 4.2, 4.3 |
| 4.5 | Wire BackgroundTaskBar into ChatPanel and ChatInputContainer | medium | high     | 3.2, 3.3, 4.1 | —             |

### 4.1 — BackgroundTaskBar

Unified bar: agent runners + separator + bash dots + expand toggle. Replaces `RunningAgentIndicator`. Uses `AgentRunner` (unchanged), `TaskDotSection`, `TaskDetailPanel`. Expand/collapse with `AnimatePresence`.

### 4.2 — TaskDotSection

Pulsing colored dots for bash tasks. CSS `@keyframes task-dot-pulse` animation. Motion enter/exit.

### 4.3 — TaskDetailPanel + TaskDetailRow

Expandable chip list. Each row: color dot, type badge, label (description/command), tool count, duration, kill button. Height animation via Motion.

### 4.4 — InlineKillButton

Instant for bash, "Stop?" confirmation for agents. 3s auto-dismiss. Keyboard accessible (Enter/Space).

### 4.5 — Wire into ChatPanel/ChatInputContainer

- `ChatPanel`: `useBackgroundTasks(messages)` + `transport.stopTask()` callback
- `ChatInputContainer`: `<BackgroundTaskBar>` replaces `<RunningAgentIndicator>`

---

## Phase 5: Migration & Cleanup (3 tasks)

| ID  | Task                                                                    | Size   | Priority | Dependencies  | Parallel |
| --- | ----------------------------------------------------------------------- | ------ | -------- | ------------- | -------- |
| 5.1 | Update SubagentBlock and AssistantMessageContent for BackgroundTaskPart | small  | high     | 1.1           | 5.2, 5.3 |
| 5.2 | Add JSONL backward compatibility in stream-history-helpers              | small  | high     | 1.1           | 5.1, 5.3 |
| 5.3 | Delete old files and clean up all remaining SubagentPart references     | medium | high     | 4.5, 5.1, 5.2 | —        |

### 5.1 — Update SubagentBlock

Prop type: `SubagentPart` -> `BackgroundTaskPart`. Handle `'stopped'` status. Fallback label for bash tasks. `AssistantMessageContent`: check `part.type === 'background_task'`.

### 5.2 — JSONL backward compatibility

`stream-history-helpers.ts` `migratePart()` function: converts legacy `type: 'subagent'` parts to `type: 'background_task'` with `taskType: 'agent'`.

### 5.3 — Delete old files and clean up

Delete `RunningAgentIndicator.tsx`, `use-running-subagents.ts`. Codebase-wide search for zero remaining references. Update barrel exports. Full `pnpm typecheck` and `pnpm lint`.

---

## Phase 6: Testing (4 tasks)

| ID  | Task                                                        | Size   | Priority | Dependencies | Parallel      |
| --- | ----------------------------------------------------------- | ------ | -------- | ------------ | ------------- |
| 6.1 | Migrate RunningAgentIndicator and useRunningSubagents tests | large  | medium   | 4.5, 5.3     | 6.2, 6.3      |
| 6.2 | Add tests for InlineKillButton and TaskDetailPanel          | medium | medium   | 4.3, 4.4     | 6.1, 6.3      |
| 6.3 | Add server stopTask endpoint test                           | small  | medium   | 1.3, 2.2     | 6.1, 6.2      |
| 6.4 | Fix existing tests broken by SubagentPart removal           | large  | high     | 5.3          | 6.1, 6.2, 6.3 |

### 6.1 — Migrate existing tests

`RunningAgentIndicator.test.tsx` -> `BackgroundTaskBar.test.tsx`. `use-running-subagents.test.ts` -> `use-background-tasks.test.ts`. Update mock data shapes. Add bash threshold and mixed-type test cases. Update `tagged-dedup.test.ts`.

### 6.2 — New component tests

`InlineKillButton.test.tsx`: instant bash kill, agent two-step, 3s auto-dismiss, keyboard accessibility.
`TaskDetailPanel.test.tsx`: row rendering, type badges, kill callback routing, completed task styling.

### 6.3 — Server endpoint test

`POST /api/sessions/:id/tasks/:taskId/stop`: 200 success, 409 already stopped, 404 session not found, 400 invalid ID. Uses `FakeAgentRuntime`.

### 6.4 — Fix broken existing tests

Update all test files referencing `SubagentPart`, `subagent_*` events, `RunningAgent`, `RunningAgentIndicator`. Ensure `FakeAgentRuntime` and `createMockTransport` include `stopTask`.

---

## Phase 7: Documentation (1 task)

| ID  | Task                                                   | Size  | Priority | Dependencies | Parallel |
| --- | ------------------------------------------------------ | ----- | -------- | ------------ | -------- |
| 7.1 | Create ADR for generic background task system decision | small | low      | 5.3          | —        |

### 7.1 — ADR

Document the decision to replace the subagent-specific system with a generic background task system. Update `decisions/manifest.json` and `contributing/api-reference.md` (new stopTask endpoint).

---

## Dependency Graph

```
Phase 1 (parallel):
  1.1 ──┬──> 2.1 ──> (feeds into 3.1)
        ├──> 3.1 ──┐
        ├──> 3.2 ──┤
        ├──> 5.1   │
        └──> 5.2   │
  1.2 ──┬──> 2.2   │
        └──> 3.3 ──┤
  1.3 ──┬──> 3.3   │
        └──> 6.3   │
                    │
Phase 4:            │
  4.4 (no deps) ────┤
  4.2 ──────────────┤
  4.3 ──────────────┤
  4.1 ──────────────┤
                    v
  4.5 ──> 5.3 ──> 6.1, 6.4 ──> 7.1
```

## Critical Path

1.1 -> 3.1 -> 4.1 -> 4.5 -> 5.3 -> 6.4 -> 7.1
