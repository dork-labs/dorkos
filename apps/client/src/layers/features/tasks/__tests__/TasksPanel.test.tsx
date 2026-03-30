/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { createMockSchedule } from '@dorkos/test-utils';

// Mock cronstrue to avoid parsing issues in tests
vi.mock('cronstrue', () => ({
  default: { toString: (cron: string) => `Every: ${cron}` },
}));

// Mock CreateTaskDialog
vi.mock('../ui/CreateTaskDialog', () => ({
  CreateTaskDialog: (props: { open: boolean; editTask?: unknown }) => {
    if (!props.open) return null;
    return (
      <div data-testid="create-schedule-dialog">
        {props.editTask ? 'Edit Schedule' : 'New Schedule'}
      </div>
    );
  },
}));

// Mock TaskRunHistoryPanel
vi.mock('../ui/TaskRunHistoryPanel', () => ({
  TaskRunHistoryPanel: ({ scheduleId }: { scheduleId: string }) => (
    <div data-testid={`run-history-${scheduleId}`}>Run History for {scheduleId}</div>
  ),
}));

// Mock TasksEmptyState to expose callbacks as buttons for testing
vi.mock('../ui/TasksEmptyState', () => ({
  TasksEmptyState: ({
    onCreateWithPreset,
    onCreateBlank,
  }: {
    onCreateWithPreset: (preset: {
      id: string;
      name: string;
      description: string;
      prompt: string;
      cron: string;
      timezone: string;
      category: string;
    }) => void;
    onCreateBlank: () => void;
  }) => (
    <div data-testid="tasks-empty-state">
      <button onClick={onCreateBlank}>Create Schedule</button>
      <button
        onClick={() =>
          onCreateWithPreset({
            id: 'p1',
            name: 'Preset',
            description: '',
            prompt: '',
            cron: '0 * * * *',
            timezone: 'UTC',
            category: 'maintenance',
          })
        }
      >
        Use Preset
      </button>
    </div>
  ),
}));

// Mock TaskRow so TasksPanel tests focus on state orchestration.
// Exposes onEdit and onToggleExpand as buttons so tests can invoke them directly.
vi.mock('../ui/TaskRow', () => ({
  TaskRow: ({
    task,
    expanded,
    onToggleExpand,
    onEdit,
  }: {
    task: { id: string; name: string };
    expanded: boolean;
    onToggleExpand: () => void;
    onEdit: () => void;
  }) => (
    <div data-testid={`schedule-row-${task.id}`}>
      <span>{task.name}</span>
      <button onClick={onToggleExpand}>Toggle {task.name}</button>
      <button onClick={onEdit} aria-label={`Edit ${task.name}`}>
        Edit
      </button>
      {expanded && <div data-testid={`run-history-${task.id}`}>Run History for {task.id}</div>}
    </div>
  ),
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

// Import TasksPanel after mocks are set up
import { TasksPanel } from '../ui/TasksPanel';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('TasksPanel', () => {
  it('renders schedule list when data is available', async () => {
    const schedules = [
      createMockSchedule({ id: 'sched-1', name: 'Daily review', cron: '0 9 * * 1-5' }),
      createMockSchedule({ id: 'sched-2', name: 'Weekly cleanup', cron: '0 0 * * 0' }),
    ];
    const transport = createMockTransport({
      listTasks: vi.fn().mockResolvedValue(schedules),
    });

    render(<TasksPanel />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByText('Daily review')).toBeTruthy();
    });

    expect(screen.getByText('Weekly cleanup')).toBeTruthy();
  });

  it('shows loading state initially', async () => {
    // Use a transport where config resolves (to enable tasks) but schedules never resolve
    const transport = createMockTransport({
      listTasks: vi.fn().mockReturnValue(new Promise(() => {})),
    });

    render(<TasksPanel />, { wrapper: createWrapper(transport) });

    // Wait for config to resolve (enabling tasks), then confirm skeleton is shown
    await waitFor(() => {
      // Skeleton rows have animate-tasks elements; check for the skeleton container
      const skeletonDots = document.querySelectorAll('.animate-tasks');
      expect(skeletonDots.length).toBeGreaterThan(0);
    });
  });

  it('"Create Schedule" button opens create dialog', async () => {
    const transport = createMockTransport();

    render(<TasksPanel />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByText('Create Schedule')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Create Schedule'));

    expect(screen.getByTestId('create-schedule-dialog')).toBeTruthy();
    // Dialog should be in create mode (no editSchedule)
    expect(
      screen.getByText('New Schedule', { selector: '[data-testid="create-schedule-dialog"]' })
    ).toBeTruthy();
  });

  it('onEdit callback from TaskRow opens dialog in edit mode', async () => {
    const schedule = createMockSchedule({ id: 'sched-1', name: 'My Job' });
    const transport = createMockTransport({
      listTasks: vi.fn().mockResolvedValue([schedule]),
    });

    render(<TasksPanel />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByText('My Job')).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText('Edit My Job'));

    expect(screen.getByTestId('create-schedule-dialog')).toBeTruthy();
    expect(screen.getByText('Edit Schedule')).toBeTruthy();
  });

  it('passes correct props to TaskRow', async () => {
    const schedule = createMockSchedule({ id: 'sched-1', name: 'My Job', enabled: true });
    const transport = createMockTransport({
      listTasks: vi.fn().mockResolvedValue([schedule]),
    });

    render(<TasksPanel />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByTestId('schedule-row-sched-1')).toBeTruthy();
    });

    // TaskRow receives the schedule and is initially collapsed
    expect(screen.queryByTestId('run-history-sched-1')).toBeNull();
  });

  it('renders a TaskRow for each schedule', async () => {
    const schedules = [
      createMockSchedule({ id: 'sched-1', name: 'Daily review' }),
      createMockSchedule({ id: 'sched-2', name: 'Weekly cleanup' }),
    ];
    const transport = createMockTransport({
      listTasks: vi.fn().mockResolvedValue(schedules),
    });

    render(<TasksPanel />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByTestId('schedule-row-sched-1')).toBeTruthy();
    });

    expect(screen.getByTestId('schedule-row-sched-2')).toBeTruthy();
  });

  it('onToggleExpand from TaskRow expands/collapses run history', async () => {
    const schedule = createMockSchedule({ id: 'sched-1', name: 'My Job' });
    const transport = createMockTransport({
      listTasks: vi.fn().mockResolvedValue([schedule]),
    });

    render(<TasksPanel />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByText('My Job')).toBeTruthy();
    });

    // Run history should not be visible initially
    expect(screen.queryByTestId('run-history-sched-1')).toBeNull();

    // Click the toggle button (exposed by mock TaskRow) to expand
    fireEvent.click(screen.getByText('Toggle My Job'));
    expect(screen.getByTestId('run-history-sched-1')).toBeTruthy();

    // Click again to collapse
    fireEvent.click(screen.getByText('Toggle My Job'));
    expect(screen.queryByTestId('run-history-sched-1')).toBeNull();
  });
});
