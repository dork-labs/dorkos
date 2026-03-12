// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { PulsePreset, PulseSchedule } from '@dorkos/shared/types';
import { SidebarProvider } from '@/layers/shared/ui';
import { SchedulesView } from '../ui/SchedulesView';

// All entities/pulse hooks mocked via barrel to avoid export conflicts
const mockSchedules = vi.fn<() => { data: PulseSchedule[] }>(() => ({ data: [] }));
const mockActiveRunCount = vi.fn<() => { data: number }>(() => ({ data: 0 }));
const mockPresets = vi.fn<() => { data: PulsePreset[] }>(() => ({ data: [] }));
const mockOpenWithPreset = vi.fn();
vi.mock('@/layers/entities/pulse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/pulse')>();
  return {
    ...actual,
    useSchedules: () => mockSchedules(),
    useActiveRunCount: () => mockActiveRunCount(),
    usePulsePresets: () => mockPresets(),
    usePulsePresetDialog: () => ({ openWithPreset: mockOpenWithPreset }),
  };
});

// Mock formatCron via features/pulse barrel
vi.mock('@/layers/features/pulse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/pulse')>();
  return {
    ...actual,
    formatCron: (cron: string) => `cron:${cron}`,
  };
});

// Mock app store — capture setPulseOpen calls
const mockSetPulseOpen = vi.fn();
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { setPulseOpen: mockSetPulseOpen };
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
function makeSchedule(overrides: Partial<PulseSchedule> & { id: string; name: string }): PulseSchedule {
  return {
    status: 'active',
    enabled: true,
    nextRun: null,
    prompt: 'test',
    cron: '* * * * *',
    timezone: null,
    cwd: null,
    agentId: null,
    maxRuntime: null,
    permissionMode: 'acceptEdits',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('SchedulesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSchedules.mockReturnValue({ data: [] });
    mockActiveRunCount.mockReturnValue({ data: 0 });
    mockPresets.mockReturnValue({
      data: [
        { id: 'health-check', name: 'Health Check', description: 'Desc', prompt: 'Prompt', cron: '0 8 * * 1', timezone: 'UTC', category: 'maintenance' },
        { id: 'dependency-audit', name: 'Dependency Audit', description: 'Desc', prompt: 'Prompt', cron: '0 9 * * 1', timezone: 'UTC', category: 'security' },
        { id: 'docs-sync', name: 'Docs Sync', description: 'Desc', prompt: 'Prompt', cron: '0 10 * * *', timezone: 'UTC', category: 'documentation' },
      ],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows empty state when no schedules exist', () => {
    render(<SchedulesView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('No schedules yet.')).toBeInTheDocument();
  });

  it('shows disabled state when toolStatus is disabled-by-agent', () => {
    render(<SchedulesView toolStatus="disabled-by-agent" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('Pulse disabled for this agent')).toBeInTheDocument();
  });

  it('does not render schedule list when toolStatus is disabled-by-server', () => {
    // disabled-by-server skips queries — data defaults to empty
    render(<SchedulesView toolStatus="disabled-by-server" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('No schedules yet.')).toBeInTheDocument();
  });

  it('renders Active section when active schedules exist', () => {
    mockSchedules.mockReturnValue({
      data: [makeSchedule({ id: 's1', name: 'Deploy Bot', status: 'active', enabled: true })],
    });
    render(<SchedulesView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Deploy Bot')).toBeInTheDocument();
  });

  it('renders Upcoming section for non-active schedules', () => {
    mockSchedules.mockReturnValue({
      data: [
        makeSchedule({
          id: 's1',
          name: 'Nightly Sync',
          status: 'paused',
          enabled: true,
          nextRun: '2026-03-10T22:00:00Z',
        }),
      ],
    });
    render(<SchedulesView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('Nightly Sync')).toBeInTheDocument();
  });

  it('shows relative time for upcoming schedules with nextRun', () => {
    mockSchedules.mockReturnValue({
      data: [
        makeSchedule({
          id: 's1',
          name: 'Scheduled Task',
          status: 'paused',
          enabled: false,
          nextRun: '2026-03-10T22:00:00Z',
        }),
      ],
    });
    render(<SchedulesView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('in 2h')).toBeInTheDocument();
  });

  it('shows active run count badge for active schedules', () => {
    mockSchedules.mockReturnValue({
      data: [makeSchedule({ id: 's1', name: 'Active Job', status: 'active', enabled: true })],
    });
    mockActiveRunCount.mockReturnValue({ data: 3 });
    render(<SchedulesView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('3 running')).toBeInTheDocument();
  });

  it('Open Pulse button calls setPulseOpen(true) in empty state', () => {
    render(<SchedulesView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    const btn = screen.getByText(/Open Pulse/);
    fireEvent.click(btn);
    expect(mockSetPulseOpen).toHaveBeenCalledWith(true);
  });

  it('Open Pulse button calls setPulseOpen(true) in disabled-by-agent state', () => {
    render(<SchedulesView toolStatus="disabled-by-agent" agentId={null} />, { wrapper: Wrapper });
    const btn = screen.getByText(/Open Pulse/);
    fireEvent.click(btn);
    expect(mockSetPulseOpen).toHaveBeenCalledWith(true);
  });

  it('renders both Active and Upcoming sections when mixed schedules exist', () => {
    mockSchedules.mockReturnValue({
      data: [
        makeSchedule({ id: 's1', name: 'Running Task', status: 'active', enabled: true }),
        makeSchedule({ id: 's2', name: 'Paused Task', status: 'paused', enabled: false }),
      ],
    });
    render(<SchedulesView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('Running Task')).toBeInTheDocument();
    expect(screen.getByText('Paused Task')).toBeInTheDocument();
  });

  it('filters schedules by agentId when provided', () => {
    mockSchedules.mockReturnValue({
      data: [
        makeSchedule({ id: 's1', name: 'Agent A Task', agentId: 'agent-a' }),
        makeSchedule({ id: 's2', name: 'Agent B Task', agentId: 'agent-b' }),
        makeSchedule({ id: 's3', name: 'Unassigned Task', agentId: null }),
      ],
    });
    render(<SchedulesView toolStatus="enabled" agentId="agent-a" />, { wrapper: Wrapper });
    expect(screen.getByText('Agent A Task')).toBeInTheDocument();
    expect(screen.queryByText('Agent B Task')).not.toBeInTheDocument();
    expect(screen.queryByText('Unassigned Task')).not.toBeInTheDocument();
  });

  it('shows empty state when agentId is provided but no schedules match', () => {
    mockSchedules.mockReturnValue({
      data: [
        makeSchedule({ id: 's1', name: 'Other Agent Task', agentId: 'agent-b' }),
      ],
    });
    render(<SchedulesView toolStatus="enabled" agentId="agent-a" />, { wrapper: Wrapper });
    expect(screen.getByText('No schedules yet.')).toBeInTheDocument();
    expect(screen.queryByText('Other Agent Task')).not.toBeInTheDocument();
  });

  it('shows featured preset cards in empty state', () => {
    render(<SchedulesView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    // index 0 = Health Check, index 2 = Docs Sync
    expect(screen.getByText('Health Check')).toBeInTheDocument();
    expect(screen.getByText('Docs Sync')).toBeInTheDocument();
    // index 1 = Dependency Audit should NOT appear
    expect(screen.queryByText('Dependency Audit')).not.toBeInTheDocument();
  });

  it('shows formatted cron for featured presets', () => {
    render(<SchedulesView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    // formatCron is mocked to return `cron:<cron>`
    expect(screen.getByText('cron:0 8 * * 1')).toBeInTheDocument();
    expect(screen.getByText('cron:0 10 * * *')).toBeInTheDocument();
  });

  it('+ Use preset button calls openWithPreset and setPulseOpen', () => {
    render(<SchedulesView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    const usePresetBtns = screen.getAllByText('+ Use preset');
    fireEvent.click(usePresetBtns[0]);
    expect(mockOpenWithPreset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'health-check' })
    );
    expect(mockSetPulseOpen).toHaveBeenCalledWith(true);
  });

  it('does not show preset cards when schedules exist', () => {
    mockSchedules.mockReturnValue({
      data: [makeSchedule({ id: 's1', name: 'My Schedule', status: 'active', enabled: true })],
    });
    render(<SchedulesView toolStatus="enabled" agentId={null} />, { wrapper: Wrapper });
    expect(screen.queryByText('Health Check')).not.toBeInTheDocument();
    expect(screen.queryByText('Docs Sync')).not.toBeInTheDocument();
  });
});
