import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { TaskListPanel } from '../TaskListPanel';
import type { TaskItem } from '@lifeos/shared/types';

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
});
