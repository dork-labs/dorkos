// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Task } from '@dorkos/shared/types';

let mockTasks: Task[] = [];
vi.mock('@/layers/features/dashboard-attention', () => ({
  FailedRunDetailSheet: ({ open, itemId }: { open: boolean; itemId?: string }) =>
    open ? <div data-testid="linked-run">{itemId}</div> : null,
}));

const route = vi.hoisted(() => ({
  search: {} as { schedule?: string; run?: string },
  navigate: vi.fn(),
}));

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSafeSearch: () => route.search,
  useSafeNavigate: () => route.navigate,
}));

vi.mock('@/layers/entities/tasks', () => ({
  useTasksEnabled: () => true,
  useTasks: () => ({ data: mockTasks, isLoading: false, isError: false, refetch: vi.fn() }),
  useTaskTemplateDialog: () => ({ externalTrigger: false, clear: vi.fn() }),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useRegisteredAgents: () => ({ data: { agents: [] } }),
}));

vi.mock('@/layers/features/tasks', () => ({
  TasksEmptyState: () => <div data-testid="empty-state">No schedules yet.</div>,
  CreateTaskDialog: ({
    open,
    editTask,
    onOpenChange,
  }: {
    open: boolean;
    editTask?: Task;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? <button onClick={() => onOpenChange(false)}>Editing {editTask?.name}</button> : null,
  TasksList: () => <div data-testid="tasks-list" />,
}));

import { TasksPage } from '../ui/TasksPage';

afterEach(() => {
  cleanup();
  mockTasks = [];
  route.search = {};
  route.navigate.mockClear();
});

it('opens the schedule named by a notice and clears the link when closed', async () => {
  const { fireEvent } = await import('@testing-library/react');
  route.search = { schedule: 'nightly' };
  mockTasks = [{ id: 'nightly', name: 'Nightly sweep' } as Task];
  render(<TasksPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Editing Nightly sweep' }));
  expect(route.navigate).toHaveBeenCalledWith({
    to: '/tasks',
    search: { schedule: undefined },
    replace: true,
  });
});

describe('TasksPage — the empty state is taller than a phone', () => {
  it('puts the empty state in the page scroller, like the list branch', () => {
    // The empty state is a four-card gallery: about 770px of content in a 752px
    // region at 390×844. It used to sit in a bare `h-full … justify-center`
    // box with no scroller, so the overflow split evenly above and below and
    // the heading rendered behind the sticky header, unreachable.
    render(<TasksPage />);

    const container = screen.getByTestId('empty-state').closest('[data-slot="page-container"]');
    expect(container).not.toBeNull();
    expect(container?.parentElement?.className).toContain('overflow-y-auto');
  });

  it('starts the empty state at the top rather than centring it', () => {
    render(<TasksPage />);

    expect(screen.getByTestId('empty-state').closest('.justify-center')).toBeNull();
  });
});

it('opens the specific run rather than the schedule editor', () => {
  route.search = { schedule: 'nightly', run: 'failed-run' };
  mockTasks = [{ id: 'nightly', name: 'Nightly sweep' } as Task];
  render(<TasksPage />);
  expect(screen.queryByRole('button', { name: 'Editing Nightly sweep' })).toBeNull();
  expect(screen.getByTestId('linked-run')).toHaveTextContent('failed-run');
});
