// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { TaskTemplate, TaskRun, Task } from '@dorkos/shared/types';
import { SidebarProvider } from '@/layers/shared/ui';
import { TasksView } from '../ui/TasksView';

// All entities/tasks hooks mocked via barrel to avoid export conflicts
const mockSchedules = vi.fn<() => { data: Task[] }>(() => ({ data: [] }));
const mockActiveRunCount = vi.fn<() => { data: number }>(() => ({ data: 0 }));
const mockRuns = vi.fn<() => { data: TaskRun[] }>(() => ({ data: [] }));
const mockPresets = vi.fn<() => { data: TaskTemplate[] }>(() => ({ data: [] }));
const mockOpenWithPreset = vi.fn();
vi.mock('@/layers/entities/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/tasks')>();
  return {
    ...actual,
    useTasks: () => mockSchedules(),
    useActiveTaskRunCount: () => mockActiveRunCount(),
    useTaskRuns: () => mockRuns(),
    useTaskTemplates: () => mockPresets(),
    useTaskTemplateDialog: () => ({ openWithTemplate: mockOpenWithPreset }),
  };
});

// Mock formatCron via features/tasks barrel
vi.mock('@/layers/features/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/tasks')>();
  return {
    ...actual,
    formatCron: (cron: string) => `cron:${cron}`,
  };
});

// Mock app store — capture setTasksOpen, openTasksForAgent, openTasksToEdit calls
const mockSetTasksOpen = vi.fn();
const mockOpenTasksForAgent = vi.fn();
const mockOpenTasksToEdit = vi.fn();
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setTasksOpen: mockSetTasksOpen,
      openTasksForAgent: mockOpenTasksForAgent,
      openTasksToEdit: mockOpenTasksToEdit,
    };
    return selector ? selector(state) : state;
  },
}));

// Mock formatRelativeTime to return a predictable string
vi.mock('@/layers/shared/lib/session-utils', () => ({
  formatRelativeTime: () => 'in 2h',
}));

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

  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return <SidebarProvider>{children}</SidebarProvider>;
}

/** Minimal schedule fixture with required fields filled. */
function makeSchedule(overrides: Partial<Task> & { id: string; name: string }): Task {
  return {
    status: 'active',
    enabled: true,
    nextRun: null,
    prompt: 'test',
    cron: '* * * * *',
    timezone: null,
    agentId: null,
    maxRuntime: null,
    permissionMode: 'acceptEdits',
    filePath: '/tmp/tasks/test.md',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Minimal run fixture. */
function makeRun(overrides: Partial<TaskRun> & { id: string; scheduleId: string }): TaskRun {
  return {
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: null,
    durationMs: null,
    outputSummary: null,
    error: null,
    sessionId: null,
    trigger: 'scheduled',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('TasksView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSchedules.mockReturnValue({ data: [] });
    mockActiveRunCount.mockReturnValue({ data: 0 });
    mockRuns.mockReturnValue({ data: [] });
    mockPresets.mockReturnValue({
      data: [
        {
          id: 'health-check',
          name: 'Health Check',
          description: 'Desc',
          prompt: 'Prompt',
          cron: '0 8 * * 1',
          timezone: 'UTC',
        },
        {
          id: 'dependency-audit',
          name: 'Dependency Audit',
          description: 'Desc',
          prompt: 'Prompt',
          cron: '0 9 * * 1',
          timezone: 'UTC',
        },
        {
          id: 'docs-sync',
          name: 'Docs Sync',
          description: 'Desc',
          prompt: 'Prompt',
          cron: '0 10 * * *',
          timezone: 'UTC',
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows empty state when no schedules exist', () => {
    render(<TasksView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('No schedules yet.')).toBeInTheDocument();
  });

  it('shows disabled state when toolStatus is disabled-by-agent', () => {
    render(<TasksView toolStatus="disabled-by-agent" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('Tasks disabled for this agent')).toBeInTheDocument();
  });

  it('does not render schedule list when toolStatus is disabled-by-server', () => {
    // disabled-by-server skips queries — data defaults to empty
    render(<TasksView toolStatus="disabled-by-server" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('No schedules yet.')).toBeInTheDocument();
  });

  it('renders Running section when there are active runs', () => {
    mockSchedules.mockReturnValue({
      data: [makeSchedule({ id: 's1', name: 'Deploy Bot', status: 'active', enabled: true })],
    });
    mockRuns.mockReturnValue({
      data: [makeRun({ id: 'r1', scheduleId: 's1', status: 'running' })],
    });
    mockActiveRunCount.mockReturnValue({ data: 1 });
    render(<TasksView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Deploy Bot')).toBeInTheDocument();
  });

  it('renders Upcoming section for active schedules with nextRun', () => {
    mockSchedules.mockReturnValue({
      data: [
        makeSchedule({
          id: 's1',
          name: 'Nightly Sync',
          status: 'active',
          enabled: true,
          nextRun: '2026-03-10T22:00:00Z',
        }),
      ],
    });
    render(<TasksView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('Nightly Sync')).toBeInTheDocument();
  });

  it('shows relative time for upcoming schedules with nextRun', () => {
    mockSchedules.mockReturnValue({
      data: [
        makeSchedule({
          id: 's1',
          name: 'Scheduled Task',
          status: 'active',
          enabled: true,
          nextRun: '2026-03-10T22:00:00Z',
        }),
      ],
    });
    render(<TasksView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('in 2h')).toBeInTheDocument();
  });

  it('shows active run count in Running section header', () => {
    mockSchedules.mockReturnValue({
      data: [makeSchedule({ id: 's1', name: 'Active Job', status: 'active', enabled: true })],
    });
    mockRuns.mockReturnValue({
      data: [makeRun({ id: 'r1', scheduleId: 's1', status: 'running' })],
    });
    mockActiveRunCount.mockReturnValue({ data: 3 });
    render(<TasksView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('Open Tasks button calls setTasksOpen(true) in empty state', () => {
    render(<TasksView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    const btn = screen.getByText(/Open Tasks/);
    fireEvent.click(btn);
    expect(mockSetTasksOpen).toHaveBeenCalledWith(true);
  });

  it('Open Tasks button calls setTasksOpen(true) in disabled-by-agent state', () => {
    render(<TasksView toolStatus="disabled-by-agent" agentId={null} />, { wrapper: Wrapper });
    const btn = screen.getByText(/Open Tasks/);
    fireEvent.click(btn);
    expect(mockSetTasksOpen).toHaveBeenCalledWith(true);
  });

  it('renders both Running and Upcoming sections when applicable', () => {
    mockSchedules.mockReturnValue({
      data: [
        makeSchedule({ id: 's1', name: 'Running Task', status: 'active', enabled: true }),
        makeSchedule({
          id: 's2',
          name: 'Queued Task',
          status: 'active',
          enabled: true,
          nextRun: '2026-03-10T22:00:00Z',
        }),
      ],
    });
    mockRuns.mockReturnValue({
      data: [makeRun({ id: 'r1', scheduleId: 's1', status: 'running' })],
    });
    render(<TasksView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('Running Task')).toBeInTheDocument();
    expect(screen.getByText('Queued Task')).toBeInTheDocument();
  });

  it('filters schedules by agentId when provided', () => {
    mockSchedules.mockReturnValue({
      data: [
        makeSchedule({ id: 's1', name: 'Agent A Task', agentId: 'agent-a' }),
        makeSchedule({ id: 's2', name: 'Agent B Task', agentId: 'agent-b' }),
        makeSchedule({ id: 's3', name: 'Unassigned Task', agentId: null }),
      ],
    });
    mockRuns.mockReturnValue({
      data: [makeRun({ id: 'r1', scheduleId: 's1', status: 'running' })],
    });
    render(<TasksView toolStatus="enabled" agentId="agent-a" />, { wrapper: Wrapper });
    expect(screen.getByText('Agent A Task')).toBeInTheDocument();
    expect(screen.queryByText('Agent B Task')).not.toBeInTheDocument();
    expect(screen.queryByText('Unassigned Task')).not.toBeInTheDocument();
  });

  it('shows empty state when agentId is provided but no schedules match', () => {
    mockSchedules.mockReturnValue({
      data: [makeSchedule({ id: 's1', name: 'Other Agent Task', agentId: 'agent-b' })],
    });
    render(<TasksView toolStatus="enabled" agentId="agent-a" />, { wrapper: Wrapper });
    expect(screen.getByText('No schedules yet.')).toBeInTheDocument();
    expect(screen.queryByText('Other Agent Task')).not.toBeInTheDocument();
  });

  it('shows featured preset cards in empty state', () => {
    render(<TasksView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    // index 0 = Health Check, index 2 = Docs Sync
    expect(screen.getByText('Health Check')).toBeInTheDocument();
    expect(screen.getByText('Docs Sync')).toBeInTheDocument();
    // index 1 = Dependency Audit should NOT appear
    expect(screen.queryByText('Dependency Audit')).not.toBeInTheDocument();
  });

  it('shows formatted cron for featured presets', () => {
    render(<TasksView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    // formatCron is mocked to return `cron:<cron>`
    expect(screen.getByText('cron:0 8 * * 1')).toBeInTheDocument();
    expect(screen.getByText('cron:0 10 * * *')).toBeInTheDocument();
  });

  it('+ Use preset button calls openWithPreset and setTasksOpen', () => {
    render(<TasksView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    const usePresetBtns = screen.getAllByText('+ Use preset');
    fireEvent.click(usePresetBtns[0]);
    expect(mockOpenWithPreset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'health-check' })
    );
    expect(mockSetTasksOpen).toHaveBeenCalledWith(true);
  });

  it('does not show preset cards when schedules exist', () => {
    mockSchedules.mockReturnValue({
      data: [makeSchedule({ id: 's1', name: 'My Schedule', status: 'active', enabled: true })],
    });
    mockRuns.mockReturnValue({
      data: [makeRun({ id: 'r1', scheduleId: 's1', status: 'running' })],
    });
    render(<TasksView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    expect(screen.queryByText('Health Check')).not.toBeInTheDocument();
    expect(screen.queryByText('Docs Sync')).not.toBeInTheDocument();
  });
});
