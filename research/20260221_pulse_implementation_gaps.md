# Pulse Feature Implementation Gaps — Research Report

**Date:** 2026-02-21
**Scope:** Four specific implementation gaps in the DorkOS Pulse scheduler feature
**Mode:** Deep Research (codebase-aware)

---

## Research Summary

All four gaps have clear, well-precedented solutions that align with existing DorkOS patterns. Gap 1 requires a two-line change to `executeRun()` to thread `buildPulseAppend()` output through `sendMessage()`. Gap 2 requires adding an edit button to each schedule list item in `PulsePanel.tsx`, following the inline-icon-button pattern already used in the file. Gap 3 requires a standard TanStack Query testing setup that matches the project's existing test patterns. Gap 4 requires adding handler-level tests using the factory function pattern already established in the existing `mcp-tool-server.test.ts`.

---

## Gap 1: Injecting `buildPulseAppend()` Context into Scheduled Agent Runs

### Recommended Approach

Extend the `SchedulerAgentManager.sendMessage()` interface with an optional `systemPromptAppend` field in its `opts` object, then pass `buildPulseAppend(schedule, run)` through `executeRun()` into that call. The `AgentManager.sendMessage()` already constructs its `systemPrompt` object from `buildSystemPromptAppend(effectiveCwd)` — it needs to merge an additional caller-supplied append string.

### Key Implementation Patterns

#### 1. Extend the `SchedulerAgentManager` interface

In `scheduler-service.ts`, the narrow interface that decouples the scheduler from `AgentManager` needs one new optional field:

```typescript
export interface SchedulerAgentManager {
  ensureSession(
    sessionId: string,
    opts: { permissionMode: PermissionMode; cwd?: string; hasStarted?: boolean }
  ): void;
  sendMessage(
    sessionId: string,
    content: string,
    opts?: {
      permissionMode?: PermissionMode;
      cwd?: string;
      systemPromptAppend?: string;  // NEW
    }
  ): AsyncGenerator<StreamEvent>;
}
```

This is the only interface change needed. The `SchedulerAgentManager` interface is a narrow subset — adding an optional field is non-breaking for existing callers.

#### 2. Pass the append through `executeRun()`

In `SchedulerService.executeRun()`, call `buildPulseAppend()` before `sendMessage()` and thread it through:

```typescript
private async executeRun(schedule: PulseSchedule, run: PulseRun): Promise<void> {
  // ...existing setup...

  const pulseAppend = buildPulseAppend(schedule, run);  // NEW

  const stream = this.agentManager.sendMessage(sessionId, schedule.prompt, {
    permissionMode,
    cwd: schedule.cwd ?? undefined,
    systemPromptAppend: pulseAppend,  // NEW
  });

  // ...existing streaming loop...
}
```

#### 3. Merge the append inside `AgentManager.sendMessage()`

In `agent-manager.ts`, the `sendMessage()` signature already accepts `opts`. The `systemPromptAppend` field needs to be merged with the existing `buildSystemPromptAppend()` output:

```typescript
async *sendMessage(
  sessionId: string,
  content: string,
  opts?: {
    permissionMode?: PermissionMode;
    cwd?: string;
    systemPromptAppend?: string;  // NEW
  }
): AsyncGenerator<StreamEvent> {
  // ...existing code...

  const baseAppend = await buildSystemPromptAppend(effectiveCwd);
  // Append pulse context after the base env/git context, separated by a blank line
  const systemPromptAppend = opts?.systemPromptAppend
    ? `${baseAppend}\n\n${opts.systemPromptAppend}`
    : baseAppend;

  const sdkOptions: Options = {
    cwd: effectiveCwd,
    includePartialMessages: true,
    settingSources: ['project', 'user'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: systemPromptAppend,  // CHANGED from systemPromptAppend to merged value
    },
    // ...rest of existing options...
  };
```

#### 4. The SDK `append` field semantics (confirmed from official docs)

The Claude Agent SDK accepts `systemPrompt: { type: 'preset', preset: 'claude_code', append: string }`. The `append` field is concatenated after the full Claude Code system prompt. There is no per-turn update mechanism — the append is fixed at `query()` call time. Since each Pulse `executeRun()` creates a fresh `query()` call for a new session (using run ID as session ID), the pulse context is correctly scoped to that single run.

**Verified from SDK docs:** "With append" is described as "Session only" persistence — it applies to the current `query()` call and does not persist across resume calls. This is exactly right for Pulse runs, which are isolated sessions.

### Pitfalls to Avoid

- **Do not concatenate before the base append without a separator.** `buildSystemPromptAppend()` produces XML blocks (`<env>`, `<git_status>`). The Pulse context is plain text. Keep them structurally separated with `\n\n` so Claude does not conflate the XML context with unstructured text.
- **Do not modify `buildSystemPromptAppend()` itself** to accept pulse context — that function is used by all sessions and should remain generic. Keep pulse logic in `executeRun()`.
- **Do not set `resume`** for Pulse runs. `executeRun()` correctly avoids this: it uses `hasStarted: false`, meaning no `resume` is set in `sdkOptions`. This is correct — each run is a fresh session and the `append` applies cleanly.
- **Do not add `systemPromptAppend` to `ensureSession()`** — that is just metadata initialization. The append only matters when `query()` is called inside `sendMessage()`.

---

## Gap 2: Adding an Edit Button to the Schedule List UI

### Recommended Approach

Add a pencil icon button alongside the existing "Run Now" / toggle actions in `PulsePanel.tsx`, following the project's existing inline action button pattern. With two actions already visible (Run Now + toggle switch) and edit being the third, an inline icon button is the correct choice — the UX research consensus is clear that inline buttons work best for three or fewer frequent actions, while an overflow menu is for four or more.

### Key Implementation Patterns

#### 1. Where to place the edit button

The non-pending-approval branch of the action area (lines 105–139 in `PulsePanel.tsx`) currently renders "Run Now" and a toggle switch. Add a pencil icon button between them:

```tsx
import { Pencil } from 'lucide-react';

// Inside the non-pending branch action div:
<div className="flex items-center gap-2">
  <button
    className="hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50"
    disabled={!schedule.enabled}
    onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      triggerSchedule.mutate(schedule.id);
    }}
  >
    Run Now
  </button>

  {/* NEW: Edit button */}
  <button
    className="hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md p-1 text-xs font-medium transition-colors"
    aria-label={`Edit ${schedule.name}`}
    onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      setEditSchedule(schedule);
      setDialogOpen(true);
    }}
  >
    <Pencil className="size-3.5" />
  </button>

  {/* existing toggle switch */}
</div>
```

#### 2. Reusing `CreateScheduleDialog` as an edit dialog

`CreateScheduleDialog` is already fully wired for edit mode — it accepts `editSchedule?: PulseSchedule`, resets fields via `useEffect([editSchedule, open])`, sets the title to "Edit Schedule", calls `updateSchedule.mutate()` on submit, and shows "Save" instead of "Create". The dialog infrastructure is complete. The only missing piece is the button that sets `editSchedule` state and opens the dialog.

`PulsePanel` already has both pieces of state: `editSchedule` (line 39) and `dialogOpen` (line 38). The `CreateScheduleDialog` is already rendered with those values (lines 152–156). No dialog changes are needed.

#### 3. Accessibility requirements

Icon-only buttons must have `aria-label` describing the action and its target (e.g., `aria-label="Edit Daily code review"`). The `.claude/rules/components.md` rule explicitly states: "Buttons must have accessible names." Using `aria-label={`Edit ${schedule.name}`}` satisfies this. No tooltip is required but is a welcome addition.

#### 4. The single-dialog pattern for create/edit

The pattern in use is: one dialog component instance, controlled by parent state (`editSchedule` + `dialogOpen`). When `editSchedule` is `undefined`, the dialog creates. When it is set to a schedule object, it edits. This is the standard React pattern — a controlled "mode" prop (here implemented as "is editSchedule defined?"). The `useEffect` in `CreateScheduleDialog` that resets form fields on `[editSchedule, open]` change is the correct mechanism.

**One subtlety:** When the dialog closes after a successful edit, `editSchedule` remains set. The "New Schedule" button already clears it: `setEditSchedule(undefined); setDialogOpen(true)`. This is correct — no cleanup in the dialog's `onOpenChange` handler is needed because the parent always sets `editSchedule` explicitly before opening.

### Pitfalls to Avoid

- **Do not use a dropdown/MoreHorizontal menu.** With only edit, run, and toggle — three actions — inline buttons are the right choice. Dropdown menus add an extra click for no benefit at this count. The Carbon Design System guidance is explicit: "When the dropdown menu contains fewer than three options, keep the actions inline as icon buttons."
- **Do not forget `e.stopPropagation()`** on the edit button click. The entire row has `onClick={() => setExpandedId(...)}` as a row-level expand handler. Without stop propagation, clicking edit would simultaneously toggle the expanded state.
- **Do not conditionally render the edit button for `pending_approval` schedules.** Those schedules already have a dedicated Approve/Reject UI branch. The edit button only belongs in the non-pending branch.
- **Do not reset `editSchedule` to `undefined` on dialog close.** There is no need — the next open will set it explicitly. Resetting it causes a flicker where the dialog title briefly reverts to "New Schedule" during the close animation.

---

## Gap 3: Writing Client Tests for TanStack Query Hooks and UI Components

### Recommended Approach

Test the entity hooks (`useSchedules`, `useRuns`, `useCreateSchedule`, etc.) using `renderHook` with a minimal `QueryClientProvider` wrapper and mocked Transport. Test the UI components (`PulsePanel`, `CreateScheduleDialog`, `RunHistoryPanel`) at the integration level by rendering the full component with a mock Transport that returns fixture data, rather than mocking TanStack Query internals.

### Key Implementation Patterns

#### 1. Standard test wrapper setup for hooks

Follow the pattern from `apps/client/src/` existing tests. For pulse entity hooks, create a wrapper that provides both `QueryClientProvider` and `TransportProvider`:

```typescript
// apps/client/src/layers/entities/pulse/__tests__/use-schedules.test.ts
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useSchedules } from '../model/use-schedules';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },  // CRITICAL: prevents test timeouts on errors
    },
  });
  const transport = createMockTransport();

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          {children}
        </TransportProvider>
      </QueryClientProvider>
    );
  }

  return { queryClient, transport, Wrapper };
}
```

Each test creates its own `queryClient` (via the factory, not a shared instance) to prevent cross-test contamination.

#### 2. Testing `useQuery` hooks (useSchedules, useRuns)

```typescript
describe('useSchedules', () => {
  it('returns schedules from transport', async () => {
    const { transport, Wrapper } = createWrapper();
    const mockSchedules = [{ id: 's1', name: 'Daily review', cron: '0 9 * * 1-5' }];
    vi.mocked(transport.listSchedules).mockResolvedValue(mockSchedules);

    const { result } = renderHook(() => useSchedules(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockSchedules);
    expect(transport.listSchedules).toHaveBeenCalledOnce();
  });

  it('exposes error state when transport fails', async () => {
    const { transport, Wrapper } = createWrapper();
    vi.mocked(transport.listSchedules).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useSchedules(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
  });
});
```

#### 3. Testing `useMutation` hooks (useCreateSchedule, useUpdateSchedule, useDeleteSchedule)

The key for mutation tests is calling `.mutate()` inside `act()` and waiting for state transitions:

```typescript
import { act } from '@testing-library/react';

describe('useCreateSchedule', () => {
  it('invalidates schedules query on success', async () => {
    const { transport, queryClient, Wrapper } = createWrapper();
    const newSchedule = { id: 's2', name: 'New job' };
    vi.mocked(transport.createSchedule).mockResolvedValue(newSchedule);

    // Pre-populate the cache to verify invalidation
    queryClient.setQueryData(['pulse', 'schedules'], []);

    const { result } = renderHook(() => useCreateSchedule(), { wrapper: Wrapper });

    act(() => {
      result.current.mutate({ name: 'New job', prompt: 'Do stuff', cron: '0 2 * * *' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New job' })
    );
  });
});
```

#### 4. Testing UI components at integration level

For `PulsePanel`, render the full component with a mock Transport that returns fixture schedules. Do not mock TanStack Query internals — test that the component renders the right UI given the data:

```typescript
// apps/client/src/layers/features/pulse/__tests__/PulsePanel.test.tsx
/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMockTransport } from '@dorkos/test-utils';

const mockSchedule = {
  id: 's1',
  name: 'Daily review',
  cron: '0 9 * * 1-5',
  enabled: true,
  status: 'active',
  prompt: 'Review PRs',
  createdAt: new Date().toISOString(),
};

function renderPulsePanel() {
  const transport = createMockTransport();
  vi.mocked(transport.listSchedules).mockResolvedValue([mockSchedule]);

  render(
    <Wrapper transport={transport}>
      <PulsePanel />
    </Wrapper>
  );

  return { transport };
}

it('renders schedule names', async () => {
  renderPulsePanel();
  await waitFor(() => expect(screen.getByText('Daily review')).toBeInTheDocument());
});

it('opens edit dialog when edit button is clicked', async () => {
  const user = userEvent.setup();
  renderPulsePanel();

  await waitFor(() => screen.getByText('Daily review'));
  await user.click(screen.getByRole('button', { name: /edit daily review/i }));

  expect(screen.getByText('Edit Schedule')).toBeInTheDocument();
});
```

#### 5. Unit vs integration testing decision

**Hook unit tests:** Test hooks separately when the hook has non-trivial logic (query key structure, error handling, cache invalidation side effects). `useSchedules`, `useRuns`, and the mutation hooks all invalidate specific query keys — this logic is worth verifying directly via `renderHook`.

**Component integration tests:** Do not mock TanStack Query internals inside component tests. Render the real hooks backed by a mock Transport. This gives higher confidence that the data flows correctly from Transport through Query to the rendered UI, which is the thing most likely to break in practice.

**What not to test:** The internal form state of `CreateScheduleDialog` does not need exhaustive unit tests — it is controlled state that resets on open/close. Test the dialog's submit behavior (calls the right mutation with the right args) and the edit mode switch (title becomes "Edit Schedule", fields are pre-filled).

### Pitfalls to Avoid

- **Never share a `QueryClient` instance across tests.** React Query's cache is global within a client. Cross-test data contamination causes flaky ordering-dependent failures. Create a new instance per test via the factory function.
- **Always set `retry: false` in test QueryClients.** The default retry count is 3 with exponential backoff. A failing query test will wait ~14 seconds before declaring an error without this setting.
- **Do not use `vi.mock('@tanstack/react-query')`.** Mocking the library itself means you are no longer testing the hook's interaction with React Query — you are testing nothing. Mock the Transport instead.
- **Do not use arbitrary `setTimeout` delays.** Always use `waitFor(() => ...)` with an assertion. This is called out as an anti-pattern in the project's own `.claude/rules/testing.md`.
- **Do not test implementation details** like internal state variable values. Test observable behavior: what the component renders, what functions were called.

---

## Gap 4: Testing MCP Tool Server Handler Behavior

### Recommended Approach

Extend the existing `mcp-tool-server.test.ts` using the handler factory pattern already established there. Each Pulse handler factory (`createListSchedulesHandler`, `createCreateScheduleHandler`, etc.) takes a `McpToolDeps` object and returns an async function — call the returned function directly in tests, with a mock `PulseStore` provided via `McpToolDeps`. This is the exact pattern used for `createGetSessionCountHandler` tests in the existing file.

### Key Implementation Patterns

#### 1. Extend `makeMockDeps()` to include a mock `PulseStore`

The existing `makeMockDeps()` function in `mcp-tool-server.test.ts` only provides `transcriptReader` and `defaultCwd`. Add `pulseStore` via a separate factory that builds per-test mock stores:

```typescript
import type { PulseStore } from '../pulse-store.js';

const mockSchedule = {
  id: 'sched-1',
  name: 'Daily job',
  cron: '0 9 * * 1-5',
  enabled: true,
  status: 'active' as const,
  prompt: 'Do work',
  cwd: null,
  timezone: null,
  maxRuntime: null,
  permissionMode: 'acceptEdits' as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function makeMockPulseStore(overrides: Partial<PulseStore> = {}): PulseStore {
  return {
    getSchedules: vi.fn().mockReturnValue([mockSchedule]),
    getSchedule: vi.fn().mockReturnValue(mockSchedule),
    createSchedule: vi.fn().mockReturnValue(mockSchedule),
    updateSchedule: vi.fn().mockReturnValue(mockSchedule),
    deleteSchedule: vi.fn().mockReturnValue(true),
    listRuns: vi.fn().mockReturnValue([]),
    createRun: vi.fn(),
    updateRun: vi.fn(),
    markRunningAsFailed: vi.fn().mockReturnValue(0),
    pruneRuns: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as unknown as PulseStore;
}

function makePulseDeps(storeOverrides: Partial<PulseStore> = {}): McpToolDeps {
  return {
    ...makeMockDeps(),
    pulseStore: makeMockPulseStore(storeOverrides),
  };
}
```

#### 2. Test each handler factory directly

Each handler factory returns an async function. Invoke it directly — no server wrapping needed:

```typescript
describe('createListSchedulesHandler', () => {
  it('returns all schedules by default', async () => {
    const handler = createListSchedulesHandler(makePulseDeps());
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.schedules[0].id).toBe('sched-1');
  });

  it('filters to enabled_only when flag is set', async () => {
    const disabledSchedule = { ...mockSchedule, id: 'sched-2', enabled: false };
    const getSchedules = vi.fn().mockReturnValue([mockSchedule, disabledSchedule]);
    const handler = createListSchedulesHandler(makePulseDeps({ getSchedules }));
    const result = await handler({ enabled_only: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.schedules[0].id).toBe('sched-1');
  });

  it('returns error when pulseStore is undefined', async () => {
    const deps = { ...makeMockDeps() };  // no pulseStore
    const handler = createListSchedulesHandler(deps);
    const result = await handler({});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('not enabled');
  });
});

describe('createCreateScheduleHandler', () => {
  it('creates schedule and marks it pending_approval', async () => {
    const createSchedule = vi.fn().mockReturnValue({ ...mockSchedule, id: 'new-1' });
    const updateSchedule = vi.fn().mockReturnValue({ ...mockSchedule, id: 'new-1', status: 'pending_approval' });
    const getSchedule = vi.fn().mockReturnValue({ ...mockSchedule, id: 'new-1', status: 'pending_approval' });
    const handler = createCreateScheduleHandler(makePulseDeps({ createSchedule, updateSchedule, getSchedule }));

    const result = await handler({ name: 'New job', prompt: 'Do stuff', cron: '0 2 * * *' });
    const parsed = JSON.parse(result.content[0].text);

    expect(createSchedule).toHaveBeenCalledWith(expect.objectContaining({ name: 'New job' }));
    expect(updateSchedule).toHaveBeenCalledWith('new-1', { status: 'pending_approval' });
    expect(parsed.note).toContain('pending_approval');
  });
});

describe('createDeleteScheduleHandler', () => {
  it('returns success when schedule exists', async () => {
    const handler = createDeleteScheduleHandler(makePulseDeps());
    const result = await handler({ id: 'sched-1' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.id).toBe('sched-1');
  });

  it('returns error when schedule not found', async () => {
    const deleteSchedule = vi.fn().mockReturnValue(false);
    const handler = createDeleteScheduleHandler(makePulseDeps({ deleteSchedule }));
    const result = await handler({ id: 'missing' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('not found');
  });
});
```

#### 3. What the existing tests already cover vs what they do not

The existing `createDorkOsToolServer` tests verify:
- Server name and version are correct
- 8 tools are registered with the right names

They do NOT verify:
- Handler return value shapes for Pulse tools
- The `requirePulse()` guard across all handlers
- `enabled_only` filter logic in `createListSchedulesHandler`
- `pending_approval` enforcement in `createCreateScheduleHandler`
- Not-found error paths in update/delete handlers
- `limit` param behavior in `createGetRunHistoryHandler`

All of these are the high-value test targets — logic paths that could silently regress.

#### 4. Whether to test through the server interface or handler directly

Test handlers directly. The server interface (`createDorkOsToolServer`) is a wiring function — it assembles tools from the already-tested handler factories. The existing registration tests verify the wiring. Handler tests verify the logic. These are complementary and should be kept separate.

The factory function pattern in `mcp-tool-server.ts` (extracting handlers before passing to `tool()`) was designed precisely for testability — this is the pattern to exploit.

### Pitfalls to Avoid

- **Do not instantiate `PulseStore` directly in tests.** `PulseStore` has SQLite dependencies (`better-sqlite3`). Mocking it via `makeMockPulseStore()` keeps tests fast and hermetic.
- **Do not import `createSdkMcpServer` or `tool()` in handler tests.** Handler tests work entirely with the extracted factory functions — the SDK mock in the test file is only needed for `createDorkOsToolServer` registration tests. Handler tests do not need it.
- **Always test the `pulseStore === undefined` path** for every Pulse handler. The `requirePulse()` guard is shared infrastructure — a bug there would silently break all five handlers. This is the most important cross-cutting test.
- **Do not use `as any` to bypass typing in mock deps.** Use `as unknown as PulseStore` as shown above — this gives the compiler a chance to catch when the real `PulseStore` interface changes.
- **Test the error path for `updateSchedule` returning null.** The handler returns `isError: true` when the store returns `null` (schedule not found). Without a test, this path is invisible.

---

## Sources & Evidence

- [Claude Agent SDK — Modifying System Prompts](https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts) — Confirms `append` is session-scoped and how to combine preset with custom text
- [Claude Agent SDK — TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) — `query()` options interface including `systemPrompt`
- [TanStack Query v5 — Testing Guide](https://tanstack.com/query/v5/docs/framework/react/guides/testing) — Official guidance on `renderHook`, `QueryClient` isolation, retry configuration
- [Testing React Query — Dominik Dorfmeister (tkdodo)](https://tkdodo.eu/blog/testing-react-query) — Definitive community guide on `retry: false`, wrapper pattern, MSW integration
- [TanStack Query Testing Strategies — DeepWiki](https://deepwiki.com/TanStack/query/5.4-testing-strategies) — Internal test suite patterns: unit vs integration layering
- [Unit Testing MCP Servers — MCPcat](https://mcpcat.io/guides/writing-unit-tests-mcp-servers/) — Handler isolation, dependency mocking, fixture-based test server patterns
- [Best Practices for Actions in Data Tables — UX World](https://uxdworld.com/best-practices-for-providing-actions-in-data-tables/) — Inline vs overflow menu decision rule (3 or fewer = inline)
- [PatternFly — Overflow Menu Design Guidelines](https://www.patternfly.org/components/overflow-menu/design-guidelines/) — Inline persistence, hover behavior, primary vs secondary action split
- [Data Table Design UX Patterns — Pencil & Paper](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables) — Row action placement, visibility, and keyboard nav patterns

---

## Research Gaps & Limitations

- The TanStack Query v5 docs redirect (303) prevented direct page fetch; the tkdodo blog and DeepWiki provided equivalent content.
- MCP testing guidance is primarily Python-focused in available docs; the TypeScript patterns were synthesized from the existing codebase's handler factory pattern and general TypeScript mock patterns.
- `createMockTransport()` from `@dorkos/test-utils` is referenced in testing patterns — its exact API was not read but inferred from `CLAUDE.md` and the testing rules.

---

## Search Methodology

- Searches performed: 10 (4 parallel initial + 4 parallel follow-up + 2 targeted)
- Most productive search terms: `Claude Agent SDK query systemPrompt append`, `TanStack Query renderHook mock QueryClient vitest`, `MCP tool handler unit test factory pattern`
- Primary sources: Claude platform official docs, TanStack Query official docs + tkdodo blog, existing DorkOS codebase
- Codebase files read: `scheduler-service.ts`, `agent-manager.ts` (lines 1–160), `mcp-tool-server.ts`, `mcp-tool-server.test.ts`, `PulsePanel.tsx`, `CreateScheduleDialog.tsx`, `use-schedules.ts`, `entities/pulse/index.ts`
