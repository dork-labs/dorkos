/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import type { Task } from '@dorkos/shared/types';

vi.mock('cronstrue', () => ({
  default: { toString: (cron: string) => `Every: ${cron}` },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

// Shallow-render TaskRunHistoryPanel to avoid deep fetching in ScheduleRow tests
vi.mock('../ui/TaskRunHistoryPanel', () => ({
  TaskRunHistoryPanel: ({ scheduleId }: { scheduleId: string }) => (
    <div data-testid="run-history">{scheduleId}</div>
  ),
}));

// Import after vi.mock calls
import { TaskRow } from '../ui/TaskRow';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const activeSchedule: Task = {
  id: 'sched-1',
  name: 'Daily Review',
  prompt: 'Review code',
  cron: '0 9 * * *',
  enabled: true,
  sticky: false,
  status: 'active',
  agentId: null,
  timezone: null,
  defaultCron: '0 9 * * *',
  defaultTimezone: null,
  timingOverridden: false,
  packageOwned: null,
  approvalChanges: [],
  maxRuntime: null,
  permissionMode: 'acceptEdits',
  runtime: null,
  model: null,
  effort: null,
  filePath: '/home/user/.dork/tasks/sched-1.json',
  nextRun: new Date(Date.now() + 3600000).toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  reason: null,
  proposedBySessionId: null,
  proposedByAgentPath: null,
  proposedByName: null,
  origin: null,
  reasonSource: null,
  nextRuns: [],
};

const scheduleWithOrphanedAgent: Task = {
  ...activeSchedule,
  id: 'sched-5',
  name: 'Orphan Schedule',
  agentId: 'missing-agent-id',
};

const pendingSchedule: Task = {
  ...activeSchedule,
  id: 'sched-2',
  name: 'Pending Task',
  status: 'pending_approval',
};

const disabledSchedule: Task = {
  ...activeSchedule,
  id: 'sched-3',
  name: 'Disabled Task',
  enabled: false,
};

// A package-shipped schedule found switched off. Discovery still parks it at
// `pending_approval` — the row itself does not change — but nobody asked for
// it to run, so it must draw exactly like `disabledSchedule` above: a normal
// switched-off task, no card, no reason line (DOR-2059).
const offByDefaultSchedule: Task = {
  ...activeSchedule,
  id: 'sched-4',
  name: 'Off By Default Task',
  status: 'pending_approval',
  enabled: false,
  origin: 'file',
  filePath: '/home/user/.dork/plugins/flow/skills/flow-drain/SKILL.md',
  reason:
    'DorkOS found this schedule in a file on your computer. Nothing runs on a timer until you say so — read what it does below, then approve it or delete it.',
};

// An agent's OWN proposal, switched off by the same agent (`enabled` is
// agent-writable, `origin` is `null` — no update path ever sets it to
// `'file'`). This must NOT draw like `offByDefaultSchedule` above: an agent
// cannot hide its own proposal by flipping `enabled` (adversarial review).
const agentHidOwnProposal: Task = {
  ...pendingSchedule,
  id: 'sched-7',
  name: 'Agent Proposal Switched Off',
  enabled: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {/* The override chip's runtime mark is a tooltip, and the app mounts one
          provider at its root (`AppShell`). Without it here Radix throws the
          moment a task carries a runtime. */}
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

function renderScheduleRow(
  schedule: Task,
  opts: { expanded?: boolean; onEdit?: () => void; onToggleExpand?: () => void } = {},
  transport?: Transport
) {
  const { expanded = false, onEdit = vi.fn(), onToggleExpand = vi.fn() } = opts;
  const t = transport ?? createMockTransport();
  const Wrapper = createWrapper(t);
  return render(
    <Wrapper>
      <TaskRow
        task={schedule}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        onEdit={onEdit}
      />
    </Wrapper>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScheduleRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders active schedule with name and cron description', () => {
    renderScheduleRow(activeSchedule);

    expect(screen.getByText('Daily Review')).toBeTruthy();
    // cronstrue mock returns "Every: <cron>"
    expect(screen.getByText(/Every: 0 9 \* \* \*/)).toBeTruthy();
  });

  it('shows Switch toggle for active schedules', () => {
    renderScheduleRow(activeSchedule);

    // Radix Switch renders with role="switch"
    expect(screen.getByRole('switch')).toBeTruthy();
  });

  it('shows Switch toggle for disabled schedules', () => {
    renderScheduleRow(disabledSchedule);

    expect(screen.getByRole('switch')).toBeTruthy();
  });

  // A removed schedule keeps the person's `enabled` (FB-26) but runs nothing, so
  // the row must not read as switched on.
  describe('a paused schedule whose file is gone', () => {
    const removedSchedule: Task = { ...activeSchedule, id: 'sched-6', status: 'paused' };

    it('shows its switch off and not flippable, even though enabled is still true', () => {
      renderScheduleRow(removedSchedule);

      const toggle = screen.getByRole('switch');
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      expect(toggle).toBeDisabled();
    });

    it('keeps an active schedule switched on and flippable', () => {
      renderScheduleRow(activeSchedule);

      const toggle = screen.getByRole('switch');
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(toggle).not.toBeDisabled();
    });

    it('offers no Run Now', async () => {
      renderScheduleRow(removedSchedule);

      const trigger = screen.getByLabelText(`Actions for ${removedSchedule.name}`);
      await act(async () => {
        fireEvent.pointerDown(trigger);
        fireEvent.mouseDown(trigger);
        fireEvent.click(trigger);
      });

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /Run Now/i })).toHaveAttribute('data-disabled');
      });
    });
  });

  it('shows Approve and Reject buttons for pending_approval schedules', () => {
    renderScheduleRow(pendingSchedule);

    expect(screen.getByText('Approve')).toBeTruthy();
    expect(screen.getByText('Reject')).toBeTruthy();
  });

  it('does not show Switch for pending_approval schedules', () => {
    renderScheduleRow(pendingSchedule);

    expect(screen.queryByRole('switch')).toBeNull();
  });

  // The Approve button is right here, so the reason to approve — or the reason
  // this one cannot run as written — has to be here too (DOR-1485).
  it('says why a parked schedule is waiting', () => {
    renderScheduleRow({
      ...pendingSchedule,
      origin: 'file',
      reason: 'Its "cron" setting is not something DorkOS can read.',
    });

    expect(screen.getByText('Its "cron" setting is not something DorkOS can read.')).toBeTruthy();
  });

  // A schedule a person made themselves, whose file has since drifted, carries
  // OUR sentence — so it shows, even though its origin is not `file`.
  it('says why a drifted schedule of your own is waiting', () => {
    renderScheduleRow({
      ...pendingSchedule,
      origin: null,
      reasonSource: 'dorkos',
      reason: 'This schedule’s file changed since it was last approved.',
    });

    expect(
      screen.getByText('This schedule’s file changed since it was last approved.')
    ).toBeTruthy();
  });

  it('says nothing extra about a schedule that is already running', () => {
    renderScheduleRow({
      ...activeSchedule,
      origin: 'file',
      reason: 'A reason nobody needs to see now.',
    });

    expect(screen.queryByText('A reason nobody needs to see now.')).toBeNull();
  });

  // `reason` on an agent's proposal is the AGENT'S case, not DorkOS's. It gets
  // the approval card, which can say who is making it; a bare line in the row
  // would be an argument on screen with nobody's name on it.
  it('does not print an agent’s case as an unattributed line', () => {
    renderScheduleRow({
      ...pendingSchedule,
      origin: null,
      proposedByAgentPath: '/Users/dev/agents/dorkbot',
      reason: 'The backlog piles up overnight and nobody sees it.',
    });

    expect(screen.queryByText('The backlog piles up overnight and nobody sees it.')).toBeNull();
  });

  describe('a schedule a package shipped switched off (DOR-2059)', () => {
    it('shows no Approve/Reject — it reads as an ordinary switched-off task', () => {
      renderScheduleRow(offByDefaultSchedule);

      expect(screen.queryByText('Approve')).toBeNull();
      expect(screen.queryByText('Reject')).toBeNull();
      expect(screen.getByRole('switch')).toBeTruthy();
    });

    it('shows its switch off but flippable, unlike a paused schedule', () => {
      renderScheduleRow(offByDefaultSchedule);

      const toggle = screen.getByRole('switch');
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      expect(toggle).not.toBeDisabled();
    });

    it('says nothing about why it is waiting — there is no card to explain', () => {
      renderScheduleRow(offByDefaultSchedule);

      expect(
        screen.queryByText(/DorkOS found this schedule in a file on your computer/)
      ).toBeNull();
    });

    it('names its source on the row itself, without expanding (DOR-2059 review)', () => {
      // No card and no reason line would otherwise leave this row
      // indistinguishable from one the person switched off themselves.
      renderScheduleRow(offByDefaultSchedule);

      expect(screen.getByText(/Installed/)).toBeTruthy();
      expect(screen.getByText(/flow-drain/)).toBeTruthy();
    });

    it('stays off the minimal row, which is a name and a dot (delta review)', () => {
      const t = createMockTransport();
      const Wrapper = createWrapper(t);
      render(
        <Wrapper>
          <TaskRow
            task={offByDefaultSchedule}
            expanded={false}
            onToggleExpand={vi.fn()}
            onEdit={vi.fn()}
            size="minimal"
          />
        </Wrapper>
      );

      expect(screen.queryByText(/Installed/)).toBeNull();
    });

    it('names no source on an ordinary switched-off schedule, which has none', () => {
      renderScheduleRow(disabledSchedule);

      expect(screen.queryByText(/Installed/)).toBeNull();
    });
  });

  describe('an agent hiding its own proposal by switching itself off (adversarial review)', () => {
    it('still shows Approve/Reject — `origin` is not `file`, so `enabled` cannot quiet it', () => {
      renderScheduleRow(agentHidOwnProposal);

      expect(screen.getByText('Approve')).toBeTruthy();
      expect(screen.getByText('Reject')).toBeTruthy();
      expect(screen.queryByRole('switch')).toBeNull();
    });

    it('names no source, unlike a genuinely file-discovered schedule', () => {
      renderScheduleRow(agentHidOwnProposal);

      expect(screen.queryByText(/Installed/)).toBeNull();
    });

    it('switching it on runs the same approval a person clicking Approve would (DOR-607)', async () => {
      const updateTask = vi.fn().mockResolvedValue(offByDefaultSchedule);
      const transport = createMockTransport({ updateTask });
      renderScheduleRow(offByDefaultSchedule, {}, transport);

      await act(async () => {
        fireEvent.click(screen.getByRole('switch'));
      });

      // `status: 'active'` alongside `enabled: true` is what the PATCH route
      // reads as the approval — the arm blocker and permission clamp run on
      // every PATCH regardless of which fields it carries, so sending `status`
      // here is what turns this specific write into the first approval this
      // schedule has ever had, rather than an ordinary agent-writable toggle.
      expect(updateTask).toHaveBeenCalledWith('sched-4', { status: 'active', enabled: true });
    });

    it('switching an already-approved schedule off and back on sends only `enabled`', async () => {
      const updateTask = vi.fn().mockResolvedValue(activeSchedule);
      const transport = createMockTransport({ updateTask });
      renderScheduleRow(activeSchedule, {}, transport);

      await act(async () => {
        fireEvent.click(screen.getByRole('switch'));
      });

      expect(updateTask).toHaveBeenCalledWith('sched-1', { enabled: false });
    });
  });

  it('opens dropdown menu with Edit, Run Now, Delete items', async () => {
    renderScheduleRow(activeSchedule);

    const trigger = screen.getByLabelText(`Actions for ${activeSchedule.name}`);
    // Radix DropdownMenu requires the full pointer sequence to open in jsdom
    await act(async () => {
      fireEvent.pointerDown(trigger);
      fireEvent.mouseDown(trigger);
      fireEvent.click(trigger);
    });

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Edit/i })).toBeTruthy();
    });

    expect(screen.getByRole('menuitem', { name: /Run Now/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Delete/i })).toBeTruthy();
  });

  it('calls onEdit when Edit menu item is clicked', async () => {
    const onEdit = vi.fn();
    renderScheduleRow(activeSchedule, { onEdit });

    const trigger = screen.getByLabelText(`Actions for ${activeSchedule.name}`);
    await act(async () => {
      fireEvent.pointerDown(trigger);
      fireEvent.mouseDown(trigger);
      fireEvent.click(trigger);
    });

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Edit/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Edit/i }));
    });

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('shows delete confirmation dialog when Delete menu item is clicked', async () => {
    renderScheduleRow(activeSchedule);

    const trigger = screen.getByLabelText(`Actions for ${activeSchedule.name}`);
    await act(async () => {
      fireEvent.pointerDown(trigger);
      fireEvent.mouseDown(trigger);
      fireEvent.click(trigger);
    });

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Delete/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Delete/i }));
    });

    await waitFor(() => {
      expect(screen.getByText('Delete scheduled task')).toBeTruthy();
    });

    // Dialog body mentions the schedule name — allow multiple matches (schedule row + dialog)
    expect(screen.getAllByText(/Daily Review/).length).toBeGreaterThan(0);
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
  });

  it('expands run history when expanded prop is true', () => {
    renderScheduleRow(activeSchedule, { expanded: true });

    expect(screen.getByTestId('run-history')).toBeTruthy();
  });

  it('does not render run history when expanded is false', () => {
    renderScheduleRow(activeSchedule, { expanded: false });

    expect(screen.queryByTestId('run-history')).toBeNull();
  });

  it('calls onToggleExpand when the row body is clicked', async () => {
    const onToggleExpand = vi.fn();
    renderScheduleRow(activeSchedule, { onToggleExpand });

    // The schedule name sits inside the clickable row body (role="button")
    await act(async () => {
      fireEvent.click(screen.getByText('Daily Review'));
    });

    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it('gives its primary click target hover and focus feedback (batch 06, finding 6.2)', () => {
    // Every action button nested inside the row already carries a hover
    // treatment; the row body itself — the largest and most-clicked target —
    // used to carry none at all.
    const { container } = renderScheduleRow(activeSchedule);

    const row = container.querySelector('[role="button"]');
    expect(row).not.toBeNull();
    expect(row!.className).toContain('hover:bg-accent/50');
    expect(row!.className).toContain('focus-visible:bg-accent/50');
  });

  describe('schedule target display', () => {
    it('shows agent color dot, icon, and name when agent prop is provided', () => {
      const agent = {
        id: 'agent-1',
        name: 'api-bot',
        icon: '🤖',
        color: '#6366f1',
        description: '',
        runtime: 'claude-code' as const,
        capabilities: [],
        behavior: { responseMode: 'always' as const },
        registeredAt: new Date().toISOString(),
        registeredBy: 'test',
        enabledToolGroups: {},
        mcpServers: [],
        personaEnabled: true,
        isSystem: false,
        workspace: { mode: 'home' as const },
      };

      const scheduleWithAgent: Task = {
        ...activeSchedule,
        agentId: 'agent-1',
      };

      const t = createMockTransport();
      const Wrapper = createWrapper(t);
      render(
        <Wrapper>
          <TaskRow
            task={scheduleWithAgent}
            agent={agent}
            expanded={false}
            onToggleExpand={vi.fn()}
            onEdit={vi.fn()}
          />
        </Wrapper>
      );

      expect(screen.getByText('api-bot')).toBeTruthy();
      expect(screen.getByText('🤖')).toBeTruthy();
    });

    it('draws the agent as an agent — square, filled, Bot-marked — not a bare colour dot', () => {
      const agent = {
        id: 'agent-1',
        name: 'api-bot',
        icon: '🤖',
        color: '#6366f1',
        description: '',
        runtime: 'claude-code' as const,
        capabilities: [],
        behavior: { responseMode: 'always' as const },
        registeredAt: new Date().toISOString(),
        registeredBy: 'test',
        enabledToolGroups: {},
        mcpServers: [],
        workspace: { mode: 'home' as const },
        personaEnabled: true,
        isSystem: false,
      };

      const t = createMockTransport();
      const Wrapper = createWrapper(t);
      const { container } = render(
        <Wrapper>
          <TaskRow
            task={{ ...activeSchedule, agentId: 'agent-1' }}
            agent={agent}
            expanded={false}
            onToggleExpand={vi.fn()}
            onEdit={vi.fn()}
          />
        </Wrapper>
      );

      const disc = container.querySelector('[data-slot="identity-avatar"]');
      expect(disc).toBeTruthy();
      // The three things the hand-rolled dot could not say: agents are square,
      // they are filled with their own colour, and they carry the Bot mark.
      expect(disc?.className).toContain('rounded-md');
      expect(disc?.className).not.toContain('rounded-full');
      expect(disc?.getAttribute('style')).toContain('#6366f1');
      expect(disc?.querySelector('[data-slot="identity-badge"]')).toBeTruthy();
    });

    it('shows "Agent not found" warning when agentId is set but agent is not provided', () => {
      renderScheduleRow(scheduleWithOrphanedAgent);

      expect(screen.getByText('Agent not found')).toBeTruthy();
    });

    it('shows schedule name without any target prefix when no agentId', () => {
      renderScheduleRow(activeSchedule);

      // Name shows as primary text, no agent/cwd prefix
      expect(screen.getByText('Daily Review')).toBeTruthy();
      expect(screen.queryByText('Agent not found')).toBeNull();
    });
  });

  // A chip on every row would be a column of the same word: nearly every task
  // follows its agent (DOR-1615, DOR-1347).
  describe('the runs-on override chip', () => {
    it('is absent from a task that follows its agent', () => {
      renderScheduleRow(activeSchedule);

      expect(screen.queryByTestId('task-override-chip')).toBeNull();
    });

    it('names the runtime a task pins', () => {
      renderScheduleRow({ ...activeSchedule, runtime: 'codex' });

      expect(screen.getByTestId('task-override-chip')).toBeInTheDocument();
      expect(screen.getByLabelText('Runtime: Codex')).toBeInTheDocument();
    });

    it('shows the model beside it, shortened the way every other surface shortens it', () => {
      renderScheduleRow({ ...activeSchedule, runtime: 'opencode', model: 'ollama/qwen2.5-coder' });

      const chip = screen.getByTestId('task-override-chip');
      expect(chip).toHaveTextContent('qwen2.5-coder');
      expect(chip).not.toHaveTextContent('ollama/');
    });

    it('shows a pinned model on its own, without inventing a runtime for it', () => {
      // Naming a runtime here would mean resolving the agent's manifest for a
      // value the person never chose, and a guessed runtime is worse than none.
      renderScheduleRow({ ...activeSchedule, model: 'claude-opus-4-6' });

      expect(screen.getByTestId('task-override-chip')).toHaveTextContent('claude-opus-4-6');
      expect(screen.queryByLabelText(/^Runtime:/)).toBeNull();
    });

    it('stays off the minimal row, which is a name and a dot', () => {
      const t = createMockTransport();
      const Wrapper = createWrapper(t);
      render(
        <Wrapper>
          <TaskRow
            task={{ ...activeSchedule, runtime: 'codex' }}
            expanded={false}
            onToggleExpand={vi.fn()}
            onEdit={vi.fn()}
            size="minimal"
          />
        </Wrapper>
      );

      expect(screen.queryByTestId('task-override-chip')).toBeNull();
    });
  });

  describe('a package’s schedule on the person’s own timing (DOR-2302)', () => {
    // Overridden from Europe/Berlin at 07:30 on weekdays; the package ships hourly UTC.
    const retimed: Task = {
      ...activeSchedule,
      id: 'sched-9',
      name: 'flow-drain',
      cron: '30 7 * * 1-5',
      timezone: 'Europe/Berlin',
      defaultCron: '0 * * * *',
      defaultTimezone: 'UTC',
      timingOverridden: true,
      packageOwned: null,
      approvalChanges: [],
      filePath: '/home/user/.dork/plugins/flow/skills/flow-drain/SKILL.md',
    };

    /** Open the row's actions menu, the full pointer sequence Radix needs in jsdom. */
    async function openActions(task: Task) {
      const trigger = screen.getByLabelText(`Actions for ${task.name}`);
      await act(async () => {
        fireEvent.pointerDown(trigger);
        fireEvent.mouseDown(trigger);
        fireEvent.click(trigger);
      });
      await waitFor(() => expect(screen.getByRole('menuitem', { name: /Edit/i })).toBeTruthy());
    }

    it('shows the timing that runs and marks it as the person’s own', () => {
      // Purpose: the collapsed row is where a person asks "why is this not
      // running when the package says it does".
      renderScheduleRow(retimed);

      expect(screen.getByText(/Every: 30 7 \* \* 1-5/)).toBeTruthy();
      expect(document.querySelector('[data-slot="task-timing-override"]')).toHaveTextContent(
        'Your timing'
      );
    });

    it('names the zone the person chose beside their timing', () => {
      // Purpose: "At 07:30" is a time in a place; for a person's own timing the
      // place has to be on the row.
      renderScheduleRow(retimed);

      expect(screen.getByText(/Every: 30 7 \* \* 1-5, Europe\/Berlin/)).toBeTruthy();
    });

    it('explains a timezone-only change by showing the zone', () => {
      // Purpose: with only the zone overridden, the zone is the one thing on
      // the row that says why it is "Your timing".
      const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      renderScheduleRow({ ...activeSchedule, timezone: viewerZone, timingOverridden: true });

      expect(screen.getByText(new RegExp(`, ${viewerZone.replace('/', '\\/')}`))).toBeTruthy();
    });

    it('names a zone that is not the reader’s own, and leaves out the one that is', () => {
      // Purpose: an ordinary schedule in another zone is read wrong without it;
      // one in the reader's own zone needs no label.
      const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const elsewhere = viewerZone === 'Pacific/Kiritimati' ? 'Asia/Tokyo' : 'Pacific/Kiritimati';
      const { unmount } = renderScheduleRow({ ...activeSchedule, timezone: elsewhere });
      expect(screen.getByText(new RegExp(`, ${elsewhere.replace('/', '\\/')}`))).toBeTruthy();
      unmount();

      renderScheduleRow({ ...activeSchedule, timezone: viewerZone });
      expect(screen.queryByText(new RegExp(`, ${viewerZone.replace('/', '\\/')}`))).toBeNull();
    });

    it('says nothing of the kind for a schedule on its own timing', () => {
      // Purpose: the marker must mean something — never on every row.
      renderScheduleRow(activeSchedule, { expanded: true });

      expect(document.querySelector('[data-slot="task-timing-override"]')).toBeNull();
      expect(document.querySelector('[data-slot="task-package-timing"]')).toBeNull();
    });

    it('names the package’s own timing when expanded', () => {
      // Purpose: resetting blind is a guess; the row says what it goes back to.
      renderScheduleRow(retimed, { expanded: true });

      expect(document.querySelector('[data-slot="task-package-timing"]')).toHaveTextContent(
        'The package runs this every: 0 * * * *, UTC.'
      );
    });

    it('puts it back from the expanded row', async () => {
      // Purpose: "Reset to the package's default" sends the one request that
      // clears both halves, and nothing else.
      const transport = createMockTransport({ updateTask: vi.fn().mockResolvedValue(retimed) });
      renderScheduleRow(retimed, { expanded: true }, transport);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Reset to the package’s default/ }));
      });

      await waitFor(() =>
        expect(transport.updateTask).toHaveBeenCalledWith('sched-9', { resetTiming: true })
      );
    });

    it('puts it back from the actions menu', async () => {
      // Purpose: the collapsed row reaches the reset too, without expanding it.
      const transport = createMockTransport({ updateTask: vi.fn().mockResolvedValue(retimed) });
      renderScheduleRow(retimed, {}, transport);
      await openActions(retimed);

      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: /Reset to the package’s default/ }));
      });

      await waitFor(() =>
        expect(transport.updateTask).toHaveBeenCalledWith('sched-9', { resetTiming: true })
      );
    });

    it('offers no reset where there is nothing to reset', async () => {
      // Purpose: a menu item that does nothing is noise.
      renderScheduleRow(activeSchedule);
      await openActions(activeSchedule);

      expect(screen.queryByRole('menuitem', { name: /Reset to the package’s default/ })).toBeNull();
    });
  });
});
