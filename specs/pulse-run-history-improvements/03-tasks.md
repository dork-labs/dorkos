# Tasks: Pulse RunHistoryPanel Improvements & RunRow Navigation Bug Fix

**Spec:** `specs/pulse-run-history-improvements/02-specification.md`
**Created:** 2026-02-22

---

## Phase 1: Bug Fixes (Critical)

### Task 1.1: Fix RunRow navigation with `scheduleCwd` prop and directory-aware navigation

**Files to modify:**

- `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx`
- `apps/client/src/layers/features/pulse/ui/ScheduleRow.tsx`

**Changes:**

1. **`ScheduleRow.tsx`** — Pass `schedule.cwd` to RunHistoryPanel (line ~192):

```tsx
// Before
<RunHistoryPanel scheduleId={schedule.id} />

// After
<RunHistoryPanel scheduleId={schedule.id} scheduleCwd={schedule.cwd} />
```

2. **`RunHistoryPanel.tsx`** — Update Props interface:

```tsx
interface Props {
  scheduleId: string;
  scheduleCwd: string | null; // NEW: schedule's working directory
}
```

3. **`RunHistoryPanel.tsx`** — Import `useDirectoryState` from `@/layers/entities/session` and implement `handleNavigateToRun`:

```tsx
import { useSessionId, useDirectoryState } from '@/layers/entities/session';

export function RunHistoryPanel({ scheduleId, scheduleCwd }: Props) {
  const [, setActiveSession] = useSessionId();
  const [selectedCwd, setSelectedCwd] = useDirectoryState();

  // Navigate to run's session, setting directory if needed
  const handleNavigateToRun = useCallback(
    (sessionId: string) => {
      if (scheduleCwd && scheduleCwd !== selectedCwd) {
        // setSelectedCwd clears sessionId internally, so we need to
        // set directory first, then set session on next tick
        setSelectedCwd(scheduleCwd);
        // Use setTimeout(0) to let the directory state settle before setting session
        setTimeout(() => setActiveSession(sessionId), 0);
      } else {
        setActiveSession(sessionId);
      }
    },
    [scheduleCwd, selectedCwd, setSelectedCwd, setActiveSession]
  );
```

4. **`RunHistoryPanel.tsx`** — Replace `setActiveSession` with `handleNavigateToRun` in the RunRow render:

```tsx
// Before
onNavigate = { setActiveSession };

// After
onNavigate = { handleNavigateToRun };
```

Add `useCallback` to the import from `react`.

**Acceptance criteria:**

- Clicking a completed run row navigates to the correct session even when the schedule's `cwd` differs from the currently selected directory
- When `scheduleCwd` matches `selectedCwd`, navigation sets session directly without touching directory
- When `scheduleCwd` is null, navigation sets session directly

---

### Task 1.2: Update existing tests and add navigation tests

**Files to modify:**

- `apps/client/src/layers/features/pulse/__tests__/RunHistoryPanel.test.tsx`

**Changes:**

1. **Add mock for `useDirectoryState`** in the mock section:

```tsx
const mockSetDirectory = vi.fn();

vi.mock('@/layers/entities/session', () => ({
  useSessionId: vi.fn(() => [null, mockSetActiveSession]),
  useDirectoryState: vi.fn(() => ['/current-dir', mockSetDirectory]),
}));
```

2. **Update ALL existing `<RunHistoryPanel>` renders** to include `scheduleCwd`:

```tsx
// Before
<RunHistoryPanel scheduleId="sched-1" />

// After
<RunHistoryPanel scheduleId="sched-1" scheduleCwd={null} />
```

This applies to all 5 existing test cases.

3. **Add new test: navigation sets directory when schedule has different cwd**:

```tsx
it('navigates to schedule directory before setting session', async () => {
  const { useDirectoryState } = await import('@/layers/entities/session');
  vi.mocked(useDirectoryState).mockReturnValue(['/current-dir', mockSetDirectory]);

  const runs = [createMockRun({ id: 'run-1', status: 'completed', sessionId: 'session-abc' })];
  const transport = createMockTransport({
    listRuns: vi.fn().mockResolvedValue(runs),
  });
  const Wrapper = createWrapper(transport);

  render(
    <Wrapper>
      <RunHistoryPanel scheduleId="sched-1" scheduleCwd="/other-project" />
    </Wrapper>
  );

  await waitFor(() => {
    expect(screen.getByTitle('Completed')).toBeTruthy();
  });

  const row = screen.getByTitle('Completed').closest('[class*="cursor-pointer"]');
  fireEvent.click(row!);

  expect(mockSetDirectory).toHaveBeenCalledWith('/other-project');
  // Session set deferred via setTimeout
  await waitFor(() => {
    expect(mockSetActiveSession).toHaveBeenCalledWith('session-abc');
  });
});
```

4. **Add new test: navigation skips directory when same cwd**:

```tsx
it('does not change directory when schedule cwd matches current', async () => {
  const { useDirectoryState } = await import('@/layers/entities/session');
  vi.mocked(useDirectoryState).mockReturnValue(['/same-dir', mockSetDirectory]);

  const runs = [createMockRun({ id: 'run-1', status: 'completed', sessionId: 'session-abc' })];
  const transport = createMockTransport({
    listRuns: vi.fn().mockResolvedValue(runs),
  });
  const Wrapper = createWrapper(transport);

  render(
    <Wrapper>
      <RunHistoryPanel scheduleId="sched-1" scheduleCwd="/same-dir" />
    </Wrapper>
  );

  await waitFor(() => {
    expect(screen.getByTitle('Completed')).toBeTruthy();
  });

  const row = screen.getByTitle('Completed').closest('[class*="cursor-pointer"]');
  fireEvent.click(row!);

  expect(mockSetDirectory).not.toHaveBeenCalled();
  expect(mockSetActiveSession).toHaveBeenCalledWith('session-abc');
});
```

**Acceptance criteria:**

- All 5 existing tests pass with updated `scheduleCwd` prop
- New navigation tests verify directory-first and direct-session paths
- `mockSetDirectory` and `mockSetActiveSession` are cleared in `beforeEach`

---

## Phase 2: Accessibility & Feedback

### Task 2.1: Add ARIA attributes and keyboard support to RunRow

**Files to modify:**

- `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx`

**Changes:**

Update the RunRow `<div>` element (currently at line ~97) to include ARIA attributes:

```tsx
<div
  role={isClickable ? 'button' : undefined}
  tabIndex={isClickable ? 0 : undefined}
  aria-label={
    isClickable
      ? `View ${run.status} run from ${formatRelativeTime(run.startedAt ?? run.createdAt)}`
      : undefined
  }
  onClick={isClickable ? handleRowClick : undefined}
  onKeyDown={
    isClickable
      ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleRowClick();
          }
        }
      : undefined
  }
  className={cn(
    'grid grid-cols-[20px_56px_1fr_64px_72px_20px] items-center gap-2',
    'rounded-md border border-transparent px-2 py-2 text-xs transition-colors',
    isClickable && 'cursor-pointer hover:bg-muted/50 hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
    run.status === 'failed' && 'bg-destructive/5'
  )}
>
```

Key changes from current code:

- Add `role="button"` (conditional on `isClickable`)
- Add `tabIndex={0}` (conditional on `isClickable`)
- Add `aria-label` with descriptive text including status and relative time
- Add `e.preventDefault()` in the onKeyDown handler (prevents page scroll on Space)
- Add `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1` to className
- Remove the `// eslint-disable-next-line jsx-a11y/no-static-element-interactions` comment since the element now has proper `role`

**Acceptance criteria:**

- RunRow is focusable via Tab when it has a sessionId
- Enter and Space keys trigger navigation
- Focus ring is visible on keyboard focus but not on click
- Screen readers announce descriptive labels like "View completed run from 2 hours ago"
- Non-clickable rows (no sessionId) have no role, tabIndex, or aria-label

---

### Task 2.2: Add cancel toast feedback with sonner

**Files to modify:**

- `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx`

**Changes:**

1. Add import at top of file:

```tsx
import { toast } from 'sonner';
```

2. Update the `onCancel` handler in the RunRow render (currently line ~207):

```tsx
// Before
onCancel={(id) => cancelRun.mutate(id)}

// After
onCancel={(id) =>
  cancelRun.mutate(id, {
    onSuccess: () => toast('Run cancelled'),
    onError: (err) =>
      toast.error(`Failed to cancel: ${err instanceof Error ? err.message : 'Unknown error'}`),
  })
}
```

**Acceptance criteria:**

- Successful cancel shows "Run cancelled" toast
- Failed cancel shows error message in toast
- Toast matches existing sonner usage in ScheduleRow.tsx

---

## Phase 3: Filtering & Pagination

### Task 3.1: Add `status` filter to schema, server store, route, and transport

**Files to modify:**

- `packages/shared/src/schemas.ts`
- `apps/server/src/services/pulse-store.ts`
- `apps/server/src/routes/pulse.ts`
- `apps/client/src/layers/shared/lib/http-transport.ts`

**Changes:**

1. **`packages/shared/src/schemas.ts`** — Add `status` to `ListRunsQuerySchema`:

```typescript
export const ListRunsQuerySchema = z
  .object({
    scheduleId: z.string().optional(),
    status: PulseRunStatusSchema.optional(), // NEW
    limit: z.coerce.number().int().min(1).max(500).optional().default(50),
    offset: z.coerce.number().int().min(0).optional().default(0),
  })
  .openapi('ListRunsQuery');
```

2. **`apps/server/src/services/pulse-store.ts`** — Add `status` to `ListRunsOptions` interface and update `listRuns()` to use dynamic SQL:

```typescript
interface ListRunsOptions {
  scheduleId?: string;
  status?: string; // NEW
  limit?: number;
  offset?: number;
}
```

Replace the current `listRuns` method with dynamic query building:

```typescript
listRuns(opts: ListRunsOptions = {}): PulseRun[] {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  let sql = 'SELECT * FROM runs';
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (opts.scheduleId) {
    conditions.push('schedule_id = ?');
    params.push(opts.scheduleId);
  }
  if (opts.status) {
    conditions.push('status = ?');
    params.push(opts.status);
  }
  if (conditions.length) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = this.db.prepare(sql).all(...params) as RunRow[];
  return rows.map(mapRunRow);
}
```

Note: The `listRunsBySchedule` prepared statement is no longer needed since `listRuns` now handles all cases dynamically. However, keep it for backwards compatibility; it's harmless.

3. **`apps/server/src/routes/pulse.ts`** — Pass `status` through to store (line ~110):

```typescript
const runs = store.listRuns({
  scheduleId: result.data.scheduleId,
  status: result.data.status, // NEW
  limit: result.data.limit,
  offset: result.data.offset,
});
```

4. **`apps/client/src/layers/shared/lib/http-transport.ts`** — Add `status` param to `listRuns` (line ~298):

```typescript
listRuns(opts?: Partial<ListRunsQuery>): Promise<PulseRun[]> {
  const params = new URLSearchParams();
  if (opts?.scheduleId) params.set('scheduleId', opts.scheduleId);
  if (opts?.status) params.set('status', opts.status);   // NEW
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();
```

**Acceptance criteria:**

- `GET /api/pulse/runs?status=failed` returns only failed runs
- `GET /api/pulse/runs?scheduleId=X&status=running` returns only running runs for schedule X
- Zod validates status against `PulseRunStatusSchema` (rejects invalid values with 400)
- Transport passes status param in URL query string

---

### Task 3.2: Add status filter Select UI and "Load more" pagination

**Files to modify:**

- `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx`

**Changes:**

1. Add imports:

```tsx
import { useState, useEffect, useCallback } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/layers/shared/ui';
```

2. Add state variables inside `RunHistoryPanel`:

```tsx
const [statusFilter, setStatusFilter] = useState<string>('all');
const [offset, setOffset] = useState(0);
const LIMIT = 20;
```

3. Update `useRuns` call:

```tsx
const { data: runs = [], isLoading } = useRuns({
  scheduleId,
  limit: LIMIT,
  offset,
  ...(statusFilter !== 'all' && { status: statusFilter }),
});
```

4. Add accumulated runs state for pagination:

```tsx
const [allRuns, setAllRuns] = useState<PulseRun[]>([]);

useEffect(() => {
  if (offset === 0) {
    setAllRuns(runs);
  } else {
    setAllRuns((prev) => [...prev, ...runs]);
  }
}, [runs, offset]);

// Reset offset when filter changes
useEffect(() => {
  setOffset(0);
}, [statusFilter]);
```

5. Add filter UI above the run list (before the column headers):

```tsx
<div className="mb-2 flex items-center justify-between">
  <span className="text-muted-foreground text-xs font-medium">Run History</span>
  <Select value={statusFilter} onValueChange={setStatusFilter}>
    <SelectTrigger className="h-6 w-[120px] text-xs">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="all">All statuses</SelectItem>
      <SelectItem value="running">Running</SelectItem>
      <SelectItem value="completed">Completed</SelectItem>
      <SelectItem value="failed">Failed</SelectItem>
      <SelectItem value="cancelled">Cancelled</SelectItem>
    </SelectContent>
  </Select>
</div>
```

6. Render `allRuns` instead of `runs` in the map, and add "Load more" button:

```tsx
{
  allRuns.map((run) => (
    <RunRow
      key={run.id}
      run={run}
      onNavigate={handleNavigateToRun}
      onCancel={(id) =>
        cancelRun.mutate(id, {
          onSuccess: () => toast('Run cancelled'),
          onError: (err) =>
            toast.error(
              `Failed to cancel: ${err instanceof Error ? err.message : 'Unknown error'}`
            ),
        })
      }
      isCancelling={cancelRun.isPending}
    />
  ));
}
{
  runs.length === LIMIT && (
    <button
      onClick={() => setOffset((prev) => prev + LIMIT)}
      className="text-muted-foreground hover:text-foreground w-full py-2 text-center text-xs"
    >
      Load more...
    </button>
  );
}
```

**Acceptance criteria:**

- Status filter dropdown appears above run list
- Selecting a status filters the displayed runs
- "Load more" button appears when exactly `LIMIT` runs are returned
- Clicking "Load more" appends older runs to the list
- Changing filter resets pagination to offset 0
- Filter resets when component unmounts (local state)

---

## Phase 4: Performance & Polish

### Task 4.1: Conditional polling in `useRuns()`

**Files to modify:**

- `apps/client/src/layers/entities/pulse/model/use-runs.ts`

**Changes:**

Update `refetchInterval` from a static number to the TanStack Query v5 function form:

```typescript
export function useRuns(opts?: Partial<ListRunsQuery>, enabled = true) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...RUNS_KEY, opts],
    queryFn: () => transport.listRuns(opts),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === 'running') ? 10_000 : false,
  });
}
```

This stops polling when no runs are in `running` state, saving network/battery. When a run completes, the next fetch will see no running status and polling stops.

**Acceptance criteria:**

- Polling runs every 10s when at least one run has `status: 'running'`
- Polling stops (returns `false`) when no runs are running
- Polling resumes if a new run starts (manual trigger or scheduled)

---

### Task 4.2: Add `RunTimestamp` component and trigger type badges

**Files to modify:**

- `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx`

**Changes:**

1. Add `Clock` and `Play` to the lucide-react import:

```tsx
import {
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  MinusCircle,
  Play,
  XCircle,
} from 'lucide-react';
```

2. Add `RunTimestamp` component after the helper functions:

```tsx
/** Renders relative time for recent runs, absolute for older ones (7-day threshold). */
function RunTimestamp({ iso }: { iso: string }) {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  const absolute = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (diffMs < sevenDays) {
    return (
      <time dateTime={iso} title={absolute}>
        {formatRelativeTime(iso)}
      </time>
    );
  }

  return (
    <time dateTime={iso} title={formatRelativeTime(iso)}>
      {absolute}
    </time>
  );
}
```

3. Replace the timestamp rendering in RunRow (currently `{run.startedAt ? formatRelativeTime(run.startedAt) : '-'}`):

```tsx
<span className="text-foreground">
  {run.startedAt ? <RunTimestamp iso={run.startedAt} /> : '-'}
</span>
```

4. Add trigger icons in RunRow. Replace the current trigger span:

```tsx
// Before
<span className="truncate capitalize text-muted-foreground">
  {run.trigger}
</span>

// After
<span className="flex items-center gap-1 truncate text-muted-foreground">
  {run.trigger === 'scheduled' ? (
    <Clock className="h-3 w-3 shrink-0" />
  ) : (
    <Play className="h-3 w-3 shrink-0" />
  )}
  <span className="capitalize">{run.trigger}</span>
</span>
```

**Acceptance criteria:**

- Runs < 7 days old show relative time with absolute time in tooltip
- Runs >= 7 days old show absolute time with relative time in tooltip
- Scheduled runs show a clock icon before the trigger label
- Manual runs show a play icon before the trigger label
- Icons are 12px (`h-3 w-3`) and don't shrink

---

### Task 4.3: Add Skeleton loading state and truncated text tooltips

**Files to modify:**

- `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx`
- Run `npx shadcn@latest add skeleton` in `apps/client/` directory

**Changes:**

1. **Install Skeleton component** (run from `apps/client/`):

```bash
npx shadcn@latest add skeleton
```

This creates `apps/client/src/layers/shared/ui/skeleton.tsx`. Add the export to `apps/client/src/layers/shared/ui/index.ts`.

2. **Add import** in RunHistoryPanel:

```tsx
import { Skeleton } from '@/layers/shared/ui';
```

3. **Add `RunRowSkeleton` component:**

```tsx
function RunRowSkeleton() {
  return (
    <div className="grid grid-cols-[20px_56px_1fr_64px_72px_20px] items-center gap-2 px-2 py-2">
      <Skeleton className="h-4 w-4 rounded-full" />
      <Skeleton className="h-3 w-12" />
      <div className="space-y-1">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
      <Skeleton className="h-3 w-12" />
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-3 w-3" />
    </div>
  );
}
```

4. **Replace loading state** (currently "Loading runs..." text):

```tsx
if (isLoading) {
  return (
    <div className="space-y-0.5">
      <RunRowSkeleton />
      <RunRowSkeleton />
      <RunRowSkeleton />
    </div>
  );
}
```

5. **Add `title` attributes to truncated text** for tooltips:

```tsx
// Output summary (add title attribute)
{
  run.outputSummary && (
    <span className="text-muted-foreground truncate" title={run.outputSummary}>
      {firstLine(run.outputSummary)}
    </span>
  );
}

// Error message (add title attribute)
{
  run.status === 'failed' && run.error && (
    <span className="text-destructive truncate" title={run.error}>
      {firstLine(run.error)}
    </span>
  );
}
```

**Acceptance criteria:**

- Loading state shows 3 skeleton rows matching the grid layout
- Skeleton rows use `data-slot="skeleton"` (shadcn default)
- Hovering truncated output summary shows full text in native tooltip
- Hovering truncated error message shows full text in native tooltip
- Skeleton component is exported from `@/layers/shared/ui`

---

## Dependency Graph

```
Phase 1 (P1): Task 1.1 + Task 1.2 (sequential: 1.1 before 1.2)
Phase 2 (P2): Task 2.1 + Task 2.2 (parallel, blocked by P1)
Phase 3 (P3): Task 3.1 then Task 3.2 (sequential, blocked by P1)
Phase 4 (P4): Task 4.1, Task 4.2, Task 4.3 (all parallel, blocked by P1)
```

Within-phase parallelism:

- P2: Tasks 2.1 and 2.2 can run in parallel (different concerns, same file but non-overlapping sections)
- P4: Tasks 4.1, 4.2, and 4.3 can all run in parallel (different files/concerns)

Cross-phase parallelism:

- P2, P3, and P4 can all run in parallel after P1 completes
- P3 tasks are sequential (3.1 schema/server before 3.2 UI)

## Estimated Effort

| Phase                        | Tasks         | Estimated Time |
| ---------------------------- | ------------- | -------------- |
| P1: Bug Fixes                | 1.1, 1.2      | 30 min         |
| P2: Accessibility & Feedback | 2.1, 2.2      | 20 min         |
| P3: Filtering & Pagination   | 3.1, 3.2      | 45 min         |
| P4: Performance & Polish     | 4.1, 4.2, 4.3 | 30 min         |
| **Total**                    | **9 tasks**   | **~2 hours**   |
