import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { TaskListPanel } from '../ui/TaskListPanel';
import type { TaskItem } from '@dorkos/shared/types';

afterEach(cleanup);

const baseTasks: TaskItem[] = [
  { id: '1', subject: 'Completed task', status: 'completed' },
  { id: '2', subject: 'In progress task', status: 'in_progress', activeForm: 'Working on it' },
  { id: '3', subject: 'Pending task', status: 'pending' },
];

const makeMap = (tasks: TaskItem[]) => new Map(tasks.map((t) => [t.id, t]));
const emptyTimestamps = new Map<string, { status: string; since: number }>();

const baseProps = {
  activeForm: null as string | null,
  isCollapsed: false,
  onToggleCollapse: vi.fn(),
  statusTimestamps: emptyTimestamps,
};

describe('TaskListPanel', () => {
  it('renders nothing when tasks array is empty', () => {
    const { container } = render(<TaskListPanel tasks={[]} taskMap={new Map()} {...baseProps} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows correct progress count in header', () => {
    render(<TaskListPanel tasks={baseTasks} taskMap={makeMap(baseTasks)} {...baseProps} />);
    expect(screen.getByText('1/3 tasks')).toBeDefined();
  });

  it('renders all task subjects', () => {
    render(<TaskListPanel tasks={baseTasks} taskMap={makeMap(baseTasks)} {...baseProps} />);
    expect(screen.getByText('Completed task')).toBeDefined();
    expect(screen.getByText('In progress task')).toBeDefined();
    expect(screen.getByText('Pending task')).toBeDefined();
  });

  it('applies line-through styling to completed tasks', () => {
    render(<TaskListPanel tasks={baseTasks} taskMap={makeMap(baseTasks)} {...baseProps} />);
    const row = screen.getByText('Completed task').closest('[role="button"]');
    expect(row?.className).toContain('line-through');
  });

  it('applies bold styling to in-progress tasks', () => {
    render(<TaskListPanel tasks={baseTasks} taskMap={makeMap(baseTasks)} {...baseProps} />);
    const row = screen.getByText('In progress task').closest('[role="button"]');
    expect(row?.className).toContain('font-medium');
  });

  it('shows activeForm spinner text when provided', () => {
    render(
      <TaskListPanel
        tasks={baseTasks}
        taskMap={makeMap(baseTasks)}
        {...baseProps}
        activeForm="Working on it"
      />
    );
    expect(screen.getByText('Working on it')).toBeDefined();
  });

  it('hides task list when collapsed', () => {
    render(
      <TaskListPanel
        tasks={baseTasks}
        taskMap={makeMap(baseTasks)}
        {...baseProps}
        isCollapsed={true}
      />
    );
    expect(screen.getByText('1/3 tasks')).toBeDefined();
    expect(screen.queryByText('Completed task')).toBeNull();
  });

  it('calls onToggleCollapse when header is clicked', () => {
    const onToggle = vi.fn();
    render(
      <TaskListPanel
        tasks={baseTasks}
        taskMap={makeMap(baseTasks)}
        {...baseProps}
        onToggleCollapse={onToggle}
      />
    );
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('expands task detail when task row is clicked', () => {
    const taskWithDesc: TaskItem[] = [
      { id: '1', subject: 'Task with detail', status: 'pending', description: 'Detailed info' },
    ];
    render(<TaskListPanel tasks={taskWithDesc} taskMap={makeMap(taskWithDesc)} {...baseProps} />);
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[1]);
    expect(screen.getByText('Detailed info')).toBeDefined();
  });

  it('dims blocked tasks', () => {
    const tasks: TaskItem[] = [
      { id: '1', subject: 'Unblocked', status: 'pending' },
      { id: '2', subject: 'Blocked', status: 'pending', blockedBy: ['1'] },
    ];
    render(<TaskListPanel tasks={tasks} taskMap={makeMap(tasks)} {...baseProps} />);
    const blockedRow = screen.getByText('Blocked').closest('[role="button"]');
    expect(blockedRow?.className).toContain('text-muted-foreground/50');
  });

  it('shows celebration effects on completing task', () => {
    const tasks: TaskItem[] = [{ id: '1', subject: 'Done task', status: 'completed' }];
    render(
      <TaskListPanel tasks={tasks} taskMap={makeMap(tasks)} {...baseProps} celebratingTaskId="1" />
    );
    const shimmer = document.querySelector('[aria-hidden="true"]');
    expect(shimmer).not.toBeNull();
  });

  it('handles singular task count', () => {
    const singleTask: TaskItem[] = [{ id: '1', subject: 'Only task', status: 'pending' }];
    render(<TaskListPanel tasks={singleTask} taskMap={makeMap(singleTask)} {...baseProps} />);
    expect(screen.getByText('0/1 task')).toBeDefined();
  });
});
