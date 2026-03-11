/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport, createMockSchedule } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { CreateScheduleDialog } from '../ui/CreateScheduleDialog';

const MOCK_AGENTS = [
  { id: 'agent-1', name: 'api-bot', projectPath: '/projects/api', icon: '🤖', color: '#6366f1' },
  { id: 'agent-2', name: 'test-bot', projectPath: '/projects/test', icon: '🧪', color: '#22c55e' },
];

vi.mock('cronstrue', () => ({
  default: {
    toString: (cron: string) => {
      if (cron === '0 9 * * 1-5') return 'At 09:00 AM, Monday through Friday';
      if (cron === '0 9 * * 1,2,3,4,5') return 'At 09:00 AM, Monday through Friday';
      if (cron === 'invalid') throw new Error('Invalid cron');
      return `Cron: ${cron}`;
    },
  },
}));

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

describe('CreateScheduleDialog', () => {
  beforeAll(() => {
    // ResponsiveDialog uses useIsMobile which calls window.matchMedia
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows "New Schedule" title in create mode', () => {
    const transport = createMockTransport();
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    expect(screen.getByText('New Schedule')).toBeTruthy();
  });

  it('shows "Edit Schedule" title when editSchedule is provided', () => {
    const transport = createMockTransport();
    const Wrapper = createWrapper(transport);
    const schedule = createMockSchedule({ id: 'sched-1', name: 'My Schedule' });

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} editSchedule={schedule} />
      </Wrapper>
    );

    expect(screen.getByText('Edit Schedule')).toBeTruthy();
  });

  it('pre-fills form fields in edit mode', async () => {
    const transport = createMockTransport();
    const Wrapper = createWrapper(transport);
    const schedule = createMockSchedule({
      id: 'sched-1',
      name: 'Daily review',
      prompt: 'Review open PRs',
      cron: '0 9 * * 1-5',
      cwd: '/projects/app',
      permissionMode: 'bypassPermissions',
      maxRuntime: 300_000,
    });

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} editSchedule={schedule} />
      </Wrapper>
    );

    // useEffect populates fields after initial render
    await waitFor(() => {
      expect(screen.getByDisplayValue('Daily review')).toBeTruthy();
    });
    expect(screen.getByDisplayValue('Review open PRs')).toBeTruthy();
    // ScheduleBuilder parses the cron and shows weekly preview
    expect(screen.getByText(/every weekday/i)).toBeTruthy();
    expect(screen.getByText('/projects/app')).toBeTruthy();
    // maxRuntime: 300_000ms = 5 minutes
    expect(screen.getByDisplayValue('5')).toBeTruthy();
  });

  it('submits create with correct payload', async () => {
    const newSchedule = createMockSchedule({ id: 'sched-new' });
    const transport = createMockTransport({
      createSchedule: vi.fn().mockResolvedValue(newSchedule),
    });
    const Wrapper = createWrapper(transport);
    const onOpenChange = vi.fn();

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={onOpenChange} />
      </Wrapper>
    );

    fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
      target: { value: 'Nightly build' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('Review all pending PRs and summarize findings...'),
      { target: { value: 'Run the nightly build' } }
    );

    // ScheduleBuilder starts empty. Switch to cron mode and type a cron expression.
    fireEvent.click(screen.getByText('Use a cron expression'));
    fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), {
      target: { value: '0 0 * * *' },
    });

    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(transport.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Nightly build',
          prompt: 'Run the nightly build',
          cron: '0 0 * * *',
          permissionMode: 'acceptEdits',
        })
      );
    });
  });

  it('submits update with correct ID in edit mode', async () => {
    const schedule = createMockSchedule({
      id: 'sched-42',
      name: 'Old Name',
      prompt: 'Old prompt',
      cron: '0 9 * * 1-5',
    });
    const updatedSchedule = createMockSchedule({ id: 'sched-42', name: 'New Name' });
    const transport = createMockTransport({
      updateSchedule: vi.fn().mockResolvedValue(updatedSchedule),
    });
    const Wrapper = createWrapper(transport);
    const onOpenChange = vi.fn();

    render(
      <Wrapper>
        <CreateScheduleDialog
          open={true}
          onOpenChange={onOpenChange}
          editSchedule={schedule}
        />
      </Wrapper>
    );

    // Wait for useEffect to populate the form
    await waitFor(() => {
      expect(screen.getByDisplayValue('Old Name')).toBeTruthy();
    });

    fireEvent.change(screen.getByDisplayValue('Old Name'), {
      target: { value: 'New Name' },
    });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(transport.updateSchedule).toHaveBeenCalledWith(
        'sched-42',
        expect.objectContaining({ name: 'New Name' })
      );
    });
  });

  it('shows schedule preview in ScheduleBuilder', () => {
    const transport = createMockTransport();
    const Wrapper = createWrapper(transport);
    const schedule = createMockSchedule({
      id: 'sched-1',
      name: 'Test',
      prompt: 'Test',
      cron: '0 9 * * 1-5',
    });

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} editSchedule={schedule} />
      </Wrapper>
    );

    // ScheduleBuilder parses weekly cron and shows human-readable preview
    expect(screen.getByText(/every weekday at 9:00 AM/i)).toBeTruthy();
  });

  it('shows permission mode warning for bypassPermissions', () => {
    const transport = createMockTransport();
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    fireEvent.click(screen.getByLabelText('Full autonomy'));

    expect(
      screen.getByText(
        'Warning: This allows the agent to execute any tool without approval.'
      )
    ).toBeTruthy();
  });

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

      await waitFor(() => {
        expect(screen.getByText('api-bot')).toBeTruthy();
      });
      fireEvent.click(screen.getByText('api-bot'));

      fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
        target: { value: 'Agent run' },
      });
      fireEvent.change(
        screen.getByPlaceholderText('Review all pending PRs and summarize findings...'),
        { target: { value: 'Do something' } }
      );

      // Use cron escape hatch to set a specific cron
      fireEvent.click(screen.getByText('Use a cron expression'));
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

      await waitFor(() => {
        expect(screen.getByText(/Run in a specific directory instead/)).toBeTruthy();
      });
      fireEvent.click(screen.getByText(/Run in a specific directory instead/));

      fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
        target: { value: 'Dir run' },
      });
      fireEvent.change(
        screen.getByPlaceholderText('Review all pending PRs and summarize findings...'),
        { target: { value: 'Do something' } }
      );

      // Use cron escape hatch to set a specific cron
      fireEvent.click(screen.getByText('Use a cron expression'));
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

      await waitFor(() => {
        expect(screen.getByText('api-bot')).toBeTruthy();
      });
      expect(screen.queryByText('test-bot')).toBeNull();
      expect(screen.getByLabelText('Change agent')).toBeTruthy();
    });
  });
});
