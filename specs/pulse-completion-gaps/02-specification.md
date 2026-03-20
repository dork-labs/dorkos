---
slug: pulse-completion-gaps
number: 46
created: 2026-02-21
status: draft
---

# Specification: Pulse Implementation Completion Gaps

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-21
**Related Spec:** [Pulse Scheduler](../pulse-scheduler/02-specification.md) (#43)

## Overview

Resolve four completion gaps discovered during a Pulse scheduler feature audit. These are finishing touches on an already-implemented feature — no architectural changes, no new endpoints, no data model changes. The four gaps are independent and ordered by impact: (1) a functional bug where scheduled agents lack runtime context, (2) a missing edit button in the UI, (3) missing client-side test coverage, and (4) incomplete MCP handler test coverage.

## Background / Problem Statement

The Pulse scheduler feature was implemented across server, client, shared schemas, and transport layers. A completeness audit revealed four gaps:

1. **`buildPulseAppend` never called** — `scheduler-service.ts` exports a function that builds context telling the agent it's running as an unattended scheduled job, but `executeRun()` never calls it. Agents dispatched by Pulse operate identically to interactive sessions, potentially asking questions or waiting for input that will never come.

2. **No edit button in PulsePanel** — The `CreateScheduleDialog` fully supports edit mode (pre-fills form, shows "Edit Schedule" title, routes submit to `useUpdateSchedule`), and `PulsePanel` maintains `editSchedule` state, but no button triggers it. Users must delete and recreate schedules to change them.

3. **No client-side tests** — Zero test files exist for the 5 entity hooks (`useSchedules`, `useCreateSchedule`, `useUpdateSchedule`, `useDeleteSchedule`, `useTriggerSchedule`, `useRuns`, `useRun`, `useCancelRun`) or the 3 UI components (`PulsePanel`, `CreateScheduleDialog`, `RunHistoryPanel`).

4. **MCP handler behavior untested** — `mcp-tool-server.test.ts` verifies tool registration (8 tools with correct names) but doesn't test the 5 Pulse handler factories (`createListSchedulesHandler`, `createCreateScheduleHandler`, `createUpdateScheduleHandler`, `createDeleteScheduleHandler`, `createGetRunHistoryHandler`) or the `requirePulse()` guard.

## Goals

- Scheduled Pulse runs inject runtime context so agents know they're unattended
- Users can edit existing schedules via an inline edit button
- All Pulse client hooks and components have test coverage
- All MCP Pulse handlers have behavior tests including guard checks
- All existing tests continue to pass

## Non-Goals

- New Pulse features (run output viewing, schedule templates, recurring failure handling)
- Changes to Pulse data model, API endpoints, or shared schemas
- E2E or integration tests
- Changes to `CreateScheduleDialog` or `RunHistoryPanel` (both already work correctly)

## Technical Dependencies

- No new external libraries required
- Existing dependencies: `lucide-react` (Pencil icon), `@testing-library/react`, `vitest`

## Detailed Design

### Gap 1: Wire `buildPulseAppend` into Scheduled Runs

**Problem:** `buildPulseAppend()` at `scheduler-service.ts:31-46` builds context but `executeRun()` at line 214 calls `sendMessage()` without it.

**Approach:** Add generic `systemPromptAppend?: string` to `sendMessage()` opts. This is reusable for any future caller that needs to inject additional system context.

#### 1a. Extend `SchedulerAgentManager` interface

In `apps/server/src/services/scheduler-service.ts` (lines 6-17):

```typescript
export interface SchedulerAgentManager {
  ensureSession(
    sessionId: string,
    opts: { permissionMode: PermissionMode; cwd?: string; hasStarted?: boolean }
  ): void;
  sendMessage(
    sessionId: string,
    content: string,
    opts?: { permissionMode?: PermissionMode; cwd?: string; systemPromptAppend?: string }
  ): AsyncGenerator<StreamEvent>;
}
```

Change: Add `systemPromptAppend?: string` to the `opts` type.

#### 1b. Update `AgentManager.sendMessage()`

In `apps/server/src/services/agent-manager.ts` (around line 71):

```typescript
async *sendMessage(
  sessionId: string,
  content: string,
  opts?: { permissionMode?: PermissionMode; cwd?: string; systemPromptAppend?: string }
): AsyncGenerator<StreamEvent> {
```

At line 97 where the system prompt append is built:

```typescript
const baseAppend = await buildSystemPromptAppend(effectiveCwd);
const systemPromptAppend = opts?.systemPromptAppend
  ? `${baseAppend}\n\n${opts.systemPromptAppend}`
  : baseAppend;
```

Then use `systemPromptAppend` (instead of the current `systemPromptAppend` variable name which already matches) in `sdkOptions.systemPrompt.append`.

#### 1c. Call `buildPulseAppend()` in `executeRun()`

In `apps/server/src/services/scheduler-service.ts`, in `executeRun()` around line 214:

```typescript
const pulseContext = buildPulseAppend(schedule, run);

const stream = this.agentManager.sendMessage(sessionId, schedule.prompt, {
  permissionMode,
  cwd: schedule.cwd ?? undefined,
  systemPromptAppend: pulseContext,
});
```

#### 1d. Update scheduler-service test mock

In `apps/server/src/services/__tests__/scheduler-service.test.ts`, update the mock `sendMessage` to accept and optionally verify the new `systemPromptAppend` opt.

**Files modified:**

- `apps/server/src/services/scheduler-service.ts` — Interface + `executeRun()` call
- `apps/server/src/services/agent-manager.ts` — `sendMessage()` signature + append merge
- `apps/server/src/services/__tests__/scheduler-service.test.ts` — Mock update

---

### Gap 2: Add Edit Button to PulsePanel

**Problem:** `PulsePanel.tsx` has `editSchedule` state (line 39) and passes it to `CreateScheduleDialog` (lines 152-156), but no button sets it.

**Approach:** Add a `Pencil` icon button in the non-`pending_approval` action area alongside "Run Now" and the toggle switch.

#### 2a. Add edit button

In `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx`, add import:

```typescript
import { Pencil } from 'lucide-react';
```

In the non-`pending_approval` action div (around lines 105-115), add between "Run Now" and the toggle:

```tsx
<button
  className="hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md p-1 text-xs transition-colors"
  aria-label={`Edit ${schedule.name}`}
  onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setEditSchedule(schedule);
    setDialogOpen(true);
  }}
>
  <Pencil className="size-3.5" />
</button>
```

Key details:

- `e.stopPropagation()` prevents the row's expand/collapse toggle
- `aria-label` for accessibility (icon-only button)
- Placed in the non-`pending_approval` branch only
- No changes to `CreateScheduleDialog` — it already handles edit mode

**Files modified:**

- `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx` — Import + button addition

---

### Gap 3: Client-Side Pulse Tests

**Problem:** Zero test files for Pulse entity hooks or UI components.

**Approach:** Comprehensive tests for all 8 hooks/components following established patterns from `use-sessions.test.tsx` and `ChatPanel.test.tsx`.

#### 3a. Add mock factories to shared test-utils

In `packages/test-utils/src/mock-factories.ts`, add:

```typescript
export function createMockSchedule(overrides: Partial<PulseSchedule> = {}): PulseSchedule {
  return {
    id: 'sched-1',
    name: 'Daily review',
    prompt: 'Review open PRs',
    cron: '0 9 * * 1-5',
    enabled: true,
    status: 'active',
    cwd: null,
    timezone: null,
    maxRuntime: null,
    permissionMode: 'acceptEdits',
    nextRun: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createMockRun(overrides: Partial<PulseRun> = {}): PulseRun {
  return {
    id: 'run-1',
    scheduleId: 'sched-1',
    sessionId: 'session-1',
    status: 'completed',
    trigger: 'scheduled',
    startedAt: new Date().toISOString(),
    completedAt: new Date(Date.now() + 60000).toISOString(),
    error: null,
    output: null,
    ...overrides,
  };
}
```

#### 3b. Entity hook tests

**File: `apps/client/src/layers/entities/pulse/__tests__/use-schedules.test.ts`**

Test cases for each of the 5 hooks:

- `useSchedules`: Fetches schedules via transport, handles loading/error states
- `useCreateSchedule`: Calls `transport.createSchedule()`, invalidates schedules query key
- `useUpdateSchedule`: Calls `transport.updateSchedule(id, input)`, invalidates schedules query key
- `useDeleteSchedule`: Calls `transport.deleteSchedule(id)`, invalidates schedules query key
- `useTriggerSchedule`: Calls `transport.triggerSchedule(id)`, invalidates **runs** query key (not schedules)

**File: `apps/client/src/layers/entities/pulse/__tests__/use-runs.test.ts`**

Test cases for each of the 3 hooks:

- `useRuns`: Fetches runs via transport, passes opts through, 10s refetch interval configured
- `useRun`: Fetches single run, disabled when `id` is null
- `useCancelRun`: Calls `transport.cancelRun(id)`, invalidates runs query key

**Test pattern** (following `use-sessions.test.tsx`):

```typescript
function createWrapper() {
  const queryClient = createTestQueryClient();
  const transport = createMockTransport();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { queryClient, transport, Wrapper };
}
```

Each test creates its own wrapper (no shared `QueryClient`). All use `retry: false` via `createTestQueryClient()`.

#### 3c. UI component tests

**File: `apps/client/src/layers/features/pulse/__tests__/PulsePanel.test.tsx`**

Test cases:

- Renders schedule list when data is available
- Shows loading state initially
- "New Schedule" button opens create dialog
- Edit button opens dialog in edit mode
- "Run Now" button calls `triggerSchedule`
- Toggle switch calls `updateSchedule` with enabled flag
- Approve button updates pending schedule to active
- Reject button deletes pending schedule
- Clicking schedule row expands/collapses run history

**File: `apps/client/src/layers/features/pulse/__tests__/CreateScheduleDialog.test.tsx`**

Test cases:

- Renders "New Schedule" title in create mode
- Renders "Edit Schedule" title when `editSchedule` is provided
- Pre-fills form fields in edit mode
- Submits create with correct payload
- Submits update with correct ID and payload in edit mode
- Shows cron human-readable preview
- Permission mode warning for `bypassPermissions`

**File: `apps/client/src/layers/features/pulse/__tests__/RunHistoryPanel.test.tsx`**

Test cases:

- Renders run list with status indicators
- Shows duration for completed runs
- Cancel button visible only for running jobs
- Clicking a run navigates to its session
- Shows loading state

**Component test pattern** (following `ChatPanel.test.tsx`):

```typescript
vi.mock('motion/react', () => ({
  motion: new Proxy({}, { get: (_, prop) => forwardRef(...) }),
  AnimatePresence: ({ children }) => <>{children}</>,
}));
```

Components rendered with full provider stack (QueryClient + Transport + any needed context).

#### 3d. Test file locations

```
apps/client/src/layers/entities/pulse/__tests__/
  use-schedules.test.ts
  use-runs.test.ts
apps/client/src/layers/features/pulse/__tests__/
  PulsePanel.test.tsx
  CreateScheduleDialog.test.tsx
  RunHistoryPanel.test.tsx
```

**Files modified:**

- `packages/test-utils/src/mock-factories.ts` — Add `createMockSchedule()`, `createMockRun()`
- 5 new test files (listed above)

---

### Gap 4: MCP Pulse Handler Behavior Tests

**Problem:** `mcp-tool-server.test.ts` tests registration (8 tools, correct names) but not handler logic.

**Approach:** Extend the existing test file with handler factory tests using the same pattern as `createGetSessionCountHandler` tests.

#### 4a. Add mock helpers

In `apps/server/src/services/__tests__/mcp-tool-server.test.ts`, add:

```typescript
import {
  createListSchedulesHandler,
  createCreateScheduleHandler,
  createUpdateScheduleHandler,
  createDeleteScheduleHandler,
  createGetRunHistoryHandler,
} from '../mcp-tool-server.js';

function makeMockPulseStore(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    getSchedules: vi.fn().mockReturnValue([]),
    getSchedule: vi.fn().mockReturnValue(null),
    createSchedule: vi.fn().mockReturnValue({ id: 'new-1', name: 'Test' }),
    updateSchedule: vi.fn().mockReturnValue(null),
    deleteSchedule: vi.fn().mockReturnValue(false),
    listRuns: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as McpToolDeps['pulseStore'];
}

function makePulseDeps(
  storeOverrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}
): McpToolDeps {
  return {
    ...makeMockDeps(),
    pulseStore: makeMockPulseStore(storeOverrides),
  };
}
```

#### 4b. Handler test suites

**`createListSchedulesHandler`:**

- Returns all schedules when Pulse enabled
- Filters to `enabled_only` when flag set
- Returns error when `pulseStore` undefined (requirePulse guard)
- Handles empty schedule list

**`createCreateScheduleHandler`:**

- Creates schedule and sets `pending_approval` status
- Returns created schedule with approval note
- Returns error when Pulse disabled

**`createUpdateScheduleHandler`:**

- Updates existing schedule
- Returns error for non-existent ID (store returns null)
- Handles `permissionMode` string conversion
- Returns error when Pulse disabled

**`createDeleteScheduleHandler`:**

- Deletes existing schedule, returns success
- Returns error for non-existent ID (store returns false)
- Returns error when Pulse disabled

**`createGetRunHistoryHandler`:**

- Returns runs with default limit (20)
- Respects custom limit parameter
- Returns error when Pulse disabled

**`requirePulse()` guard** (tested implicitly across all handlers):

- Every handler tested with `makeMockDeps()` (no `pulseStore`) → `isError: true`, error contains "not enabled"

**Files modified:**

- `apps/server/src/services/__tests__/mcp-tool-server.test.ts` — New imports, helpers, and test suites

---

## User Experience

- **Gap 1:** Invisible to users. Scheduled agents will behave more autonomously (no questions, decisive action).
- **Gap 2:** Users see a pencil icon on each schedule row. Clicking it opens the existing dialog in edit mode.
- **Gaps 3 & 4:** No user-visible changes. Developer confidence improvement.

## Testing Strategy

### Unit Tests (Gap 4 — MCP handlers)

Test each handler factory in isolation with mocked `PulseStore`. Invoke handlers directly (not through MCP server). ~20 test cases covering happy paths, error paths, and guard behavior.

### Component/Hook Tests (Gap 3 — Client)

Test entity hooks via `renderHook` with mock Transport. Test UI components at integration level (real hooks, mock Transport). ~30 test cases across 5 files.

### Existing Test Updates (Gap 1)

Update `scheduler-service.test.ts` mock to accept `systemPromptAppend` opt. Optionally add a test verifying `executeRun()` passes `buildPulseAppend()` output.

### Regression

Run full `npm test` to verify no existing tests break.

## Performance Considerations

None. Gap 1 adds one string concatenation per scheduled run. Gap 2 adds one icon button per schedule row. Gaps 3-4 are test-only.

## Security Considerations

None. No new user inputs, no new endpoints, no permission changes.

## Documentation

No documentation changes needed. These are internal completion tasks.

## Implementation Phases

### Phase 1: Gap 1 — Wire buildPulseAppend (functional fix)

1. Extend `SchedulerAgentManager` interface with `systemPromptAppend` opt
2. Update `AgentManager.sendMessage()` to merge caller append after base append
3. Call `buildPulseAppend()` in `executeRun()` and pass via new opt
4. Update scheduler-service test mock

### Phase 2: Gap 2 — Add edit button (UX fix)

1. Import `Pencil` from `lucide-react` in `PulsePanel.tsx`
2. Add edit button with `stopPropagation` and state-setting handler

### Phase 3: Gap 4 — MCP handler tests (server test coverage)

1. Add `makeMockPulseStore()` and `makePulseDeps()` helpers
2. Import 5 handler factories
3. Write test suites for each handler + guard behavior

### Phase 4: Gap 3 — Client tests (client test coverage)

1. Add `createMockSchedule()` and `createMockRun()` to test-utils
2. Write entity hook tests (use-schedules, use-runs)
3. Write UI component tests (PulsePanel, CreateScheduleDialog, RunHistoryPanel)

## Open Questions

None. All clarifications resolved during ideation:

1. ~~**Generic vs Pulse-specific API**~~ (RESOLVED)
   **Answer:** Generic `systemPromptAppend` on `sendMessage()` opts — simpler and extensible.

2. ~~**Test depth**~~ (RESOLVED)
   **Answer:** Comprehensive tests for all 8 hooks/components.

3. ~~**Mock factory location**~~ (RESOLVED)
   **Answer:** Add to shared `packages/test-utils/src/mock-factories.ts`.

4. ~~**Priority order**~~ (RESOLVED)
   **Answer:** Gap 1 → Gap 2 → Gap 4 → Gap 3.

## Related ADRs

No existing ADRs reference Pulse. No new ADRs warranted — these are completion tasks using established patterns, not architectural decisions.

## References

- [Ideation Document](./01-ideation.md) — Full audit results and research
- [Pulse Scheduler Spec](../pulse-scheduler/02-specification.md) — Original feature specification
- [Research Artifacts](../../research/20260221_pulse_implementation_gaps.md) — Detailed research findings
