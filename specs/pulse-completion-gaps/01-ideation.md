---
slug: pulse-completion-gaps
number: 46
created: 2026-02-21
status: ideation
---

# Pulse Implementation Completion Gaps

**Slug:** pulse-completion-gaps
**Author:** Claude Code
**Date:** 2026-02-21
**Related:** [Pulse Scheduler Spec](../pulse-scheduler/02-specification.md) (#43)

---

## 1) Intent & Assumptions

- **Task brief:** Resolve four gaps discovered during a Pulse feature audit: (1) `buildPulseAppend` is never called so scheduled agents lack context, (2) no edit button in PulsePanel UI, (3) no client-side tests for Pulse, (4) MCP Pulse handler behavior untested.
- **Assumptions:**
  - The existing Pulse architecture is sound — these are completion tasks, not redesigns
  - `sendMessage()` in `agent-manager.ts` can accept an optional `systemPromptAppend` parameter without breaking existing callers
  - Client test patterns from existing `session` and `chat` tests apply directly to Pulse
- **Out of scope:**
  - New Pulse features (run output viewing, schedule templates, recurring failure handling)
  - Changes to the Pulse data model or API endpoints
  - E2E/integration tests

## 2) Pre-reading Log

- `apps/server/src/services/scheduler-service.ts`: `buildPulseAppend()` (lines 31-46) builds XML context but `executeRun()` (lines 189-217) never calls it. `sendMessage()` is called without the append.
- `apps/server/src/services/agent-manager.ts`: `sendMessage()` accepts `opts?: { permissionMode?, cwd? }` — no `systemPromptAppend` field. Internally builds append via `buildSystemPromptAppend(effectiveCwd)` at line 97.
- `apps/server/src/services/context-builder.ts`: `buildSystemPromptAppend()` returns XML blocks (`<env>`, `<git_status>`). Pattern: multiple blocks joined with `\n\n`.
- `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx`: `editSchedule` state at line 39, passed to dialog at lines 152-156, but no button sets it.
- `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`: Already supports edit mode — `useEffect` on `editSchedule` pre-fills form (lines 43-63), title shows "Edit Schedule" (line 97), submit calls `updateSchedule.mutate()` (lines 82-89).
- `apps/client/src/layers/entities/pulse/model/use-schedules.ts`: 5 hooks, all using TanStack Query with Transport injection. `useUpdateSchedule` exists and works.
- `apps/client/src/layers/entities/pulse/model/use-runs.ts`: 3 hooks with 10s refetch interval.
- `apps/server/src/services/__tests__/mcp-tool-server.test.ts`: Tests `handlePing`, `handleGetServerInfo`, `createGetSessionCountHandler`, and tool registration (8 tools). Zero tests for Pulse handler factories.
- `apps/server/src/services/mcp-tool-server.ts`: 5 exported Pulse handler factories (lines 112-200), each guarded by `requirePulse()`. Handler pattern: factory takes `McpToolDeps`, returns async function.
- `apps/client/src/layers/entities/session/__tests__/use-sessions.test.tsx`: Reference pattern for hook tests with `createMockTransport()`, `QueryClient` per test, `TransportProvider` wrapper.
- `apps/client/src/layers/features/chat/__tests__/ChatPanel.test.tsx`: Reference pattern for component tests with `motion/react` mock and `@testing-library/react`.
- `packages/test-utils/src/mock-factories.ts`: Has `createMockSession()`, `createMockStreamEvent()`, `createMockCommandEntry()`. Could extend with Pulse mocks.

## 3) Codebase Map

**Primary components/modules:**

| File                                                                | Role                                              |
| ------------------------------------------------------------------- | ------------------------------------------------- |
| `apps/server/src/services/scheduler-service.ts`                     | Cron engine, `executeRun()`, `buildPulseAppend()` |
| `apps/server/src/services/agent-manager.ts`                         | SDK session orchestration, `sendMessage()`        |
| `apps/server/src/services/context-builder.ts`                       | Runtime context XML builder                       |
| `apps/server/src/services/mcp-tool-server.ts`                       | MCP tool registration + 5 Pulse handler factories |
| `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx`           | Schedule list, actions, expand/collapse           |
| `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx` | Create/edit form dialog                           |
| `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx`      | Per-schedule run history                          |
| `apps/client/src/layers/entities/pulse/model/use-schedules.ts`      | 5 TanStack Query hooks for schedules              |
| `apps/client/src/layers/entities/pulse/model/use-runs.ts`           | 3 TanStack Query hooks for runs                   |

**Shared dependencies:**

- `@dorkos/shared/types` — `PulseSchedule`, `PulseRun`, `CreateScheduleInput`, `UpdateScheduleRequest`
- `@dorkos/shared/transport` — `Transport` interface with 8 Pulse methods
- `packages/test-utils` — Mock factories and React test helpers

**Data flow:**

- Scheduled run: `croner` tick → `SchedulerService.executeRun()` → `AgentManager.sendMessage()` → SDK `query()` → streaming events
- Client edit: Edit button → `setEditSchedule(schedule)` → `CreateScheduleDialog` → `useUpdateSchedule().mutate()` → `Transport.updateSchedule()` → `PATCH /api/pulse/schedules/:id`

**Potential blast radius:**

- Gap 1: `agent-manager.ts` `sendMessage()` signature + `SchedulerAgentManager` interface + scheduler-service test mock
- Gap 2: `PulsePanel.tsx` only (one button addition)
- Gap 3: New test files only (no production code changes)
- Gap 4: `mcp-tool-server.test.ts` only (extending existing test file)

## 4) Research

### Gap 1: Injecting Pulse context into scheduled runs

**Recommended approach:** Add optional `systemPromptAppend?: string` to `sendMessage()` opts. In `agent-manager.ts`, merge it after the base `buildSystemPromptAppend()` output with `\n\n` separator. In `scheduler-service.ts`, call `buildPulseAppend()` in `executeRun()` and pass result via the new opt.

**Key patterns:**

- SDK `systemPrompt.append` is session-scoped (applies to one `query()` call), which is correct since each Pulse run is a fresh session
- Keep `buildSystemPromptAppend()` generic — Pulse logic stays in `executeRun()`
- Separator: `\n\n` between XML blocks and Pulse plain-text context

**Pitfalls:**

- Don't modify `buildSystemPromptAppend()` directly — it's shared by all sessions
- Don't set `resume` for Pulse runs (already correctly avoided)
- Must also update `SchedulerAgentManager` interface to include the new opt

### Gap 2: Adding edit button to PulsePanel

**Recommended approach:** Add a `Pencil` icon button inline alongside "Run Now" and the toggle switch. Three actions = inline buttons (not a dropdown menu).

**Key patterns:**

- Button: `onClick={(e) => { e.stopPropagation(); setEditSchedule(schedule); setDialogOpen(true); }}`
- `aria-label={`Edit ${schedule.name}`}` for accessibility
- Only in the non-`pending_approval` branch
- Dialog already fully supports edit mode — zero dialog changes needed

**Pitfalls:**

- Must `e.stopPropagation()` to prevent row expand toggle
- Don't reset `editSchedule` on dialog close (causes title flicker during close animation)
- "New Schedule" button already clears `editSchedule` — pattern is correct as-is

### Gap 3: Client-side Pulse tests

**Recommended approach:** Test entity hooks via `renderHook` with mock Transport + isolated QueryClient. Test UI components at integration level (real hooks, mock Transport) rather than mocking TanStack Query internals.

**Key patterns:**

- Each test creates its own `QueryClient` with `retry: false`
- Wrapper provides both `QueryClientProvider` and `TransportProvider`
- Hook tests: verify `isSuccess`/`isError` states and that correct Transport methods are called
- Mutation tests: call `.mutate()` inside `act()`, verify cache invalidation
- Component tests: render with mock Transport returning fixtures, assert rendered content

**Pitfalls:**

- Never share `QueryClient` across tests (cache contamination → flaky tests)
- Always `retry: false` (default retries cause 14s timeouts)
- Never mock `@tanstack/react-query` itself — mock the Transport
- Use `waitFor(() => assertion)`, never `setTimeout`

### Gap 4: MCP handler behavior tests

**Recommended approach:** Call handler factories directly (same pattern as existing `createGetSessionCountHandler` tests). Create `makeMockPulseStore()` helper with vi.fn() stubs. Add to existing `mcp-tool-server.test.ts`.

**Key patterns:**

- `makePulseDeps()` factory extends `makeMockDeps()` with a mock `PulseStore`
- Each handler factory returns an async function — invoke directly, parse JSON response
- Test `requirePulse()` guard for every handler (deps without `pulseStore`)
- Test error paths (not-found for update/delete, empty results)

**Pitfalls:**

- Don't instantiate real `PulseStore` (SQLite dependency) — mock it
- Don't import `createSdkMcpServer`/`tool` in handler tests — those are wiring tests
- Always test `pulseStore === undefined` path per handler
- Use `as unknown as PulseStore` not `as any`

## 5) Clarification

1. **Gap 1 scope:** Should `sendMessage()` accept a generic `systemPromptAppend` parameter (reusable for future callers), or should we create a Pulse-specific `sendScheduledMessage()` method? The generic approach is simpler and more extensible.

2. **Gap 3 test depth:** Should we write comprehensive tests for all 5 entity hooks + 3 UI components, or focus on the highest-value subset (e.g., hooks + PulsePanel only, skip CreateScheduleDialog form validation tests)?

3. **Mock factories:** Should we add `createMockSchedule()` and `createMockRun()` to `packages/test-utils/src/mock-factories.ts` for reuse, or keep fixtures local to the Pulse test files?

4. **Priority ordering:** All four gaps are independent. Suggested order by impact: Gap 1 (functional bug) → Gap 2 (UX gap) → Gap 4 (server test coverage) → Gap 3 (client test coverage). Agree?
