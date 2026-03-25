---
title: 'Task List 10x: Rich Task Panel with Dependencies & Polling'
---

# Task List 10x: Rich Task Panel with Dependencies & Polling

**Date:** 2026-03-23
**Status:** Approved
**Area:** Client — `features/chat/ui/` and `features/chat/model/`

## Overview

Rebuild the `TaskListPanel` from a minimal flat list into a rich, compact heads-up display for agent task progress. The current panel shows only status icons and subject text — this redesign surfaces dependencies, descriptions, ownership, elapsed time, and progress visualization while keeping the same compact footprint.

## Goals

- **Active monitoring first**: Optimized for watching a running agent — scannable at a glance, detailed on demand
- **Progressive disclosure**: Default view is clean status + subject; clicking expands to full context
- **Dependency awareness**: Sort by blocked state, dim blocked tasks, hover highlights relationships
- **Live refresh**: Poll tasks when background refresh is enabled so subagent updates appear automatically
- **Clean architecture**: Extract focused sub-components from the current monolith

## Non-Goals

- No schema changes to `TaskItem` or `TaskUpdateEvent`
- No server changes or new API endpoints
- No dedicated task sidebar or dashboard — stays in the compact chat panel strip
- No server-side timestamp tracking
- No drag-and-drop reordering or manual task creation

## Component Architecture

The monolithic `TaskListPanel` (145 lines) is replaced with focused components:

```
TaskListPanel (orchestrator — same public interface)
├── TaskProgressHeader        — progress bar + "3/7 tasks" + collapse toggle
├── TaskActiveForm            — blue spinner + active form text
└── TaskRow[]                 — individual task with expand/collapse + hover behavior
    └── TaskDetail            — expanded accordion content (description, deps, owner, time)
```

### File Structure

```
features/chat/ui/
├── TaskListPanel.tsx          — orchestrator (renders header + active form + list)
├── TaskProgressHeader.tsx     — progress bar + counts + chevron
├── TaskRow.tsx                — single task row with expand/collapse, hover dep highlights
├── TaskDetail.tsx             — expanded detail content (description, metadata row)
├── TaskActiveForm.tsx         — active form indicator (extracted from current)
```

### Hooks

```
features/chat/model/
├── use-task-state.ts          — existing hook, extended with polling + status timestamps + taskMap exposure
├── use-elapsed-time.ts        — new hook, ticks to update relative time display

shared/model/
├── use-tab-visibility.ts      — new hook, extracted from use-chat-session.ts (cross-feature)
```

### FSD Placement

All components remain in `features/chat/` — they are chat-panel-specific, not shared. No new barrels needed; existing `features/chat/index.ts` exports `TaskListPanel` (unchanged public interface).

## Detailed Design

### 1. Task Sorting & Dependency Visualization

**Sort order** (top to bottom):

1. `in_progress` — bold, full color (what's happening now)
2. `pending` + unblocked — normal text (what can start next)
3. `pending` + blocked — dimmed `text-muted-foreground/50` (waiting on dependencies)
4. `completed` — dimmed + strikethrough (done)

A task is "blocked" when its `blockedBy` array contains any ID whose corresponding task has `status !== 'completed'`.

**Blocked detection function:**

```typescript
function isTaskBlocked(task: TaskItem, taskMap: Map<string, TaskItem>): boolean {
  if (!task.blockedBy?.length) return false;
  return task.blockedBy.some((depId) => {
    const dep = taskMap.get(depId);
    return dep && dep.status !== 'completed';
  });
}
```

**Sorting lives in `useTaskState`**: The hook exposes the full `taskMap` and performs the 4-tier sort internally using `isTaskBlocked`. The `TaskState` interface is extended:

```typescript
export interface TaskState {
  tasks: TaskItem[]; // Sorted by 4-tier order, capped to MAX_VISIBLE
  taskMap: Map<string, TaskItem>; // Full map for dependency lookups in UI
  activeForm: string | null;
  isCollapsed: boolean;
  toggleCollapse: () => void;
  handleTaskEvent: (event: TaskUpdateEvent) => void;
  statusTimestamps: Map<string, { status: TaskStatus; since: number }>;
}
```

**Hover interaction:**

- Hovering a task sets `hoveredTaskId` state in `TaskListPanel`
- `TaskRow` receives pre-computed `isHighlightedAsDep` and `isHighlightedAsDependent` booleans (computed by the orchestrator from `hoveredTaskId` + `taskMap`), keeping `TaskRow` simple:
  - `isHighlightedAsDep === true` → `border-l-2 border-blue-400` (this task is a dependency of the hovered task)
  - `isHighlightedAsDependent === true` → `border-l-2 border-amber-400` (this task is blocked by the hovered task)
- The hovered task itself gets a subtle `bg-muted/50` background
- Mouse leave clears `hoveredTaskId`

### 2. Progress Header (`TaskProgressHeader`)

Replaces the current text-only header.

**Layout:**

```
[▸/▾] [████████░░░░░░░░░░] 3/7 tasks
```

- **Chevron**: Collapse/expand toggle (`ChevronRight` / `ChevronDown`)
- **Progress bar**: 2px height, `rounded-full`
  - Fill: `bg-blue-500` while tasks remain, `bg-green-500` when all complete
  - Track: `bg-muted`
  - Width: `(completed / total) * 100%`
  - Animated: `transition-all duration-300 ease-out`
- **Count**: `"3/7 tasks"` in `text-xs text-muted-foreground`
- No `ListTodo` icon — the progress bar itself identifies the section

**Props:**

```typescript
interface TaskProgressHeaderProps {
  tasks: TaskItem[];
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}
```

### 3. Task Row (`TaskRow`)

Each task rendered as a clickable row with expand/collapse.

**Collapsed state** (default):

```
[status-icon] Task subject text
```

- Status icons unchanged: `Loader2` (spinning, blue) for `in_progress`, `Circle` (muted) for `pending`, `CheckCircle2` (green) for `completed`
- Blocked pending tasks: dimmed to `text-muted-foreground/50`
- `in_progress` tasks: `font-medium text-foreground`
- `completed` tasks: `text-muted-foreground/50 line-through`
- Click anywhere on the row to expand/collapse
- Celebration animation preserved (shimmer + spring-pop on completion)

**Accessibility:** Each row has `role="button"`, `aria-expanded={isExpanded}`, `tabIndex={0}`, and handles Enter/Space keydown to toggle expansion.

**Props:**

```typescript
interface TaskRowProps {
  task: TaskItem;
  isBlocked: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onHover: (taskId: string | null) => void;
  isHighlightedAsDep: boolean; // This task is a dep of hovered task
  isHighlightedAsDependent: boolean; // This task is blocked by hovered task
  statusSince: number | null;
  isCelebrating: boolean;
  onCelebrationComplete?: () => void;
}
```

Note: 11 props is high but acceptable for React components where props ARE the options object. The hover highlights are pre-computed booleans (not raw `taskMap` + `hoveredTaskId`) to keep `TaskRow` a pure display component.

### 4. Task Detail (`TaskDetail`)

Accordion-expanded content shown below the task subject when clicked.

**Content:**

```
  Description text here (if present)

  ⏱ 45s  ·  main  ·  ← Task 1, Task 2
```

**Metadata row** — single line of `text-[11px] text-muted-foreground` with `·` separators:

- **Elapsed time**: Relative time since entering current status
  - `in_progress`: `"12s"`, `"2m 30s"` (ticks every second)
  - `completed`: `"done 2m ago"` (ticks every minute)
  - `pending`: `"waiting 1m"` (ticks every minute)
- **Owner**: Agent name from `task.owner` (omitted if not present)
- **Dependencies** (if `blockedBy` or `blocks` present):
  - `← Task 1, Task 2` (blocked by — uses task subjects, truncated)
  - `→ Task 5` (blocks)
  - Clicking a dependency reference scrolls to and briefly highlights that task in the list. Implementation: `TaskRow` renders `data-task-id={task.id}` attributes; `onScrollToTask` uses `querySelector('[data-task-id="X"]')` + `scrollIntoView({ behavior: 'smooth' })` with a transient `bg-blue-500/10` class that fades after 1s via `setTimeout`. Only works for tasks within the visible `MAX_VISIBLE` slice.

**Description**: `task.description` rendered as `text-xs text-muted-foreground` with `whitespace-pre-wrap`. Omitted if not present.

**Only one task expanded at a time** — expanding a new task collapses the previous one. Managed via `expandedTaskId` state in `TaskListPanel`.

**Props:**

```typescript
interface TaskDetailProps {
  task: TaskItem;
  taskMap: Map<string, TaskItem>;
  statusSince: number | null;
  onScrollToTask: (taskId: string) => void;
}
```

**Animation:** `motion` with `initial={{ opacity: 0, height: 0 }}` / `animate={{ opacity: 1, height: 'auto' }}` / `exit={{ opacity: 0, height: 0 }}` — consistent with existing panel animations.

### 5. Task Polling

Extend `useTaskState` to poll when background refresh is enabled.

**Signature change:** `useTaskState` gains an `isStreaming` parameter. The caller (`ChatPanel`) already has `status` from `useChatSession` and can derive `isStreaming = status === 'streaming'`:

```typescript
export function useTaskState(sessionId: string | null, isStreaming: boolean): TaskState {
```

**Changes to `useTaskState`:**

```typescript
const enableMessagePolling = useAppStore((s) => s.enableMessagePolling);
const isTabVisible = useTabVisibility(); // from shared/model/use-tab-visibility.ts

const { data: initialTasks } = useQuery({
  queryKey: ['tasks', sessionId, selectedCwd],
  queryFn: () => transport.getTasks(sessionId!, selectedCwd ?? undefined),
  staleTime: 30_000,
  refetchOnWindowFocus: false,
  enabled: !!sessionId,
  refetchInterval: () => {
    if (!enableMessagePolling) return false;
    if (isStreaming) return false; // SSE handles real-time during streaming
    return isTabVisible
      ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS // 3s
      : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS; // 10s
  },
});
```

**Key details:**

- `isStreaming` passed as parameter from `ChatPanel` (which derives it from `useChatSession().status`)
- Disabled during streaming (SSE `task_update` events are real-time)
- Uses same `QUERY_TIMING` constants as message polling — one mental model
- ETag-based: server returns 304 when todo file unchanged, so polling is cheap

**Tab visibility:** Extract `useTabVisibility()` to `shared/model/use-tab-visibility.ts`. The same visibility pattern already exists in `use-chat-session.ts`, `use-document-title.ts`, and `use-idle-detector.ts` — this extraction eliminates duplication. Update `use-chat-session.ts` to consume the shared hook.

### 6. Elapsed Time Tracking

Client-side only — no server changes.

**Status timestamp map** in `useTaskState`:

```typescript
const statusTimestampsRef = useRef<Map<string, { status: TaskStatus; since: number }>>(new Map());
```

Updated whenever:

- A task first appears (record `Date.now()`)
- A task changes status (record `Date.now()`)
- Tasks are reloaded from API (reset all timestamps)

**`useElapsedTime` hook:**

```typescript
function useElapsedTime(since: number | null, tickInterval: number = 1000): string {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (since === null) return;
    const id = setInterval(() => setNow(Date.now()), tickInterval);
    return () => clearInterval(id);
  }, [since, tickInterval]);

  if (since === null) return '';
  return formatElapsed(now - since);
}
```

- `in_progress` tasks tick every 1s (active timer feel)
- `pending` and `completed` tasks tick every 60s (low overhead)
- Timestamps reset on page reload — they represent "time since you've been watching," not absolute history
- `useElapsedTime` is only used inside `TaskDetail`, which is gated to a single expanded task — so at most one 1-second interval runs at any time

**`formatElapsed` utility:** Pure duration formatter — `formatElapsed(ms: number): string` returns `"12s"`, `"2m 30s"`, `"1h 5m"`. The status prefix ("done", "waiting") is added by `TaskDetail` based on `task.status`, not by `formatElapsed`.

## Testing Strategy

### Unit Tests

- `TaskProgressHeader`: Renders correct bar width and count for various task distributions (0/5, 3/5, 5/5). Bar color switches to green when all complete.
- `TaskRow`: Correct styling for each status + blocked combination. Hover sets/clears correctly. Celebration animation triggers.
- `TaskDetail`: Renders description when present, omits when absent. Metadata row shows correct items. Dependency click calls `onScrollToTask`.
- `isTaskBlocked`: Returns correct blocked state for various dependency scenarios (no deps, all deps complete, some incomplete, circular refs).
- `sortTasks` (updated): Correct ordering across all four groups.

### Integration Tests

- `useTaskState` with polling: Verify `refetchInterval` returns correct values based on `enableMessagePolling`, `isStreaming`, and tab visibility.
- Expand/collapse: Only one task expanded at a time. Expanding a new task collapses the previous.
- `useElapsedTime`: Verify it ticks and formats correctly.

### Modified Tests

- Existing `TaskListPanel` tests in `AssistantMessageContent.test.tsx`: The public component interface (props) is unchanged, but header text assertions (e.g., `/3 tasks/`, `/1 done/`) need updating to match the new `"3/7 tasks"` format and progress bar.
- Celebration system tests preserved — animation triggers via same `celebratingTaskId` prop.

## Edge Cases

- **No dependencies**: `blockedBy` and `blocks` are optional. When absent, tasks sort by status only and hover highlighting is a no-op.
- **Circular dependencies**: Treated as all blocked. `isTaskBlocked` only checks one level (does not walk the graph).
- **10+ tasks**: `MAX_VISIBLE` cap preserved. Overflow count shown in header. Expansion still works for visible tasks.
- **Empty task list**: `TaskListPanel` returns `null` (unchanged).
- **Streaming + polling**: Polling disabled during streaming to avoid races between SSE overlay and API fetch.
- **Tab visibility**: Polling slows to 10s when tab is backgrounded, stops when streaming.

## Migration Notes

- `TaskListPanel` keeps the same props interface — `ChatPanel` doesn't change
- The celebration system (`celebratingTaskId`, `onCelebrationComplete`) carries forward into `TaskRow`
- The `activeForm` indicator is extracted to `TaskActiveForm` but rendered in the same position
- No breaking changes to any external interface

## Files Changed

### New Files

| File                                                     | Purpose                                      |
| -------------------------------------------------------- | -------------------------------------------- |
| `features/chat/ui/TaskProgressHeader.tsx`                | Progress bar + count + collapse toggle       |
| `features/chat/ui/TaskRow.tsx`                           | Individual task with expand/collapse + hover |
| `features/chat/ui/TaskDetail.tsx`                        | Expanded accordion content                   |
| `features/chat/ui/TaskActiveForm.tsx`                    | Active form indicator (extracted)            |
| `features/chat/model/use-elapsed-time.ts`                | Relative time tick hook + `formatElapsed`    |
| `shared/model/use-tab-visibility.ts`                     | Tab visibility hook (cross-feature)          |
| `features/chat/ui/__tests__/TaskProgressHeader.test.tsx` | Header tests                                 |
| `features/chat/ui/__tests__/TaskRow.test.tsx`            | Row tests                                    |
| `features/chat/ui/__tests__/TaskDetail.test.tsx`         | Detail tests                                 |
| `features/chat/model/__tests__/use-elapsed-time.test.ts` | Elapsed time hook tests                      |

### Modified Files

| File                                                                  | Changes                                                        |
| --------------------------------------------------------------------- | -------------------------------------------------------------- |
| `features/chat/ui/TaskListPanel.tsx`                                  | Full rewrite — orchestrator for new sub-components             |
| `features/chat/model/use-task-state.ts`                               | Add `isStreaming` param, polling, status timestamps, `taskMap` |
| `features/chat/model/use-chat-session.ts`                             | Replace inline visibility with shared `useTabVisibility` hook  |
| `features/chat/ui/__tests__/TaskListPanel.test.tsx`                   | Updated for new component structure                            |
| `features/chat/ui/message/__tests__/AssistantMessageContent.test.tsx` | Update header text assertions for new format                   |

### Unchanged

| File                             | Why                            |
| -------------------------------- | ------------------------------ |
| `ChatPanel.tsx`                  | Same `TaskListPanel` interface |
| `packages/shared/src/schemas.ts` | No schema changes              |
| Server routes/services           | No server changes              |
| `build-task-event.ts`            | Streaming path unchanged       |
