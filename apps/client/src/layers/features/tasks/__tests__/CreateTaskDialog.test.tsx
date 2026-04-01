/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { TaskTemplate } from '@dorkos/shared/types';
import { createMockTransport, createMockSchedule } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { CreateTaskDialog } from '../ui/CreateTaskDialog';

const MOCK_AGENTS = [
  { id: 'agent-1', name: 'api-bot', projectPath: '/projects/api', icon: '🤖', color: '#6366f1' },
  { id: 'agent-2', name: 'test-bot', projectPath: '/projects/test', icon: '🧪', color: '#22c55e' },
];

const MOCK_PRESETS: TaskTemplate[] = [
  {
    id: 'health-check',
    name: 'Health Check',
    description: 'Desc',
    prompt: 'Prompt health',
    cron: '0 8 * * 1',
    timezone: 'UTC',
  },
  {
    id: 'docs-sync',
    name: 'Docs Sync',
    description: 'Desc',
    prompt: 'Prompt docs',
    cron: '0 10 * * *',
    timezone: 'UTC',
  },
];

const mockTaskTemplateDialog = vi.fn().mockReturnValue({
  pendingTemplate: null,
  externalTrigger: false,
  clear: vi.fn(),
});

vi.mock('@/layers/entities/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/tasks')>();
  return {
    ...actual,
    useTaskTemplateDialog: () => mockTaskTemplateDialog(),
    useTaskTemplates: () => ({ data: MOCK_PRESETS, isLoading: false, isError: false }),
  };
});

// Mock PresetGallery to render a simple selectable list — avoids needing full TanStack Query setup
// and lets tests click preset names directly or use "Start from scratch"
vi.mock('../ui/TaskTemplateGallery', () => ({
  TaskTemplateGallery: ({ onSelect }: { onSelect?: (preset: TaskTemplate) => void }) => (
    <div data-testid="preset-gallery">
      {MOCK_PRESETS.map((p) => (
        <button key={p.id} onClick={() => onSelect?.(p)}>
          {p.name}
        </button>
      ))}
    </div>
  ),
}));

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

describe('CreateTaskDialog', () => {
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
    // cmdk uses ResizeObserver and scrollIntoView internally
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskTemplateDialog.mockReturnValue({
      pendingTemplate: null,
      externalTrigger: false,
      clear: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows "New Schedule" title in create mode', () => {
    const transport = createMockTransport();
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
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
        <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
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
      permissionMode: 'bypassPermissions',
      maxRuntime: 300_000,
    });

    render(
      <Wrapper>
        <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
      </Wrapper>
    );

    // useEffect populates fields after initial render
    await waitFor(() => {
      expect(screen.getByDisplayValue('Daily review')).toBeTruthy();
    });
    expect(screen.getByDisplayValue('Review open PRs')).toBeTruthy();
    // ScheduleBuilder parses the cron and shows weekly preview
    expect(screen.getByText(/every weekday/i)).toBeTruthy();
  });

  it('submits create with correct payload', async () => {
    const newSchedule = createMockSchedule({ id: 'sched-new' });
    const transport = createMockTransport({
      createTask: vi.fn().mockResolvedValue(newSchedule),
    });
    const Wrapper = createWrapper(transport);
    const onOpenChange = vi.fn();

    render(
      <Wrapper>
        <CreateTaskDialog open={true} onOpenChange={onOpenChange} />
      </Wrapper>
    );

    // Advance past preset-picker step to the form
    fireEvent.click(screen.getByText('Start from scratch'));

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
      expect(transport.createTask).toHaveBeenCalledWith(
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
      updateTask: vi.fn().mockResolvedValue(updatedSchedule),
    });
    const Wrapper = createWrapper(transport);
    const onOpenChange = vi.fn();

    render(
      <Wrapper>
        <CreateTaskDialog open={true} onOpenChange={onOpenChange} editTask={schedule} />
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
      expect(transport.updateTask).toHaveBeenCalledWith(
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
        <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
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
        <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    // Advance past preset-picker step to the form
    fireEvent.click(screen.getByText('Start from scratch'));

    fireEvent.click(screen.getByLabelText('Full autonomy'));

    expect(
      screen.getByText('Warning: This allows the agent to execute any tool without approval.')
    ).toBeTruthy();
  });

  describe('agent picker', () => {
    it('shows agent combobox when agents exist', async () => {
      const transport = createMockTransport({
        listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: MOCK_AGENTS }),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );

      fireEvent.click(screen.getByText('Start from scratch'));

      await waitFor(() => {
        expect(screen.getByText('Select an agent...')).toBeTruthy();
      });
    });

    it('pre-selects agent in combobox trigger when editing agent-linked schedule', async () => {
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
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('api-bot')).toBeTruthy();
      });
    });
  });

  describe('two-step flow', () => {
    it('opens at preset-picker step by default (create mode)', () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      expect(screen.getByText('Start from scratch')).toBeTruthy();
    });

    it('opens directly at form step in edit mode', () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      const schedule = createMockSchedule({ id: 's1', name: 'My Schedule' });
      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );
      expect(screen.queryByText('Start from scratch')).toBeNull();
      expect(screen.getByText('Edit Schedule')).toBeTruthy();
    });

    it('advances to form step when a preset card is clicked', async () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      // PresetGallery mock renders buttons with preset names
      fireEvent.click(screen.getByText('Health Check'));
      await waitFor(() => {
        expect(screen.getByDisplayValue('Health Check')).toBeTruthy();
      });
      expect(screen.getByDisplayValue('Prompt health')).toBeTruthy();
    });

    it('advances to empty form when "Start from scratch" is clicked', () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));
      expect(screen.getByPlaceholderText('Daily code review')).toBeTruthy();
      expect((screen.getByPlaceholderText('Daily code review') as HTMLInputElement).value).toBe('');
    });

    it('returns to picker step when Back is clicked', () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));
      fireEvent.click(screen.getByLabelText('Back to preset picker'));
      expect(screen.getByText('Start from scratch')).toBeTruthy();
    });

    it('opens at form step when externalTrigger fires with pendingPreset', async () => {
      const clearMock = vi.fn();
      mockTaskTemplateDialog.mockReturnValue({
        pendingTemplate: MOCK_PRESETS[0],
        externalTrigger: true,
        clear: clearMock,
      });
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      await waitFor(() => {
        expect(screen.getByDisplayValue('Health Check')).toBeTruthy();
      });
      expect(clearMock).toHaveBeenCalled();
    });

    it('resets to preset-picker step when dialog closes and reopens', () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      const { rerender } = render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      // Advance to form
      fireEvent.click(screen.getByText('Start from scratch'));
      // Close dialog
      rerender(
        <Wrapper>
          <CreateTaskDialog open={false} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      // Reopen dialog
      rerender(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      expect(screen.getByText('Start from scratch')).toBeTruthy();
    });
  });
});
