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
      <TransportProvider transport={transport}>{children}</TransportProvider>
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

      const disc = container.querySelector('[data-slot="agent-avatar"]');
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
});
