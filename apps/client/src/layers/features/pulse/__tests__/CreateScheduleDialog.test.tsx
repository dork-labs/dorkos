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

// jsdom does not implement ResizeObserver (required by cmdk CommandList in AgentCombobox)
globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// jsdom does not implement scrollIntoView (required by cmdk item selection)
Element.prototype.scrollIntoView = vi.fn();

vi.mock('cronstrue', () => ({
  default: {
    toString: (cron: string) => {
      if (cron === '0 9 * * 1-5') return 'At 09:00 AM, Monday through Friday';
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
    expect(screen.getByDisplayValue('0 9 * * 1-5')).toBeTruthy();
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

  it('shows cron human-readable preview', () => {
    const transport = createMockTransport();
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), {
      target: { value: '0 9 * * 1-5' },
    });

    expect(screen.getByText('At 09:00 AM, Monday through Friday')).toBeTruthy();
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

  describe('schedule target radio group', () => {
    it('shows radio group for agent vs directory', () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );

      expect(screen.getByLabelText('Run for agent')).toBeTruthy();
      expect(screen.getByLabelText('Run in directory')).toBeTruthy();
    });

    it('shows directory picker when "Run in directory" is selected', () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );

      fireEvent.click(screen.getByLabelText('Run in directory'));

      expect(screen.getByText('Working Directory')).toBeTruthy();
      expect(screen.getByLabelText('Browse directories')).toBeTruthy();
    });

    it('shows agent combobox when "Run for agent" is selected and agents exist', async () => {
      const transport = createMockTransport({
        listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: MOCK_AGENTS }),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );

      fireEvent.click(screen.getByLabelText('Run for agent'));

      await waitFor(() => {
        expect(screen.getByText('Select agent...')).toBeTruthy();
      });
    });

    it('shows "no agents" message when agent mode selected but no agents registered', async () => {
      const transport = createMockTransport({
        listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [] }),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );

      fireEvent.click(screen.getByLabelText('Run for agent'));

      await waitFor(() => {
        expect(screen.getByText(/No registered agents found/)).toBeTruthy();
      });
    });

    it('submits with agentId when agent target selected', async () => {
      const newSchedule = createMockSchedule({ id: 'sched-new', agentId: 'agent-1' });
      const transport = createMockTransport({
        createSchedule: vi.fn().mockResolvedValue(newSchedule),
        listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: MOCK_AGENTS }),
      });
      const Wrapper = createWrapper(transport);
      const onOpenChange = vi.fn();

      render(
        <Wrapper>
          <CreateScheduleDialog open={true} onOpenChange={onOpenChange} />
        </Wrapper>
      );

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

      // Switch to agent mode and open combobox
      fireEvent.click(screen.getByLabelText('Run for agent'));

      await waitFor(() => {
        expect(screen.getByText('Select agent...')).toBeTruthy();
      });

      // Open the combobox and select an agent
      fireEvent.click(screen.getByText('Select agent...'));
      await waitFor(() => {
        expect(screen.getByText('api-bot')).toBeTruthy();
      });
      fireEvent.click(screen.getByText('api-bot'));

      fireEvent.click(screen.getByText('Create'));

      await waitFor(() => {
        expect(transport.createSchedule).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: 'agent-1',
          })
        );
      });
    });

    it('submits with cwd when directory target selected', async () => {
      const newSchedule = createMockSchedule({ id: 'sched-new', cwd: '/projects/app' });
      const transport = createMockTransport({
        createSchedule: vi.fn().mockResolvedValue(newSchedule),
        listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [] }),
      });
      const Wrapper = createWrapper(transport);
      const onOpenChange = vi.fn();

      render(
        <Wrapper>
          <CreateScheduleDialog open={true} onOpenChange={onOpenChange} />
        </Wrapper>
      );

      fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
        target: { value: 'Dir run' },
      });
      fireEvent.change(
        screen.getByPlaceholderText('Review all pending PRs and summarize findings...'),
        { target: { value: 'Do something in dir' } }
      );
      fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), {
        target: { value: '0 0 * * *' },
      });

      // Ensure directory mode is active
      fireEvent.click(screen.getByLabelText('Run in directory'));

      fireEvent.click(screen.getByText('Create'));

      await waitFor(() => {
        expect(transport.createSchedule).toHaveBeenCalledWith(
          expect.not.objectContaining({ agentId: expect.anything() })
        );
      });
    });

    it('pre-selects agent mode when editing an agent-linked schedule', async () => {
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

      // Agent radio should be selected
      await waitFor(() => {
        const agentRadio = screen.getByLabelText('Run for agent') as HTMLInputElement;
        expect(agentRadio.checked).toBe(true);
      });
    });
  });
});
