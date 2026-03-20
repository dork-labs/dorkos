---
slug: pulse-run-history-improvements
number: 49
created: 2026-02-22
status: ideation
---

# Pulse RunHistoryPanel Improvements & RunRow Navigation Bug Fix

**Slug:** pulse-run-history-improvements
**Author:** Claude Code
**Date:** 2026-02-22
**Related:** specs/pulse-completion-gaps, specs/pulse-ui-overhaul, specs/pulse-v2-enhancements

---

## 1) Intent & Assumptions

- **Task brief:** Improve the RunHistoryPanel component across accessibility, UX, performance, and polish. Fix a critical bug where clicking a RunRow navigates to the wrong session (using internal run ID instead of SDK session UUID) and fails to set the directory in the URL.
- **Assumptions:**
  - Server-side changes needed only for the sessionId bug fix (in `scheduler-service.ts`)
  - All UX improvements are client-side within the Pulse feature layer
  - Existing `ListRunsQuery` schema already supports `status` and `offset` filtering — just needs UI controls
  - The `formatRelativeTime` utility in `session-utils.ts` can be extended for the timestamp threshold
- **Out of scope:**
  - SSE-based real-time run updates (current 10s polling is acceptable for Calm Tech)
  - Cursor-based pagination (offset is fine for typical run volumes <1000)
  - Run virtualization (limit=20 means no performance concern)
  - Schedule editing from within RunHistoryPanel

## 2) Pre-reading Log

- `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx`: 213 lines. Main component with RunRow sub-component. Bug: only calls `setActiveSession(run.sessionId)` without setting directory. `firstLine()` truncates output/error to 80 chars with no tooltip.
- `apps/server/src/services/scheduler-service.ts`: Line 205 — `const sessionId = run.id;` uses run UUID as session ID instead of the actual SDK session UUID. This is the root cause of the wrong-session bug.
- `apps/client/src/layers/entities/pulse/model/use-runs.ts`: 66 lines. `useRuns()` polls every 10s unconditionally. `useCancelRun()` mutation has no `onError` handler.
- `apps/client/src/layers/entities/session/model/use-session-id.ts`: Dual-mode hook (URL via nuqs / Zustand for embedded). Returns `[sessionId, setSessionId]`.
- `apps/client/src/layers/entities/session/model/use-directory-state.ts`: `setSelectedCwd(dir)` also syncs to Zustand and clears session ID. RunHistoryPanel doesn't use this hook at all.
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: Reference for correct navigation pattern — sets session but doesn't need to set dir separately (sessions are already scoped to current dir).
- `apps/client/src/layers/shared/lib/session-utils.ts`: `formatRelativeTime()` returns "5m ago", "Yesterday", "Jan 5" etc. No absolute timestamp fallback.
- `apps/server/src/services/pulse-store.ts`: 361 lines. SQLite with WAL mode. `createRun()` generates UUID for `run.id`. `updateRun()` can set `session_id`. Run rows have `session_id` column.
- `packages/shared/src/schemas.ts`: `PulseRunSchema` (lines 574-590) includes `sessionId: string | null`, `trigger: 'scheduled' | 'manual'`. `ListRunsQuerySchema` supports optional `status`, `offset`, `limit`.
- `apps/client/src/layers/features/pulse/__tests__/RunHistoryPanel.test.tsx`: Tests mock `useSessionId` and verify `setActiveSession` is called with `sessionId`. Tests pass because mocks use correct IDs, but real server sends wrong IDs.
- `research/20260222_scheduler_dashboard_ui_best_practices.md`: Research agent findings on pagination, timestamps, accessibility, polling, cancel feedback, trigger badges, skeleton loading.

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx` — Main component + RunRow sub-component
- `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx` — Parent component, renders ScheduleRow + RunHistoryPanel
- `apps/client/src/layers/entities/pulse/model/use-runs.ts` — TanStack Query hooks: `useRuns()`, `useCancelRun()`
- `apps/server/src/services/scheduler-service.ts` — Cron executor, `executeRun()` method (bug source)
- `apps/server/src/services/pulse-store.ts` — SQLite persistence, run CRUD

**Shared Dependencies:**

- `apps/client/src/layers/entities/session/model/use-session-id.ts` — Session navigation
- `apps/client/src/layers/entities/session/model/use-directory-state.ts` — Directory navigation (NOT currently used by RunHistoryPanel)
- `apps/client/src/layers/shared/lib/session-utils.ts` — `formatRelativeTime()`
- `packages/shared/src/schemas.ts` — `PulseRunSchema`, `ListRunsQuerySchema`

**Data Flow:**
SchedulerService.executeRun() → AgentManager.ensureSession() → SDK query() → run completes → PulseStore.updateRun(sessionId) → GET /api/pulse/runs → useRuns() → RunHistoryPanel → RunRow click → useSessionId setter

**Potential Blast Radius:**

- Direct: `RunHistoryPanel.tsx`, `use-runs.ts`, `scheduler-service.ts`
- Indirect: `PulsePanel.tsx` (passes props), `pulse-store.ts` (if schema needs update)
- Tests: `RunHistoryPanel.test.tsx`, `scheduler-service.test.ts`

## 4) Root Cause Analysis

### Bug 1: Wrong Session ID

- **Observed:** Clicking a completed run row navigates to a non-existent session
- **Expected:** Should navigate to the actual Claude Code SDK session that executed the run
- **Root cause:** `scheduler-service.ts` line 205: `const sessionId = run.id;` — uses the run's own UUID as the session ID passed to `agentManager.ensureSession()`. The SDK creates a session with this ID, so the session _does_ exist, but under the run's UUID, not a meaningful session ID. However, the real issue is that `run.sessionId` in the store is set to `run.id` (line 215: `this.store.updateRun(run.id, { sessionId, ... })`), which means the client receives the run ID as the sessionId. This happens to be valid (the SDK session was created with that ID), but it may conflict with how `transcriptReader.listSessions()` resolves sessions by directory.
- **Deeper investigation needed:** The actual navigation failure likely occurs because `transcriptReader.listSessions(cwd)` filters by project directory slug, and sessions started by the scheduler may use a different `cwd` than what the client currently has selected. The session exists but isn't in the current session list.
- **Decision:** The sessionId storage is technically correct (run.id IS the SDK session ID), but the navigation fails because the directory context is wrong. Fix is in Bug 2.

### Bug 2: Missing Directory in URL

- **Observed:** Clicking a run row only calls `setActiveSession(sessionId)` — doesn't set the directory
- **Expected:** Should also set `?dir=` to the schedule's `cwd` so the session list loads the correct project
- **Root cause:** `RunHistoryPanel.tsx` line 177 only imports `useSessionId`, not `useDirectoryState`. Line 206: `onNavigate={setActiveSession}` — only sets session, never directory.
- **Impact:** If the user's current `?dir=` doesn't match the schedule's `cwd`, the session won't appear in the sidebar and the chat panel won't load it properly.
- **Evidence:** Compare with how `useDirectoryState` works — setting a new directory clears the session. So we need to set directory _first_, then session, or set both without the auto-clear.
- **Decision:** RunHistoryPanel needs access to the schedule's `cwd`. Pass it as a prop from PulsePanel/ScheduleRow. Navigation handler should: (1) set directory if different from current, (2) set session ID. Need to handle the auto-clear behavior in `useDirectoryState`.

## 5) Research

### Potential Solutions

**1. Accessible Clickable Rows — Stretched Link Pattern**

- Use an `<a>` or `<button>` in the first cell with `after:absolute after:inset-0 after:content-['']` to make the entire row clickable
- Action buttons (cancel) get `relative z-10` to sit above the stretched link
- Avoids `role="button"` on `<div>` anti-pattern
- Pros: WCAG compliant, works with keyboard navigation naturally, no need for manual onKeyDown
- Cons: Slightly more complex CSS
- Recommendation: Use this pattern. Add `role="button"` + `tabIndex={0}` as simpler alternative given RunRow is not a table row but a flex div

**2. Conditional Polling — TanStack Query v5 Function Form**

- TanStack Query v5 changed `refetchInterval` signature to `(query) => number | false`
- Access data via `query.state.data` inside the callback
- Pattern: `refetchInterval: (query) => query.state.data?.some(r => r.status === 'running') ? 10_000 : false`
- Pros: No extra state management needed, clean single expression
- Cons: v5 breaking change from v4's `(data, query)` form
- Recommendation: Use the function form directly — cleaner than useState approach

**3. Timestamp Threshold — 7-Day Rule**

- Industry consensus: show relative timestamps for <7 days, absolute for >=7 days
- Always wrap in `<time dateTime={iso}>` for semantics
- Add `title` attribute with the "other" format (absolute shows relative on hover, and vice versa)
- Recommendation: Extend `formatRelativeTime` or create a new `<RelativeTime>` component

**4. Cancel Feedback — Toast Pattern**

- Use Sonner toast (already in project) for success/error feedback
- Pattern from `ScheduleRow.tsx`: `toast('Run cancelled')` on success, `toast.error(...)` on failure
- Recommendation: Add `onSuccess`/`onError` callbacks to `useCancelRun().mutate()` call site

**5. Status Filtering — Simple Select**

- Airflow/Dagster use dropdown filters for run status
- Keep it simple: shadcn `<Select>` with options: All, Running, Completed, Failed, Cancelled
- Wire to `useRuns({ scheduleId, status, limit: 20 })`
- Recommendation: Single select dropdown above the run list

**6. Skeleton Loading — 3 Rows**

- Industry standard: show 3 skeleton rows matching the grid layout
- Use shadcn Skeleton component with shimmer animation
- Recommendation: Create `RunRowSkeleton` matching the 5-column grid

**7. Trigger Badges — Icon + Label**

- Use small lucide icons: `Clock` for scheduled, `Play` for manual
- Keep current text but prepend icon
- Recommendation: Minimal change — add icon before trigger text

## 6) Clarification

1. **Navigation behavior when schedule cwd differs from current dir:** When a user clicks a run row and the schedule's `cwd` is different from the currently selected directory, should we (a) navigate to that directory (changing the sidebar session list), or (b) open the session in a new tab/window, or (c) show a toast warning that the session is in a different directory? Recommendation: (a) — navigate to the directory, then set the session.

2. **Pagination controls:** Should we implement full pagination (Previous/Next buttons with page numbers) or a simpler "Load more" button that appends older runs? Recommendation: "Load more" button — simpler UX, matches the Calm Tech philosophy.

3. **Status filter persistence:** Should the status filter selection persist across schedule expansions (e.g., user filters "Failed" on schedule A, collapses, expands schedule B — should B also show "Failed")? Recommendation: No — each schedule's run list should start unfiltered. Keep filter state local to the RunHistoryPanel instance.

4. **Tooltip implementation for truncated text:** Should we use the shadcn `<Tooltip>` component (requires TooltipProvider) or a simple HTML `title` attribute? Recommendation: HTML `title` — simpler, no provider needed, sufficient for error/output preview text.
