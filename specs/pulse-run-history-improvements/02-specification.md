---
slug: pulse-run-history-improvements
number: 49
created: 2026-02-22
status: specified
---

# Specification: Pulse RunHistoryPanel Improvements & RunRow Navigation Bug Fix

**Status:** Draft
**Authors:** Claude Code, 2026-02-22
**Ideation:** `specs/pulse-run-history-improvements/01-ideation.md`

---

## Overview

Fix two navigation bugs in RunHistoryPanel and implement 9 UX improvements across accessibility, feedback, filtering, performance, and polish. The navigation bugs prevent users from viewing run sessions when clicking run rows. The UX improvements bring the RunHistoryPanel up to the quality standard of the rest of the Pulse UI.

## Background / Problem Statement

The RunHistoryPanel has two bugs and several UX gaps:

1. **Wrong session navigation** — `scheduler-service.ts:205` uses `const sessionId = run.id` to create the SDK session. While this technically creates a valid session (the SDK uses the run UUID as its session ID), navigation fails when the schedule's `cwd` differs from the user's currently selected directory, because the session doesn't appear in the current directory's session list.

2. **Missing directory in URL** — `RunHistoryPanel.tsx:177` only calls `setActiveSession(run.sessionId)` without also setting the directory via `useDirectoryState()`. When a schedule runs in `/project-a` but the user is viewing `/project-b`, the session can't be found.

3. **UX gaps** — Missing keyboard accessibility (no `role="button"`, `tabIndex`, or `aria-label`), no cancel feedback, no filtering/pagination, unconditional polling, limited timestamp formatting, no loading skeletons, and no visual trigger distinction.

## Goals

- Fix run row navigation to correctly set both directory and session ID in the URL
- Make RunHistoryPanel accessible via keyboard with proper ARIA attributes
- Add user feedback for cancel actions via Sonner toasts
- Enable status filtering and "Load more" pagination
- Optimize polling to only run when active runs exist
- Improve timestamp readability for old runs
- Add skeleton loading states and trigger type badges
- Add tooltips for truncated output/error text

## Non-Goals

- SSE-based real-time run updates (polling is acceptable for Calm Tech)
- Cursor-based pagination (offset is fine for typical run volumes)
- Run list virtualization (limit=20 means no performance concern)
- Schedule editing from within RunHistoryPanel
- Bulk run actions (select/cancel multiple)

## Technical Dependencies

- `sonner` — Already installed, used in `ScheduleRow.tsx` for toast feedback
- `@radix-ui/react-select` — Already installed via shadcn Select component
- `lucide-react` — Already installed, used throughout the app for icons
- Shadcn Skeleton component — **Needs to be added** to `apps/client/src/layers/shared/ui/` (exists in `apps/web` but not client)
- TanStack Query v5 — Already installed; uses `(query) =>` signature for `refetchInterval`

## Detailed Design

### Phase 1: Bug Fixes

#### 1A. Fix Navigation — Pass Schedule `cwd` to RunHistoryPanel

**Problem:** `RunHistoryPanel` only receives `scheduleId` as a prop. It has no access to the schedule's `cwd`, which is needed to navigate to the correct directory.

**Change `ScheduleRow.tsx`** (line 192):

```tsx
// Before
<RunHistoryPanel scheduleId={schedule.id} />

// After
<RunHistoryPanel scheduleId={schedule.id} scheduleCwd={schedule.cwd} />
```

**Change `RunHistoryPanel.tsx` Props interface:**

```tsx
interface Props {
  scheduleId: string;
  scheduleCwd: string | null; // NEW: schedule's working directory
}
```

**Change `RunHistoryPanel` navigation handler:**

```tsx
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

  // Pass handleNavigateToRun instead of setActiveSession
  // in RunRow's onNavigate prop
}
```

**Note on `useDirectoryState` auto-clear:** The `setSelectedCwd()` setter internally calls `setSessionId(null)`, which would clear the session we're trying to set. We use `setTimeout(0)` to defer the session set until after the directory state update completes. This is a pragmatic solution — the alternative would be to refactor `useDirectoryState` to accept an option to skip the auto-clear, which is a larger change.

#### 1B. Verify Session ID Correctness

The exploration revealed that `scheduler-service.ts:205` sets `const sessionId = run.id` and then passes it to `agentManager.ensureSession(sessionId, ...)`. The SDK creates its JSONL transcript file named `{sessionId}.jsonl`. So `run.sessionId` in the database IS a valid SDK session UUID — it's just the same UUID as `run.id`.

**This is not actually a bug.** The session exists and has the correct content. The real issue is Bug 1A — the directory context is wrong. Once we fix the directory navigation, clicking a run row will correctly find and display the session.

**No server-side change needed for session ID.** The current pattern of reusing `run.id` as the SDK session ID is acceptable — it provides natural isolation (each run gets its own session).

### Phase 2: Accessibility & Feedback

#### 2A. Keyboard Accessibility for RunRow

Add proper ARIA attributes and focus management to the RunRow `<div>`:

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
    'grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-2 rounded px-2 py-1.5 text-xs',
    isClickable && 'cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
  )}
>
```

#### 2B. Cancel Error Feedback

Add toast callbacks to the cancel mutation call site in `RunHistoryPanel`:

```tsx
const cancelRun = useCancelRun();

// In RunRow's onCancel handler:
onCancel={(id) =>
  cancelRun.mutate(id, {
    onSuccess: () => toast('Run cancelled'),
    onError: (err) =>
      toast.error(`Failed to cancel: ${err instanceof Error ? err.message : 'Unknown error'}`),
  })
}
```

Import `toast` from `sonner` at the top of the file.

### Phase 3: Filtering & Pagination

#### 3A. Add `status` Field to ListRunsQuerySchema

The `ListRunsQuerySchema` in `packages/shared/src/schemas.ts` currently only supports `scheduleId`, `limit`, and `offset`. Add a `status` filter:

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

#### 3B. Add Server-Side Status Filtering

In `apps/server/src/services/pulse-store.ts`, update the `listRuns` method to accept and apply the `status` filter:

```typescript
listRuns(opts?: ListRunsOptions & { status?: string }): PulseRun[] {
  let sql = 'SELECT * FROM runs';
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (opts?.scheduleId) {
    conditions.push('schedule_id = ?');
    params.push(opts.scheduleId);
  }
  if (opts?.status) {
    conditions.push('status = ?');
    params.push(opts.status);
  }
  if (conditions.length) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(opts?.limit ?? 50, opts?.offset ?? 0);

  const rows = this.db.prepare(sql).all(...params) as RunRow[];
  return rows.map(toRun);
}
```

Update `routes/pulse.ts` to pass the `status` query parameter through to the store.

#### 3C. Update Transport Interface

Add `status` parameter support to the `listRuns` method in the Transport interface and `HttpTransport`:

```typescript
// In Transport interface
listRuns(opts?: { scheduleId?: string; status?: string; limit?: number; offset?: number }): Promise<PulseRun[]>;
```

#### 3D. Status Filter UI

Add a local state filter in `RunHistoryPanel`:

```tsx
const [statusFilter, setStatusFilter] = useState<string>('all');

const { data: runs = [], isLoading } = useRuns({
  scheduleId,
  limit: 20,
  ...(statusFilter !== 'all' && { status: statusFilter }),
});
```

Render a shadcn `<Select>` above the run list:

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

Filter state is local — resets when the component unmounts (schedule collapsed).

#### 3E. "Load More" Pagination

Add offset-based progressive loading:

```tsx
const [offset, setOffset] = useState(0);
const LIMIT = 20;

const { data: runs = [], isLoading } = useRuns({
  scheduleId,
  limit: LIMIT,
  offset,
  ...(statusFilter !== 'all' && { status: statusFilter }),
});

// Track accumulated runs across pages
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

Render a "Load more" button below the list when the current page is full:

```tsx
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

### Phase 4: Performance & Polish

#### 4A. Conditional Polling

Update `useRuns()` in `use-runs.ts` to use the TanStack Query v5 function form:

```typescript
export function useRuns(opts?: ListRunsOptions, enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: ['pulse-runs', opts],
    queryFn: () => transport.listRuns(opts),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === 'running') ? 10_000 : false,
  });
}
```

This stops polling when no runs are in `running` state, saving network/battery.

#### 4B. Timestamp Threshold (7-Day Rule)

Create a `<RunTimestamp>` inline component in `RunHistoryPanel.tsx`:

```tsx
function RunTimestamp({ iso }: { iso: string }) {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  if (diffMs < sevenDays) {
    // Relative with absolute tooltip
    const absolute = date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    return (
      <time dateTime={iso} title={absolute}>
        {formatRelativeTime(iso)}
      </time>
    );
  }

  // Absolute with relative tooltip
  const absolute = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return (
    <time dateTime={iso} title={formatRelativeTime(iso)}>
      {absolute}
    </time>
  );
}
```

Replace the current `{formatRelativeTime(run.startedAt)}` calls with `<RunTimestamp iso={run.startedAt} />`.

#### 4C. Truncated Text Tooltips

Add `title` attribute to truncated output summary and error text:

```tsx
// Output summary
{
  run.outputSummary && (
    <span className="text-muted-foreground truncate" title={run.outputSummary}>
      {firstLine(run.outputSummary)}
    </span>
  );
}

// Error message
{
  run.status === 'failed' && run.error && (
    <span className="text-destructive truncate" title={run.error}>
      {firstLine(run.error)}
    </span>
  );
}
```

#### 4D. Skeleton Loading State

First, add the Skeleton component to the client app. Run:

```bash
npx shadcn@latest add skeleton
```

Then create skeleton rows matching the grid layout:

```tsx
function RunRowSkeleton() {
  return (
    <div className="grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-2 px-2 py-1.5">
      <Skeleton className="h-4 w-4 rounded-full" />
      <div className="space-y-1">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
      <Skeleton className="h-3 w-12" />
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-3 w-8" />
    </div>
  );
}
```

Replace the loading state in `RunHistoryPanel`:

```tsx
if (isLoading) {
  return (
    <div className="space-y-1">
      <RunRowSkeleton />
      <RunRowSkeleton />
      <RunRowSkeleton />
    </div>
  );
}
```

#### 4E. Trigger Type Badges

Add icons before the trigger text in `RunRow`:

```tsx
import { Clock, Play } from 'lucide-react';

// In RunRow render:
<span className="text-muted-foreground flex items-center gap-1 truncate">
  {run.trigger === 'scheduled' ? (
    <Clock className="h-3 w-3 shrink-0" />
  ) : (
    <Play className="h-3 w-3 shrink-0" />
  )}
  <span className="capitalize">{run.trigger}</span>
</span>;
```

## User Experience

### Navigation Flow (After Fix)

1. User opens Pulse panel, sees list of schedules
2. User expands a schedule → RunHistoryPanel shows recent runs
3. User clicks a completed run row
4. If schedule's `cwd` differs from current directory:
   - URL updates `?dir=` to schedule's cwd
   - Sidebar session list refreshes for new directory
   - After brief delay, `?session=` is set to the run's session ID
5. ChatPanel loads the run's session, showing the agent's conversation

### Filtering Flow

1. User expands a schedule with many runs
2. Selects "Failed" from the status dropdown
3. Only failed runs are shown
4. Clicks "Load more" to see older failed runs
5. Collapses and re-expands schedule → filter resets to "All"

### Accessibility

- Run rows are focusable via Tab key
- Enter/Space activates navigation
- Focus ring visible on keyboard focus
- Screen readers announce "View completed run from 2 hours ago"
- Cancel button has existing aria-label, toast confirms action

## Testing Strategy

### Unit Tests — RunHistoryPanel

**New test: navigation sets directory when schedule has different cwd**

```typescript
it('navigates to schedule directory before setting session', async () => {
  const mockSetDirectory = vi.fn();
  vi.mocked(useDirectoryState).mockReturnValue(['/current-dir', mockSetDirectory]);

  // Render with scheduleCwd different from current
  render(
    <Wrapper>
      <RunHistoryPanel scheduleId="sched-1" scheduleCwd="/other-project" />
    </Wrapper>
  );

  const row = screen.getByRole('button', { name: /completed run/i });
  await userEvent.click(row);

  expect(mockSetDirectory).toHaveBeenCalledWith('/other-project');
  // Session set deferred via setTimeout
  await waitFor(() => {
    expect(mockSetActiveSession).toHaveBeenCalledWith('session-abc');
  });
});
```

**New test: navigation skips directory when same cwd**

```typescript
it('does not change directory when schedule cwd matches current', async () => {
  const mockSetDirectory = vi.fn();
  vi.mocked(useDirectoryState).mockReturnValue(['/same-dir', mockSetDirectory]);

  render(
    <Wrapper>
      <RunHistoryPanel scheduleId="sched-1" scheduleCwd="/same-dir" />
    </Wrapper>
  );

  const row = screen.getByRole('button', { name: /completed run/i });
  await userEvent.click(row);

  expect(mockSetDirectory).not.toHaveBeenCalled();
  expect(mockSetActiveSession).toHaveBeenCalledWith('session-abc');
});
```

**New test: cancel shows error toast on failure**

```typescript
it('shows error toast when cancel fails', async () => {
  const mockCancelRun = { mutate: vi.fn(), isPending: false };
  vi.mocked(useCancelRun).mockReturnValue(mockCancelRun as any);

  render(
    <Wrapper>
      <RunHistoryPanel scheduleId="sched-1" scheduleCwd={null} />
    </Wrapper>
  );

  // Click cancel on running run
  const cancelBtn = screen.getByLabelText('Cancel run');
  await userEvent.click(cancelBtn);

  // Simulate error callback
  const mutateCall = mockCancelRun.mutate.mock.calls[0];
  mutateCall[1].onError(new Error('Network timeout'));

  expect(toast.error).toHaveBeenCalledWith('Failed to cancel: Network timeout');
});
```

**New test: status filter changes query params**

```typescript
it('filters runs by status', async () => {
  render(
    <Wrapper>
      <RunHistoryPanel scheduleId="sched-1" scheduleCwd={null} />
    </Wrapper>
  );

  // Select "Failed" filter
  const trigger = screen.getByRole('combobox');
  await userEvent.click(trigger);
  const failedOption = screen.getByText('Failed');
  await userEvent.click(failedOption);

  // Verify useRuns was called with status filter
  expect(mockTransport.listRuns).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'failed' })
  );
});
```

**New test: keyboard navigation**

```typescript
it('activates run via keyboard Enter', async () => {
  render(
    <Wrapper>
      <RunHistoryPanel scheduleId="sched-1" scheduleCwd={null} />
    </Wrapper>
  );

  const row = screen.getByRole('button', { name: /completed run/i });
  row.focus();
  await userEvent.keyboard('{Enter}');

  expect(mockSetActiveSession).toHaveBeenCalledWith('session-abc');
});
```

**New test: skeleton loading state**

```typescript
it('shows skeleton rows while loading', () => {
  vi.mocked(useRuns).mockReturnValue({
    data: [],
    isLoading: true,
  } as any);

  const { container } = render(
    <Wrapper>
      <RunHistoryPanel scheduleId="sched-1" scheduleCwd={null} />
    </Wrapper>
  );

  // Verify 3 skeleton rows are rendered
  const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
  expect(skeletons.length).toBeGreaterThanOrEqual(3);
});
```

### Existing Tests — Verify Non-Regression

Update existing test mocks to pass `scheduleCwd` prop:

```typescript
// All existing renders need scheduleCwd
<RunHistoryPanel scheduleId="sched-1" scheduleCwd={null} />
```

Update `ScheduleRow.test.tsx` mock to accept `scheduleCwd`:

```typescript
vi.mock('../ui/RunHistoryPanel', () => ({
  RunHistoryPanel: ({ scheduleId, scheduleCwd }: { scheduleId: string; scheduleCwd: string | null }) => (
    <div data-testid="run-history" data-cwd={scheduleCwd}>{scheduleId}</div>
  ),
}));
```

### Server Tests

**`scheduler-service.test.ts`** — No changes needed (session ID logic is unchanged).

**`pulse-store.test.ts`** — Add test for status filtering:

```typescript
it('filters runs by status', () => {
  // Create runs with different statuses
  store.createRun('sched-1', 'scheduled'); // → running
  store.updateRun('run-1', { status: 'completed' });
  store.createRun('sched-1', 'manual'); // → running

  const failed = store.listRuns({ scheduleId: 'sched-1', status: 'completed' });
  expect(failed).toHaveLength(1);
  expect(failed[0].status).toBe('completed');
});
```

## Performance Considerations

- **Conditional polling** eliminates unnecessary 10s network requests when no runs are active
- **Offset pagination** with limit=20 keeps initial payload small; "Load more" is lazy
- **Status filtering** is server-side (SQL WHERE clause), not client-side filtering of all runs
- **Skeleton loading** eliminates layout shift on initial render

## Security Considerations

- No new API endpoints — all changes use existing `GET /api/pulse/runs` with additional query params
- Status filter value is validated by Zod schema (`PulseRunStatusSchema`) — no injection risk
- Directory navigation uses existing `useDirectoryState()` which is already boundary-validated

## Documentation

- No external documentation changes needed
- Update `contributing/interactive-tools.md` if it references Pulse run history patterns
- Internal code comments on the `setTimeout(0)` pattern for directory → session sequencing

## Implementation Phases

### Phase 1: Bug Fixes (Critical)

1. Add `scheduleCwd` prop to `RunHistoryPanel`
2. Update `ScheduleRow` to pass `schedule.cwd`
3. Import and use `useDirectoryState` in `RunHistoryPanel`
4. Implement `handleNavigateToRun` with directory-first logic
5. Update existing tests with new prop
6. Add new navigation tests

### Phase 2: Accessibility & Feedback

7. Add `role="button"`, `tabIndex={0}`, `aria-label` to RunRow
8. Add `focus-visible:ring-2` style
9. Add toast callbacks to cancel mutation
10. Import `toast` from `sonner`

### Phase 3: Filtering & Pagination

11. Add `status` field to `ListRunsQuerySchema`
12. Update `pulse-store.ts` `listRuns` for status filtering
13. Update `routes/pulse.ts` to pass status param
14. Update Transport interface and `HttpTransport`
15. Add status filter Select UI
16. Add "Load more" button with offset state
17. Reset offset when filter changes

### Phase 4: Performance & Polish

18. Change `refetchInterval` to function form in `useRuns()`
19. Add `RunTimestamp` component with 7-day threshold
20. Add `title` attributes to truncated text
21. Install shadcn Skeleton component
22. Create `RunRowSkeleton` and replace loading state
23. Add trigger icons (Clock/Play)

## Open Questions

None — all decisions resolved during ideation.

## Related ADRs

- **ADR 5:** Use Zustand for UI State and TanStack Query for Server State — informs the `useRuns()` hook pattern and conditional `refetchInterval`
- **ADR 6:** Adopt Sonner for Toast Notifications — guides the cancel feedback pattern (toast for background actions)
- **ADR 9:** Use Calm Tech Layered Notifications — confirms polling is acceptable (no need for SSE-based real-time updates)
- **ADR 2:** Adopt Feature-Sliced Design — constrains import paths; `RunHistoryPanel` can import from `entities/session/` but not vice versa

## References

- Ideation: `specs/pulse-run-history-improvements/01-ideation.md`
- Research: `research/20260222_scheduler_dashboard_ui_best_practices.md`
- Related spec: `specs/pulse-completion-gaps/02-specification.md`
- Related spec: `specs/pulse-ui-overhaul/02-specification.md`
- TanStack Query v5 `refetchInterval` docs: `(query) =>` signature
- Cloudscape timestamp patterns: 7-day relative/absolute threshold
- WAI-ARIA button pattern: `role="button"` + `tabIndex={0}` for interactive divs
