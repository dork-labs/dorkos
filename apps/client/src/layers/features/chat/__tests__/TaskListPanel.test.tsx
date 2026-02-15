import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { TaskListPanel } from '../ui/TaskListPanel';
import type { TaskItem } from '@dorkos/shared/types';

afterEach(() => {
  cleanup();
});

// Mock motion to render plain elements
vi.mock('motion/react', () => ({
  motion: {
    div: React.forwardRef(({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>, ref: React.Ref<HTMLDivElement>) =>
      React.createElement('div', { ...props, ref }, children)
    ),
    ul: React.forwardRef(({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>, ref: React.Ref<HTMLUListElement>) =>
      React.createElement('ul', { ...props, ref }, children)
    ),
    li: React.forwardRef(({ children, onAnimationComplete, ...props }: React.PropsWithChildren<Record<string, unknown>>, ref: React.Ref<HTMLLIElement>) => {
      // Call onAnimationComplete immediately in tests to simulate animation end
      React.useEffect(() => {
        if (typeof onAnimationComplete === 'function') {
          onAnimationComplete();
        }
      }, [onAnimationComplete]);
      return React.createElement('li', { ...props, ref }, children);
    }),
    span: React.forwardRef(({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>, ref: React.Ref<HTMLSpanElement>) =>
      React.createElement('span', { ...props, ref }, children)
    ),
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));

const baseTasks: TaskItem[] = [
  { id: '1', subject: 'Completed task', status: 'completed' },
  { id: '2', subject: 'In progress task', status: 'in_progress', activeForm: 'Working on it' },
  { id: '3', subject: 'Pending task', status: 'pending' },
];

describe('TaskListPanel', () => {
  it('renders nothing when tasks array is empty', () => {
    const { container } = render(
      <TaskListPanel tasks={[]} activeForm={null} isCollapsed={false} onToggleCollapse={() => {}} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows correct task counts in header', () => {
    render(
      <TaskListPanel tasks={baseTasks} activeForm={null} isCollapsed={false} onToggleCollapse={() => {}} />
    );
    expect(screen.getByText(/3 tasks/)).toBeDefined();
    expect(screen.getByText(/1 done/)).toBeDefined();
    expect(screen.getByText(/1 in progress/)).toBeDefined();
    expect(screen.getByText(/1 open/)).toBeDefined();
  });

  it('renders all task subjects', () => {
    render(
      <TaskListPanel tasks={baseTasks} activeForm={null} isCollapsed={false} onToggleCollapse={() => {}} />
    );
    expect(screen.getByText('Completed task')).toBeDefined();
    expect(screen.getByText('In progress task')).toBeDefined();
    expect(screen.getByText('Pending task')).toBeDefined();
  });

  it('applies line-through styling to completed tasks', () => {
    render(
      <TaskListPanel tasks={baseTasks} activeForm={null} isCollapsed={false} onToggleCollapse={() => {}} />
    );
    const completedItem = screen.getByText('Completed task').closest('li');
    expect(completedItem?.className).toContain('line-through');
  });

  it('applies bold styling to in-progress tasks', () => {
    render(
      <TaskListPanel tasks={baseTasks} activeForm={null} isCollapsed={false} onToggleCollapse={() => {}} />
    );
    const inProgressItem = screen.getByText('In progress task').closest('li');
    expect(inProgressItem?.className).toContain('font-medium');
  });

  it('shows activeForm spinner text when provided', () => {
    render(
      <TaskListPanel tasks={baseTasks} activeForm="Working on it" isCollapsed={false} onToggleCollapse={() => {}} />
    );
    // activeForm text appears as spinner label
    expect(screen.getByText('Working on it')).toBeDefined();
  });

  it('hides task list when collapsed', () => {
    render(
      <TaskListPanel tasks={baseTasks} activeForm={null} isCollapsed={true} onToggleCollapse={() => {}} />
    );
    // Header should still be visible
    expect(screen.getByText(/3 tasks/)).toBeDefined();
    // Task subjects should not be visible
    expect(screen.queryByText('Completed task')).toBeNull();
  });

  it('calls onToggleCollapse when header is clicked', () => {
    const onToggle = vi.fn();
    render(
      <TaskListPanel tasks={baseTasks} activeForm={null} isCollapsed={false} onToggleCollapse={onToggle} />
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('shows overflow count when more than 10 tasks', () => {
    const manyTasks: TaskItem[] = Array.from({ length: 12 }, (_, i) => ({
      id: String(i + 1),
      subject: `Task ${i + 1}`,
      status: 'pending' as const,
    }));

    render(
      <TaskListPanel tasks={manyTasks} activeForm={null} isCollapsed={false} onToggleCollapse={() => {}} />
    );
    expect(screen.getByText(/\+2 more/)).toBeDefined();
  });

  it('handles singular task count', () => {
    const singleTask: TaskItem[] = [
      { id: '1', subject: 'Only task', status: 'pending' },
    ];

    render(
      <TaskListPanel tasks={singleTask} activeForm={null} isCollapsed={false} onToggleCollapse={() => {}} />
    );
    expect(screen.getByText(/1 task\b/)).toBeDefined();
  });

  it('applies celebration effects when celebratingTaskId matches a completed task', () => {
    const completedTasks: TaskItem[] = [
      { id: '1', subject: 'Done task', status: 'completed' },
      { id: '2', subject: 'Open task', status: 'pending' },
    ];
    render(
      <TaskListPanel
        tasks={completedTasks}
        activeForm={null}
        isCollapsed={false}
        onToggleCollapse={() => {}}
        celebratingTaskId="1"
      />
    );
    // Should render shimmer div with aria-hidden and absolute positioning
    const shimmer = document.querySelector('[aria-hidden="true"].absolute');
    expect(shimmer).not.toBeNull();
  });

  it('calls onCelebrationComplete after animation finishes', () => {
    const onComplete = vi.fn();
    const completedTasks: TaskItem[] = [
      { id: '1', subject: 'Done task', status: 'completed' },
    ];
    render(
      <TaskListPanel
        tasks={completedTasks}
        activeForm={null}
        isCollapsed={false}
        onToggleCollapse={() => {}}
        celebratingTaskId="1"
        onCelebrationComplete={onComplete}
      />
    );
    expect(onComplete).toHaveBeenCalled();
  });

  it('does not apply celebration effects to non-matching tasks', () => {
    const tasks: TaskItem[] = [
      { id: '1', subject: 'Task A', status: 'completed' },
      { id: '2', subject: 'Task B', status: 'pending' },
    ];
    render(
      <TaskListPanel
        tasks={tasks}
        activeForm={null}
        isCollapsed={false}
        onToggleCollapse={() => {}}
        celebratingTaskId="999"
      />
    );
    const shimmer = document.querySelector('[aria-hidden="true"].absolute');
    expect(shimmer).toBeNull();
  });

  it('handles celebratingTaskId being null gracefully', () => {
    render(
      <TaskListPanel
        tasks={baseTasks}
        activeForm={null}
        isCollapsed={false}
        onToggleCollapse={() => {}}
        celebratingTaskId={null}
      />
    );
    // Should render normally without celebration effects
    expect(screen.getByText('Completed task')).toBeDefined();
  });
});
