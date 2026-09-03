// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Task } from '@dorkos/shared/types';

let mockTasks: Task[] = [];

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
  CreateTaskDialog: () => null,
}));

vi.mock('@/layers/features/tasks/ui/TasksList', () => ({
  TasksList: () => <div data-testid="tasks-list" />,
}));

import { TasksPage } from '../ui/TasksPage';

afterEach(() => {
  cleanup();
  mockTasks = [];
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
