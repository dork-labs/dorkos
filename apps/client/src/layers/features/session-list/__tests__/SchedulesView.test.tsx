// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { PulseSchedule } from '@dorkos/shared/types';
import { SidebarProvider } from '@/layers/shared/ui';
import { SchedulesView } from '../ui/SchedulesView';

// Mock useSchedules
const mockSchedules = vi.fn<() => { data: PulseSchedule[] }>(() => ({ data: [] }));
vi.mock('@/layers/entities/pulse/model/use-schedules', () => ({
  useSchedules: () => mockSchedules(),
}));

// Mock useActiveRunCount
const mockActiveRunCount = vi.fn<() => { data: number }>(() => ({ data: 0 }));
vi.mock('@/layers/entities/pulse/model/use-runs', () => ({
  useActiveRunCount: () => mockActiveRunCount(),
}));

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
  });

  afterEach(() => {
    cleanup();
  });

  it('shows empty state when no schedules exist', () => {
    render(<SchedulesView toolStatus="enabled" />, { wrapper: Wrapper });
    expect(screen.getByText('No schedules configured')).toBeInTheDocument();
  });

  it('shows disabled state when toolStatus is disabled-by-agent', () => {
    render(<SchedulesView toolStatus="disabled-by-agent" />, { wrapper: Wrapper });
    expect(screen.getByText('Pulse disabled for this agent')).toBeInTheDocument();
  });

  it('does not render schedule list when toolStatus is disabled-by-server', () => {
    // disabled-by-server skips queries — data defaults to empty
    render(<SchedulesView toolStatus="disabled-by-server" />, { wrapper: Wrapper });
    expect(screen.getByText('No schedules configured')).toBeInTheDocument();
  });

  it('renders Active section when active schedules exist', () => {
    mockSchedules.mockReturnValue({
      data: [makeSchedule({ id: 's1', name: 'Deploy Bot', status: 'active', enabled: true })],
    });
    render(<SchedulesView toolStatus="enabled" />, { wrapper: Wrapper });
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
    render(<SchedulesView toolStatus="enabled" />, { wrapper: Wrapper });
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
    render(<SchedulesView toolStatus="enabled" />, { wrapper: Wrapper });
    expect(screen.getByText('in 2h')).toBeInTheDocument();
  });

  it('shows active run count badge for active schedules', () => {
    mockSchedules.mockReturnValue({
      data: [makeSchedule({ id: 's1', name: 'Active Job', status: 'active', enabled: true })],
    });
    mockActiveRunCount.mockReturnValue({ data: 3 });
    render(<SchedulesView toolStatus="enabled" />, { wrapper: Wrapper });
    expect(screen.getByText('3 running')).toBeInTheDocument();
  });

  it('Open Pulse button calls setPulseOpen(true) in empty state', () => {
    render(<SchedulesView toolStatus="enabled" />, { wrapper: Wrapper });
    const btn = screen.getByText(/Open Pulse/);
    fireEvent.click(btn);
    expect(mockSetPulseOpen).toHaveBeenCalledWith(true);
  });

  it('Open Pulse button calls setPulseOpen(true) in disabled-by-agent state', () => {
    render(<SchedulesView toolStatus="disabled-by-agent" />, { wrapper: Wrapper });
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
    render(<SchedulesView toolStatus="enabled" />, { wrapper: Wrapper });
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('Running Task')).toBeInTheDocument();
    expect(screen.getByText('Paused Task')).toBeInTheDocument();
  });
});
