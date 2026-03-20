# Agent Selector Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the radio group + combobox agent/directory selector with a direct agent list that collapses after selection, demoting directory mode to a quiet escape hatch.

**Architecture:** New `AgentPicker` component replaces both the radio group and `AgentCombobox` in `CreateScheduleDialog`. The `AgentCombobox` is deleted. Internal `scheduleTarget` state is kept but toggled via escape hatch links instead of radio buttons.

**Tech Stack:** React 19, Tailwind CSS 4, lucide-react icons, motion/react for animations, existing `ScrollArea` and `Input` from `@/layers/shared/ui`.

**Design doc:** `plans/2026-03-10-agent-selector-redesign.md` (original design — this file now contains both design context and implementation plan)

---

## Design Context

### Problem

The current CreateScheduleDialog presents "Run for agent" vs "Run in directory" as an equal-weight radio group. 90% of users will select an existing agent — the radio group forces an unnecessary decision.

### Solution

A flat agent list that IS the selector. Select an agent by clicking its row. The list collapses to a single selected row. Directory mode is a text link escape hatch below.

### Interaction States

| State                           | What the user sees                                             |
| ------------------------------- | -------------------------------------------------------------- |
| No agents, agent mode           | Empty state message + directory escape hatch                   |
| Agents exist, none selected     | Full agent list (expanded) + directory escape hatch            |
| Agent selected                  | Collapsed single row with pencil icon + directory escape hatch |
| Directory mode                  | Directory picker + "Back to agent selection" link              |
| Editing (agent-linked schedule) | Collapsed single row (pre-selected) + directory escape hatch   |
| Editing (directory schedule)    | Directory picker (pre-filled) + "Back to agent selection" link |

### Visual Identity (Agent Rows)

Each row: color dot (2px circle) + emoji icon + agent name (font-medium) + project path (muted, truncated).

---

## Task 1: Create AgentPicker Component with Tests

**Files:**

- Create: `apps/client/src/layers/features/pulse/ui/AgentPicker.tsx`
- Create: `apps/client/src/layers/features/pulse/__tests__/AgentPicker.test.tsx`

### Step 1: Write the failing test

Create `apps/client/src/layers/features/pulse/__tests__/AgentPicker.test.tsx`:

```tsx
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AgentPicker } from '../ui/AgentPicker';

const MOCK_AGENTS = [
  { id: 'agent-1', name: 'api-bot', projectPath: '/projects/api', icon: '🤖', color: '#6366f1' },
  { id: 'agent-2', name: 'test-bot', projectPath: '/projects/test', icon: '🧪', color: '#22c55e' },
  {
    id: 'agent-3',
    name: 'docs-writer',
    projectPath: '/projects/docs',
    icon: '📝',
    color: '#f59e0b',
  },
];

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe('AgentPicker', () => {
  describe('expanded state', () => {
    it('renders all agents as selectable rows', () => {
      render(<AgentPicker agents={MOCK_AGENTS} value={undefined} onValueChange={vi.fn()} />);

      expect(screen.getByText('api-bot')).toBeInTheDocument();
      expect(screen.getByText('test-bot')).toBeInTheDocument();
      expect(screen.getByText('docs-writer')).toBeInTheDocument();
    });

    it('calls onValueChange when an agent row is clicked', () => {
      const onValueChange = vi.fn();
      render(<AgentPicker agents={MOCK_AGENTS} value={undefined} onValueChange={onValueChange} />);

      fireEvent.click(screen.getByText('api-bot'));
      expect(onValueChange).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('collapsed state', () => {
    it('shows only the selected agent when value is set', () => {
      render(<AgentPicker agents={MOCK_AGENTS} value="agent-1" onValueChange={vi.fn()} />);

      expect(screen.getByText('api-bot')).toBeInTheDocument();
      // Other agents should NOT be visible in collapsed state
      expect(screen.queryByText('test-bot')).not.toBeInTheDocument();
      expect(screen.queryByText('docs-writer')).not.toBeInTheDocument();
    });

    it('shows pencil icon in collapsed state', () => {
      render(<AgentPicker agents={MOCK_AGENTS} value="agent-1" onValueChange={vi.fn()} />);

      expect(screen.getByLabelText('Change agent')).toBeInTheDocument();
    });

    it('expands when collapsed row is clicked', () => {
      render(<AgentPicker agents={MOCK_AGENTS} value="agent-1" onValueChange={vi.fn()} />);

      fireEvent.click(screen.getByLabelText('Change agent'));

      // All agents should now be visible
      expect(screen.getByText('api-bot')).toBeInTheDocument();
      expect(screen.getByText('test-bot')).toBeInTheDocument();
      expect(screen.getByText('docs-writer')).toBeInTheDocument();
    });

    it('deselects agent when clicking the already-selected agent in expanded mode', () => {
      const onValueChange = vi.fn();
      const { rerender } = render(
        <AgentPicker agents={MOCK_AGENTS} value="agent-1" onValueChange={onValueChange} />
      );

      // Expand
      fireEvent.click(screen.getByLabelText('Change agent'));

      // Click the already-selected agent
      fireEvent.click(screen.getByText('api-bot'));
      expect(onValueChange).toHaveBeenCalledWith(undefined);
    });
  });

  describe('empty state', () => {
    it('shows empty message when no agents exist', () => {
      render(<AgentPicker agents={[]} value={undefined} onValueChange={vi.fn()} />);

      expect(screen.getByText(/No agents registered yet/)).toBeInTheDocument();
    });
  });

  describe('search filter', () => {
    it('shows search input when 8+ agents exist', () => {
      const manyAgents = Array.from({ length: 10 }, (_, i) => ({
        id: `agent-${i}`,
        name: `bot-${i}`,
        projectPath: `/projects/p${i}`,
      }));
      render(<AgentPicker agents={manyAgents} value={undefined} onValueChange={vi.fn()} />);

      expect(screen.getByPlaceholderText('Search agents...')).toBeInTheDocument();
    });

    it('does not show search input when fewer than 8 agents', () => {
      render(<AgentPicker agents={MOCK_AGENTS} value={undefined} onValueChange={vi.fn()} />);

      expect(screen.queryByPlaceholderText('Search agents...')).not.toBeInTheDocument();
    });

    it('filters agents by name when searching', () => {
      const manyAgents = Array.from({ length: 10 }, (_, i) => ({
        id: `agent-${i}`,
        name: `bot-${i}`,
        projectPath: `/projects/p${i}`,
      }));
      render(<AgentPicker agents={manyAgents} value={undefined} onValueChange={vi.fn()} />);

      fireEvent.change(screen.getByPlaceholderText('Search agents...'), {
        target: { value: 'bot-3' },
      });

      expect(screen.getByText('bot-3')).toBeInTheDocument();
      expect(screen.queryByText('bot-0')).not.toBeInTheDocument();
    });
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm --filter @dorkos/client exec vitest run src/layers/features/pulse/__tests__/AgentPicker.test.tsx`
Expected: FAIL — module `../ui/AgentPicker` not found

### Step 3: Write the AgentPicker component

Create `apps/client/src/layers/features/pulse/ui/AgentPicker.tsx`:

```tsx
import { useState } from 'react';
import { Check, Pencil } from 'lucide-react';
import { ScrollArea } from '@/layers/shared/ui';
import { Input } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { hashToHslColor, hashToEmoji } from '@/layers/shared/lib/favicon-utils';
import { shortenHomePath } from '@/layers/shared/lib';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

const SEARCH_THRESHOLD = 8;

interface AgentPickerProps {
  agents: AgentPathEntry[];
  value: string | undefined;
  onValueChange: (value: string | undefined) => void;
}

/** Direct agent list selector — collapses to a single row after selection. */
export function AgentPicker({ agents, value, onValueChange }: AgentPickerProps) {
  const [expanded, setExpanded] = useState(!value);
  const [search, setSearch] = useState('');

  const selectedAgent = agents.find((a) => a.id === value);
  const showSearch = agents.length >= SEARCH_THRESHOLD;

  const filteredAgents = search
    ? agents.filter(
        (a) =>
          a.name.toLowerCase().includes(search.toLowerCase()) ||
          a.projectPath.toLowerCase().includes(search.toLowerCase())
      )
    : agents;

  function handleSelect(agentId: string) {
    if (agentId === value) {
      onValueChange(undefined);
    } else {
      onValueChange(agentId);
      setExpanded(false);
      setSearch('');
    }
  }

  function handleExpand() {
    setExpanded(true);
  }

  // Empty state
  if (agents.length === 0) {
    return (
      <div className="rounded-md border px-4 py-6 text-center">
        <p className="text-muted-foreground text-sm">No agents registered yet</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Register an agent via the Mesh panel to schedule automated tasks.
        </p>
      </div>
    );
  }

  // Collapsed state — show selected agent only
  if (selectedAgent && !expanded) {
    return (
      <button
        type="button"
        onClick={handleExpand}
        aria-label="Change agent"
        className={cn(
          'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
          'hover:bg-accent/50'
        )}
      >
        <span
          className="inline-block size-2 shrink-0 rounded-full"
          style={{ backgroundColor: selectedAgent.color ?? hashToHslColor(selectedAgent.id) }}
        />
        <span className="text-xs leading-none">
          {selectedAgent.icon ?? hashToEmoji(selectedAgent.id)}
        </span>
        <span className="truncate font-medium">{selectedAgent.name}</span>
        <span className="text-muted-foreground truncate text-xs">
          {shortenHomePath(selectedAgent.projectPath)}
        </span>
        <Pencil className="text-muted-foreground ml-auto size-3.5 shrink-0" />
      </button>
    );
  }

  // Expanded state — full agent list
  return (
    <div className="space-y-2">
      {showSearch && (
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents..."
          className="h-8 text-sm"
        />
      )}
      <ScrollArea className="max-h-[200px]">
        <div className="space-y-1">
          {filteredAgents.map((agent) => {
            const isSelected = agent.id === value;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => handleSelect(agent.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                )}
              >
                <span
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: agent.color ?? hashToHslColor(agent.id) }}
                />
                <span className="text-xs leading-none">{agent.icon ?? hashToEmoji(agent.id)}</span>
                <span className="truncate font-medium">{agent.name}</span>
                <span className="text-muted-foreground truncate text-xs">
                  {shortenHomePath(agent.projectPath)}
                </span>
                {isSelected && <Check className="ml-auto size-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
```

### Step 4: Run test to verify it passes

Run: `pnpm --filter @dorkos/client exec vitest run src/layers/features/pulse/__tests__/AgentPicker.test.tsx`
Expected: all tests PASS

### Step 5: Commit

```bash
git add apps/client/src/layers/features/pulse/ui/AgentPicker.tsx apps/client/src/layers/features/pulse/__tests__/AgentPicker.test.tsx
git commit -m "feat(pulse): add AgentPicker component with direct list selection

Replaces the combobox dropdown with a flat agent list that collapses
to a single selected row. Includes search filter for 8+ agents and
empty state for zero agents."
```

---

## Task 2: Integrate AgentPicker into CreateScheduleDialog

**Files:**

- Modify: `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`
- Modify: `apps/client/src/layers/features/pulse/__tests__/CreateScheduleDialog.test.tsx`

### Step 1: Write failing tests for the new interaction pattern

Replace the `describe('schedule target radio group')` block in `CreateScheduleDialog.test.tsx` with tests for the new agent picker + directory escape hatch pattern:

```tsx
describe('agent picker and directory escape hatch', () => {
  it('shows agent list when agents exist (no radio buttons)', async () => {
    const transport = createMockTransport({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: MOCK_AGENTS }),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText('api-bot')).toBeTruthy();
    });
    expect(screen.getByText('test-bot')).toBeTruthy();
    // No radio buttons
    expect(screen.queryByLabelText('Run for agent')).toBeNull();
    expect(screen.queryByLabelText('Run in directory')).toBeNull();
  });

  it('shows directory escape hatch link', async () => {
    const transport = createMockTransport({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: MOCK_AGENTS }),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText(/Run in a specific directory instead/)).toBeTruthy();
    });
  });

  it('switches to directory picker when escape hatch is clicked', async () => {
    const transport = createMockTransport({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: MOCK_AGENTS }),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText(/Run in a specific directory instead/)).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/Run in a specific directory instead/));

    expect(screen.getByText('Working Directory')).toBeTruthy();
    expect(screen.getByText(/Back to agent selection/)).toBeTruthy();
    // Agents should not be visible
    expect(screen.queryByText('api-bot')).toBeNull();
  });

  it('switches back to agent list from directory mode', async () => {
    const transport = createMockTransport({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: MOCK_AGENTS }),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText(/Run in a specific directory instead/)).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/Run in a specific directory instead/));
    fireEvent.click(screen.getByText(/Back to agent selection/));

    await waitFor(() => {
      expect(screen.getByText('api-bot')).toBeTruthy();
    });
  });

  it('shows empty state when no agents exist', async () => {
    const transport = createMockTransport({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [] }),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText(/No agents registered yet/)).toBeTruthy();
    });
    // Escape hatch still available
    expect(screen.getByText(/Run in a specific directory instead/)).toBeTruthy();
  });

  it('submits with agentId when agent is selected', async () => {
    const newSchedule = createMockSchedule({ id: 'sched-new', agentId: 'agent-1' });
    const transport = createMockTransport({
      createSchedule: vi.fn().mockResolvedValue(newSchedule),
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: MOCK_AGENTS }),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    // Select agent directly from the list
    await waitFor(() => {
      expect(screen.getByText('api-bot')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('api-bot'));

    // Fill required fields
    fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
      target: { value: 'Agent run' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('Review all pending PRs and summarize findings...'),
      { target: { value: 'Do something' } }
    );
    fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), {
      target: { value: '0 0 * * *' },
    });

    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(transport.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-1' })
      );
    });
  });

  it('submits without agentId in directory mode', async () => {
    const newSchedule = createMockSchedule({ id: 'sched-new' });
    const transport = createMockTransport({
      createSchedule: vi.fn().mockResolvedValue(newSchedule),
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [] }),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    // Switch to directory mode
    await waitFor(() => {
      expect(screen.getByText(/Run in a specific directory instead/)).toBeTruthy();
    });
    fireEvent.click(screen.getByText(/Run in a specific directory instead/));

    // Fill required fields
    fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
      target: { value: 'Dir run' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('Review all pending PRs and summarize findings...'),
      { target: { value: 'Do something' } }
    );
    fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), {
      target: { value: '0 0 * * *' },
    });

    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(transport.createSchedule).toHaveBeenCalledWith(
        expect.not.objectContaining({ agentId: expect.anything() })
      );
    });
  });

  it('pre-selects agent in collapsed state when editing agent-linked schedule', async () => {
    const schedule = createMockSchedule({
      id: 'sched-1',
      name: 'Agent schedule',
      prompt: 'Do things',
      cron: '0 9 * * 1-5',
      agentId: 'agent-1',
    });
    const transport = createMockTransport({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: MOCK_AGENTS }),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} editSchedule={schedule} />
      </Wrapper>
    );

    // Should show collapsed row with the selected agent
    await waitFor(() => {
      expect(screen.getByText('api-bot')).toBeTruthy();
    });
    // Other agents should not be visible (collapsed)
    expect(screen.queryByText('test-bot')).toBeNull();
    // Pencil icon should be present
    expect(screen.getByLabelText('Change agent')).toBeTruthy();
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm --filter @dorkos/client exec vitest run src/layers/features/pulse/__tests__/CreateScheduleDialog.test.tsx`
Expected: FAIL — tests reference new UI patterns not yet implemented

### Step 3: Update CreateScheduleDialog

Modify `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`:

**Changes summary:**

1. Replace import of `AgentCombobox` with `AgentPicker`
2. Remove `Bot` from lucide imports (no longer needed for radio group)
3. Remove the entire radio group + conditional agent/directory section (lines 163-233 in current file)
4. Replace with: `AgentPicker` + escape hatch link (agent mode) or directory picker + back link (directory mode)
5. Update `scheduleTarget` initialization: always default to `'agent'` (no more `agents.length` check for initial state since the empty state handles this)

The new agent section at the top of the form body should look like:

```tsx
{
  /* ── Agent ── */
}
{
  scheduleTarget === 'agent' ? (
    <div className="space-y-2">
      <Label>Agent</Label>
      <AgentPicker
        agents={agents}
        value={form.agentId}
        onValueChange={(id) => updateField('agentId', id)}
      />
      <button
        type="button"
        onClick={() => {
          setScheduleTarget('directory');
          updateField('agentId', undefined);
        }}
        className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
      >
        Run in a specific directory instead...
      </button>
    </div>
  ) : (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setScheduleTarget('agent')}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs underline-offset-4 hover:underline"
      >
        <ChevronLeft className="size-3" />
        Back to agent selection
      </button>
      <Label htmlFor="schedule-cwd">Working Directory</Label>
      <div className="flex gap-2">
        <div
          className={cn(
            'flex-1 truncate rounded-md border px-3 py-2 font-mono text-sm',
            form.cwd ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {form.cwd || 'Default (server working directory)'}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={() => setCwdPickerOpen(true)}
          aria-label="Browse directories"
        >
          <FolderOpen className="size-4" />
        </Button>
      </div>
    </div>
  );
}
```

**Import changes:**

- Remove: `Bot` from lucide-react
- Add: `ChevronLeft` from lucide-react
- Replace: `import { AgentCombobox } from './AgentCombobox'` → `import { AgentPicker } from './AgentPicker'`

**State initialization change in useEffect:**

- Remove `agents.length > 0 ? 'agent' : 'directory'` logic — always default to `'agent'`
- Edit schedule with `agentId` → `'agent'`, with `cwd` and no `agentId` → `'directory'`, otherwise → `'agent'`

### Step 4: Run tests to verify they pass

Run: `pnpm --filter @dorkos/client exec vitest run src/layers/features/pulse/__tests__/CreateScheduleDialog.test.tsx`
Expected: all tests PASS

### Step 5: Run typecheck

Run: `pnpm --filter @dorkos/client exec tsc --noEmit`
Expected: no errors

### Step 6: Commit

```bash
git add apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx apps/client/src/layers/features/pulse/__tests__/CreateScheduleDialog.test.tsx
git commit -m "feat(pulse): integrate AgentPicker into CreateScheduleDialog

Remove radio group and AgentCombobox. Agent selection is now a direct
list at the top of the form. Directory mode is a quiet escape hatch
link below the agent picker."
```

---

## Task 3: Delete AgentCombobox and Clean Up Exports

**Files:**

- Delete: `apps/client/src/layers/features/pulse/ui/AgentCombobox.tsx`
- Modify: `apps/client/src/layers/features/pulse/index.ts` (if AgentCombobox was exported)

### Step 1: Check if AgentCombobox is imported anywhere else

Run: `rg "AgentCombobox" apps/client/src/ --files-with-matches`

If only referenced by `CreateScheduleDialog.tsx` (now updated to use `AgentPicker`), proceed with deletion.

### Step 2: Delete AgentCombobox

```bash
rm apps/client/src/layers/features/pulse/ui/AgentCombobox.tsx
```

### Step 3: Run full test suite for pulse feature

Run: `pnpm --filter @dorkos/client exec vitest run src/layers/features/pulse/`
Expected: all tests PASS

### Step 4: Run typecheck

Run: `pnpm --filter @dorkos/client exec tsc --noEmit`
Expected: no errors

### Step 5: Commit

```bash
git add -A apps/client/src/layers/features/pulse/
git commit -m "refactor(pulse): delete AgentCombobox, replaced by AgentPicker

The combobox dropdown pattern has been superseded by the direct agent
list in AgentPicker."
```

---

## Task 4: Update Pre-fill Edit Mode Test for Directory Schedules

**Files:**

- Modify: `apps/client/src/layers/features/pulse/__tests__/CreateScheduleDialog.test.tsx`

### Step 1: Verify the existing `pre-fills form fields in edit mode` test

The existing test at line 105 edits a schedule with `cwd: '/projects/app'` (no `agentId`). This should now trigger directory mode automatically. Verify the test still passes — it should because the `scheduleTarget` initialization logic routes `cwd`-only schedules to directory mode.

Run: `pnpm --filter @dorkos/client exec vitest run src/layers/features/pulse/__tests__/CreateScheduleDialog.test.tsx`
Expected: all tests PASS

If the test fails because it expects `/projects/app` to be visible but directory mode needs to be active first, update the test's schedule to include `agentId: undefined` explicitly and verify the escape hatch correctly shows the directory picker with the pre-filled path.

### Step 2: Commit if changes were needed

```bash
git add apps/client/src/layers/features/pulse/__tests__/CreateScheduleDialog.test.tsx
git commit -m "test(pulse): update edit mode tests for new agent picker flow"
```

---

## Task 5: Final Verification

### Step 1: Run full client test suite

Run: `pnpm --filter @dorkos/client exec vitest run`
Expected: all tests PASS

### Step 2: Run typecheck

Run: `pnpm --filter @dorkos/client exec tsc --noEmit`
Expected: no errors

### Step 3: Run lint

Run: `pnpm --filter @dorkos/client exec eslint src/layers/features/pulse/`
Expected: no errors

### Step 4: Manual smoke test

Run: `pnpm dev`
Open the app, navigate to Pulse, click "New Schedule":

- Verify agent list appears at top of form
- Click an agent → list collapses to single row with pencil icon
- Click pencil → list re-expands
- Click "Run in a specific directory instead..." → directory picker appears
- Click "Back to agent selection" → agent list returns
- Edit an agent-linked schedule → opens in collapsed state
- Edit a directory schedule → opens in directory mode
