---
slug: pulse-completion-gaps
spec: 46
created: 2026-02-21
lastDecompose: 2026-02-21
---

# Tasks: Pulse Implementation Completion Gaps

## Phase 1: Wire buildPulseAppend into Scheduled Runs (functional fix)

### Task 1.1: Extend sendMessage with systemPromptAppend opt

Add a generic `systemPromptAppend?: string` option to `AgentManager.sendMessage()` and the `SchedulerAgentManager` interface so any caller can inject additional system prompt context.

**Files:**

- `apps/server/src/services/scheduler-service.ts` — Add `systemPromptAppend?: string` to `SchedulerAgentManager.sendMessage()` opts type
- `apps/server/src/services/agent-manager.ts` — Update `sendMessage()` signature and merge caller append after base append

**Acceptance criteria:**

- `SchedulerAgentManager` interface opts include `systemPromptAppend?: string`
- `AgentManager.sendMessage()` accepts `systemPromptAppend` in opts
- When `systemPromptAppend` is provided, it is concatenated after the base `buildSystemPromptAppend()` output with `\n\n` separator
- When `systemPromptAppend` is not provided, behavior is identical to current
- Existing tests pass

### Task 1.2: Call buildPulseAppend in executeRun and update tests

Wire `buildPulseAppend()` into `SchedulerService.executeRun()` so scheduled agents receive unattended runtime context. Update the scheduler-service test mock.

**Files:**

- `apps/server/src/services/scheduler-service.ts` — In `executeRun()`, call `buildPulseAppend(schedule, run)` and pass result as `systemPromptAppend` opt to `sendMessage()`
- `apps/server/src/services/__tests__/scheduler-service.test.ts` — Update mock `sendMessage` to accept and verify the new `systemPromptAppend` opt

**Acceptance criteria:**

- `executeRun()` calls `buildPulseAppend(schedule, run)` before `sendMessage()`
- The result is passed as `systemPromptAppend` in `sendMessage()` opts
- Test mock updated to accept 3-arg opts with `systemPromptAppend`
- At least one test verifies `systemPromptAppend` contains "PULSE SCHEDULER CONTEXT"
- All existing scheduler-service tests pass

---

## Phase 2: Add Edit Button to PulsePanel (UX fix)

### Task 2.1: Add edit button to PulsePanel schedule rows

Add a Pencil icon button to each schedule row in PulsePanel that opens CreateScheduleDialog in edit mode.

**Files:**

- `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx` — Import Pencil icon, add edit button

**Implementation details:**

- Import `Pencil` from `lucide-react`
- Add button in the non-`pending_approval` action div, between "Run Now" and the toggle switch
- Button uses `e.stopPropagation()` to prevent row expand/collapse
- Button calls `setEditSchedule(schedule)` then `setDialogOpen(true)`
- `aria-label={`Edit ${schedule.name}`}` for accessibility
- Styling: `hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md p-1 text-xs transition-colors`
- Icon: `<Pencil className="size-3.5" />`

**Acceptance criteria:**

- Each non-pending schedule row has a pencil edit button
- Clicking edit button opens CreateScheduleDialog in edit mode with form pre-filled
- Clicking edit button does NOT expand/collapse the row
- No changes to CreateScheduleDialog (it already handles edit mode)

---

## Phase 3: MCP Pulse Handler Behavior Tests (server test coverage)

### Task 3.1: Add MCP Pulse handler behavior tests

Extend `mcp-tool-server.test.ts` with handler factory tests for all 5 Pulse handlers and the `requirePulse()` guard.

**Files:**

- `apps/server/src/services/__tests__/mcp-tool-server.test.ts` — New imports, mock helpers, and test suites

**Implementation details:**

Add imports:

```typescript
import {
  createListSchedulesHandler,
  createCreateScheduleHandler,
  createUpdateScheduleHandler,
  createDeleteScheduleHandler,
  createGetRunHistoryHandler,
} from '../mcp-tool-server.js';
```

Add mock helpers:

```typescript
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

Test suites for each handler:

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

- Every handler tested with `makeMockDeps()` (no `pulseStore`) returns `isError: true`, error contains "not enabled"

**Acceptance criteria:**

- ~20 test cases covering all 5 handler factories
- Every handler has at least one happy-path and one error-path test
- requirePulse guard tested for every handler (error when pulseStore undefined)
- All tests pass with `npx vitest run apps/server/src/services/__tests__/mcp-tool-server.test.ts`

---

## Phase 4: Client-Side Pulse Tests (client test coverage)

### Task 4.1: Add mock factories for Pulse types

Add `createMockSchedule()` and `createMockRun()` factory functions to the shared test-utils package.

**Files:**

- `packages/test-utils/src/mock-factories.ts` — Add two new factory functions

**Implementation:**

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

**Acceptance criteria:**

- Both factories exported from `packages/test-utils/src/mock-factories.ts`
- Import types `PulseSchedule` and `PulseRun` from `@dorkos/shared/types`
- Factories produce valid objects matching Zod schemas
- Overrides work for all fields

### Task 4.2: Add entity hook tests for Pulse schedules

Write tests for the 5 schedule-related entity hooks following established patterns from `use-sessions.test.tsx`.

**Files:**

- `apps/client/src/layers/entities/pulse/__tests__/use-schedules.test.ts` (new file)

**Test pattern:**

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

**Test cases:**

- `useSchedules`: Fetches schedules via transport, handles loading/error states
- `useCreateSchedule`: Calls `transport.createSchedule()`, invalidates schedules query key
- `useUpdateSchedule`: Calls `transport.updateSchedule(id, input)`, invalidates schedules query key
- `useDeleteSchedule`: Calls `transport.deleteSchedule(id)`, invalidates schedules query key
- `useTriggerSchedule`: Calls `transport.triggerSchedule(id)`, invalidates runs query key (not schedules)

**Acceptance criteria:**

- Each hook has at least one test verifying correct transport call
- Mutation hooks verify query invalidation
- Each test creates its own wrapper (no shared QueryClient)
- Tests pass with `npx vitest run apps/client/src/layers/entities/pulse/__tests__/use-schedules.test.ts`

### Task 4.3: Add entity hook tests for Pulse runs

Write tests for the 3 run-related entity hooks.

**Files:**

- `apps/client/src/layers/entities/pulse/__tests__/use-runs.test.ts` (new file)

**Test cases:**

- `useRuns`: Fetches runs via transport, passes opts through, 10s refetch interval configured
- `useRun`: Fetches single run, disabled when `id` is null
- `useCancelRun`: Calls `transport.cancelRun(id)`, invalidates runs query key

**Acceptance criteria:**

- Each hook has at least one test verifying correct transport call
- `useRuns` verifies refetch interval configuration
- `useRun` verifies disabled state when id is null
- Tests pass with `npx vitest run apps/client/src/layers/entities/pulse/__tests__/use-runs.test.ts`

### Task 4.4: Add PulsePanel component tests

Write component tests for PulsePanel following established patterns.

**Files:**

- `apps/client/src/layers/features/pulse/__tests__/PulsePanel.test.tsx` (new file)

**Mock requirements:**

```typescript
vi.mock('motion/react', () => ({
  motion: new Proxy({}, { get: (_, prop) => forwardRef(...) }),
  AnimatePresence: ({ children }) => <>{children}</>,
}));
```

**Test cases:**

- Renders schedule list when data is available
- Shows loading state initially
- "New Schedule" button opens create dialog
- Edit button opens dialog in edit mode (added in Phase 2)
- "Run Now" button calls `triggerSchedule`
- Toggle switch calls `updateSchedule` with enabled flag
- Approve button updates pending schedule to active
- Reject button deletes pending schedule
- Clicking schedule row expands/collapses run history

**Acceptance criteria:**

- Components rendered with full provider stack (QueryClient + Transport)
- All 9 test cases pass
- Tests pass with `npx vitest run apps/client/src/layers/features/pulse/__tests__/PulsePanel.test.tsx`

### Task 4.5: Add CreateScheduleDialog and RunHistoryPanel component tests

Write component tests for the remaining two UI components.

**Files:**

- `apps/client/src/layers/features/pulse/__tests__/CreateScheduleDialog.test.tsx` (new file)
- `apps/client/src/layers/features/pulse/__tests__/RunHistoryPanel.test.tsx` (new file)

**CreateScheduleDialog test cases:**

- Renders "New Schedule" title in create mode
- Renders "Edit Schedule" title when `editSchedule` is provided
- Pre-fills form fields in edit mode
- Submits create with correct payload
- Submits update with correct ID and payload in edit mode
- Shows cron human-readable preview
- Permission mode warning for `bypassPermissions`

**RunHistoryPanel test cases:**

- Renders run list with status indicators
- Shows duration for completed runs
- Cancel button visible only for running jobs
- Clicking a run navigates to its session
- Shows loading state

**Acceptance criteria:**

- All test cases pass
- Components rendered with full provider stack
- Tests pass with vitest
