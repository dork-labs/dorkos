---
slug: background-task-visibility
number: 177
created: 2026-03-24
status: ideation
---

# Background Task Visibility

**Slug:** background-task-visibility
**Author:** Claude Code
**Date:** 2026-03-24

---

## 1) Intent & Assumptions

- **Task brief:** Refactor the existing background agent indicator into a generic background task system that supports both background agents (subagents) and background bash commands. The unified `BackgroundTaskBar` renders agent runners alongside bash task dots in a single bar, with an expandable detail panel showing chip-style rows with command/description, duration, and kill buttons. Background bash tasks only appear after running for 5 seconds to avoid UI churn. Kill is instant for bash, with inline "Stop?" confirmation for agents. The `stopTask` capability is added to the `AgentRuntime` interface for runtime-agnostic extensibility.

- **Assumptions:**
  - The SDK emits `task_started`, `task_progress`, `task_notification` system messages for both subagents and background bash commands. Discrimination approach: subagent tasks include a `session_id` field (the child session), while bash tasks do not. If the SDK does not provide a reliable discriminator, we fall back to heuristic detection — tasks with a `description` matching agent patterns (launched via the Agent tool) are typed `'agent'`, all others default to `'bash'`. This assumption must be validated against real SDK payloads during implementation before the mapper is finalized.
  - The existing `AgentRunner` SVG animation, `AgentRunnerBurst` particle effects, and `agent-runner.css` keyframes are unchanged — only their parent container changes
  - The `SubagentBlock` inline message renderer changes its prop type but not its rendering logic
  - All consumers of `SubagentPart` are internal to the monorepo — no external API contract to maintain
  - The SDK's `query.stopTask(taskId)` method is available for killing background tasks
  - The `DirectTransport` (Obsidian embedded mode) will also gain `stopTask` via its `DirectTransportServices` interface

- **Out of scope:**
  - Agent Teams (experimental, different coordination model)
  - `/loop` scheduled tasks (session-scoped, not task-scoped)
  - Cloud/Desktop scheduled tasks (run outside sessions)
  - Click-to-scroll-to-task behavior (follow-up)
  - Task output streaming in the detail panel (follow-up — show stdout/stderr)

## 2) Pre-reading Log

- `apps/client/src/layers/features/chat/ui/RunningAgentIndicator.tsx`: Persistent indicator bar rendering up to 4 animated agent runners with overflow badge and aggregate stats. Mount point between ChatInput and ChatStatusSection.
- `apps/client/src/layers/features/chat/ui/AgentRunner.tsx`: 250-line animated SVG running figure (22×24px) with three phases: running → celebrating → done. Colored per-agent via CSS custom property.
- `apps/client/src/layers/features/chat/ui/AgentRunnerBurst.tsx`: 8-particle celebration burst on completion. CSS-driven animation.
- `apps/client/src/layers/features/chat/ui/agent-runner.css`: Complex CSS keyframe animations for body bounce, limb rotation, check-in, and burst particles.
- `apps/client/src/layers/features/chat/model/use-running-subagents.ts`: Derives running agents from message stream via useMemo. Stable color assignment via Map. 1500ms celebration window before removal.
- `apps/client/src/layers/features/chat/model/stream-tool-handlers.ts`: Contains `handleSubagentStarted`, `handleSubagentProgress`, `handleSubagentDone` — mutates SubagentPart entries during streaming.
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`: Calls `useRunningSubagents(messages)`, passes result to ChatInputContainer.
- `apps/client/src/layers/features/chat/ui/ChatInputContainer.tsx`: Renders `<RunningAgentIndicator agents={runningAgents} />` at line 283.
- `packages/shared/src/schemas.ts`: `SubagentPart` (lines 553-566), `SubagentStartedEvent`, `SubagentProgressEvent`, `SubagentDoneEvent`.
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`: Maps SDK system messages to `subagent_started/progress/done` SSE events.
- `packages/shared/src/agent-runtime.ts`: `AgentRuntime` interface — no `stopTask` method exists yet.
- `contributing/animations.md`: Motion library patterns, `AnimatePresence` for enter/exit, spring configs.
- `contributing/design-system.md`: Calm Tech philosophy — sophisticated animation for functional purposes is acceptable.
- `contributing/state-management.md`: Zustand for UI state, TanStack Query for server state. Derived state via useMemo.

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/features/chat/ui/RunningAgentIndicator.tsx` → becomes `BackgroundTaskBar.tsx`
- `apps/client/src/layers/features/chat/ui/AgentRunner.tsx` — unchanged, reparented
- `apps/client/src/layers/features/chat/ui/AgentRunnerBurst.tsx` — unchanged
- `apps/client/src/layers/features/chat/model/use-running-subagents.ts` → becomes `use-background-tasks.ts`
- `apps/client/src/layers/features/chat/model/stream-tool-handlers.ts` — handlers renamed
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — updated hook call
- `apps/client/src/layers/features/chat/ui/ChatInputContainer.tsx` — updated prop name
- `apps/client/src/layers/features/chat/ui/SubagentBlock.tsx` — prop type change

**Shared Dependencies:**

- `motion/react` — AnimatePresence, motion.div for expand/collapse and enter/exit
- `@dorkos/shared/types` — BackgroundTask type (replaces SubagentPart)
- `@dorkos/shared/schemas` — BackgroundTask Zod schema and SSE event schemas
- `@dorkos/shared/transport` — Transport interface gains `stopTask` method

**Data Flow:**

```
SDK task events → server sdk-event-mapper (distinguishes agent vs bash) →
  SSE stream (background_task_started/progress/done) →
    client stream-tool-handlers (creates/updates BackgroundTask in message.parts) →
      messages state update → ChatPanel re-render →
        useBackgroundTasks(messages) derives visible tasks (with 5s bash threshold) →
          BackgroundTaskBar renders:
            AgentRunnerSection (running figures for agent tasks)
            TaskDotSection (pulsing dots for bash tasks)
            ExpandToggle (chevron + count)
            TaskDetailPanel (expanded chip list with kill buttons)

Kill flow:
  User clicks × → (bash: instant, agent: "Stop?" confirm) →
    transport.stopTask(sessionId, taskId) →
      POST /api/sessions/:id/tasks/:taskId/stop →
        runtime.stopTask(sessionId, taskId) →
          SDK query.stopTask(taskId) →
            TaskNotification { status: 'stopped' } flows back through SSE
```

**Potential Blast Radius:**

- **New files (6):**
  - `features/chat/ui/BackgroundTaskBar.tsx` — shell component (replaces RunningAgentIndicator)
  - `features/chat/ui/TaskDotSection.tsx` — pulsing dots for bash tasks
  - `features/chat/ui/TaskDetailPanel.tsx` — expandable chip list
  - `features/chat/ui/TaskDetailRow.tsx` — single row with kill button
  - `features/chat/ui/InlineKillButton.tsx` — × with "Stop?" confirm for agents
  - `features/chat/model/use-background-tasks.ts` — unified hook (replaces use-running-subagents)
- **Modified files (15):**
  - `packages/shared/src/schemas.ts` — replace SubagentPart/events with BackgroundTask/events; update `StreamEventType` enum (`subagent_*` → `background_task_*`)
  - `packages/shared/src/types.ts` — export BackgroundTask type
  - `packages/shared/src/agent-runtime.ts` — add `stopTask` method
  - `packages/shared/src/transport.ts` — add `stopTask` to Transport interface
  - `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — emit `background_task_*` events, distinguish agent vs bash by payload
  - `apps/server/src/routes/sessions.ts` — add stopTask endpoint
  - `apps/client/src/layers/shared/lib/transport/http-transport.ts` — implement `stopTask` HTTP call
  - `apps/client/src/layers/shared/lib/direct-transport.ts` — implement `stopTask` via `DirectTransportServices`
  - `apps/client/src/layers/features/chat/model/stream-tool-handlers.ts` — rename subagent handlers to background task handlers
  - `apps/client/src/layers/features/chat/model/stream-event-types.ts` — rename `findSubagentPart` to `findBackgroundTask` in `StreamHandlerHelpers`
  - `apps/client/src/layers/features/chat/model/stream-event-helpers.ts` — update SubagentPart references
  - `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — update handler dispatch
  - `apps/client/src/layers/features/chat/model/stream-history-helpers.ts` — handle both old `subagent_*` and new `background_task_*` events for backward compatibility with persisted JSONL transcripts
  - `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — updated hook call
  - `apps/client/src/layers/features/chat/ui/ChatInputContainer.tsx` — updated prop
  - `apps/client/src/layers/features/chat/ui/SubagentBlock.tsx` — prop type change to BackgroundTask
  - `apps/client/src/layers/features/chat/ui/AssistantMessageContent.tsx` — update subagent type references
- **Deleted files (2):**
  - `features/chat/ui/RunningAgentIndicator.tsx` — replaced by BackgroundTaskBar
  - `features/chat/model/use-running-subagents.ts` — replaced by use-background-tasks
- **Test files — migrated (3):**
  - `RunningAgentIndicator.test.tsx` → `BackgroundTaskBar.test.tsx`
  - `use-running-subagents.test.ts` → `use-background-tasks.test.ts`
  - `tagged-dedup.test.ts` — update subagent type references
- **Test files — new (3):**
  - `TaskDetailPanel.test.tsx`
  - `InlineKillButton.test.tsx`
  - Server stopTask endpoint test

## 4) Root Cause Analysis

N/A — this is a new feature combined with a refactoring of an existing system.

## 5) Research

**BackgroundTask data model:**

```typescript
type BackgroundTaskType = 'agent' | 'bash';
type BackgroundTaskStatus = 'running' | 'complete' | 'error' | 'stopped';

interface BackgroundTask {
  taskId: string;
  type: BackgroundTaskType;
  status: BackgroundTaskStatus;
  startedAt: number; // timestamp ms — new field, enables 5s threshold

  // Agent-specific (populated when type === 'agent')
  description?: string; // "Explore codebase patterns"
  toolUses?: number;
  lastToolName?: string;
  summary?: string;

  // Bash-specific (populated when type === 'bash')
  command?: string; // "npm run dev"

  // Shared
  durationMs?: number;
}
```

This replaces the existing `SubagentPart` which had: `type: 'subagent'`, `taskId`, `description`, `status` ('running'|'complete'|'error'), `toolUses?`, `lastToolName?`, `durationMs?`, `summary?`. The new type adds: `startedAt`, `command`, the `'stopped'` status, and the `type` discriminator for agent vs bash.

**Background task types in Claude Code SDK:**

The Claude Agent SDK emits three system message subtypes for background tasks:

- `task_started` — with `task_id`, `session_id`, `description` (agents) or `command` (bash)
- `task_progress` — with `task_id`, `usage.tool_uses`, `last_tool_name`, `usage.duration_ms`
- `task_notification` — with `task_id`, `status` ('completed'|'failed'|'stopped'), `summary`

The SDK provides `query.stopTask(taskId)` for killing background tasks. When stopped, a `task_notification` with `status: 'stopped'` is emitted.

**Known SDK issues with task stopping:**

- Orphaned tasks possible if task IDs aren't properly tracked
- Background agent resume can create retry loops if agent is still running
- Stopping a dev server or long-running process is irreversible (no resume)
- Race condition: if a task completes between the user clicking "Stop?" and the request reaching the SDK, the stop is a no-op — the completion notification will have already arrived via SSE

**REST endpoint shape:**

```
POST /api/sessions/:sessionId/tasks/:taskId/stop
Request body: (empty)
Response 200: { success: true, taskId: string }
Response 404: { error: 'Task not found' }
Response 409: { error: 'Task already stopped' }
```

**JSONL backward compatibility:**

Persisted JSONL transcripts from before this change contain `subagent_started`, `subagent_progress`, `subagent_done` events. The `stream-history-helpers.ts` reader must recognize both old-format events (mapping them to `BackgroundTask` with `type: 'agent'`) and new-format `background_task_*` events. This ensures loading old sessions preserves background task history.

**Timer lifecycle for bash threshold:**

The 1-second `setInterval` for re-evaluating pending bash tasks runs only when there are bash tasks below the 5-second threshold. It is cleared on unmount via `useEffect` cleanup and also cleared when no pending bash tasks remain (to avoid unnecessary re-renders during idle periods).

**Keyboard accessibility:**

The expand toggle and kill buttons must be keyboard-operable (`tabIndex`, `onKeyDown` for Enter/Space). The "Stop?" confirmation auto-dismisses after 3s but remains focusable while visible. The bar maintains `role="status"` and `aria-live="polite"` from the existing indicator.

**Animation approach:** CSS keyframes for the existing agent runners (unchanged). New bash task dots use CSS `@keyframes pulse` for the pulsing effect. Expand/collapse uses Motion `AnimatePresence` with height animation.

## 6) Decisions

| #   | Decision                       | Choice                                                                          | Rationale                                                                                                                                      |
| --- | ------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Architecture approach          | Generic task system (refactor)                                                  | Cleanest long-term architecture. Only two task types now but the system is designed for extensibility. Courage to refactor per project values. |
| 2   | Data model                     | Single flat `BackgroundTask` interface with optional fields per type            | Union adds ceremony without safety gains — UI already branches on `type` for rendering.                                                        |
| 3   | Display threshold              | 5-second fixed delay for bash tasks only                                        | Filters UI churn from quick commands. Agents show immediately (user explicitly launched them).                                                 |
| 4   | Threshold implementation       | Client-side timer re-evaluating pending tasks every 1s                          | No server involvement needed. `startedAt` timestamp on the event enables client calculation.                                                   |
| 5   | Kill interaction               | Instant for bash, inline "Stop?" confirm for agents                             | Bash is low-stakes (like Ctrl+C). Agents represent significant token spend and work-in-progress.                                               |
| 6   | Kill confirmation UX           | × morphs to "Stop?" label, 3s auto-dismiss                                      | Discoverable, accessible, no modal interruption. Inspired by common inline-confirm patterns.                                                   |
| 7   | Kill API surface               | `AgentRuntime.stopTask()` + `Transport.stopTask()` + REST endpoint              | Runtime-agnostic — future runtimes can implement their own stop mechanism.                                                                     |
| 8   | Visual layout                  | Unified bar — agent runners + separator + bash dots + expand toggle             | Single bar, single mental model. Expand reveals chip-style detail rows for all tasks.                                                          |
| 9   | `'stopped'` as distinct status | Yes, separate from `'error'`                                                    | "User intentionally stopped" is semantically different from "task failed."                                                                     |
| 10  | Migration strategy             | Big bang swap, no deprecation                                                   | All consumers internal. TypeScript compiler catches missed references. Existing tests as safety net.                                           |
| 11  | Color assignment               | Shared pool across both types                                                   | Both agents and bash tasks draw from the same 5-color palette. Stable assignment via Map ref.                                                  |
| 12  | FSD layer placement            | `features/chat/ui/` and `features/chat/model/`                                  | Co-located with existing chat indicator code. Background tasks are chat-session-scoped.                                                        |
| 13  | JSONL backward compatibility   | History reader handles both old `subagent_*` and new `background_task_*` events | Old sessions must remain loadable. The reader maps old events to `BackgroundTask` with `type: 'agent'`.                                        |
| 14  | SDK type discrimination        | Presence of `session_id` → agent; absence → bash; fallback to heuristic         | Must be validated against real SDK payloads during implementation. Fallback prevents breakage if SDK shape is unexpected.                      |
| 15  | Obsidian embedded mode         | `DirectTransportServices` gains `stopTask` method                               | Parity with `HttpTransport`. `DirectTransport` delegates to the runtime method directly.                                                       |
