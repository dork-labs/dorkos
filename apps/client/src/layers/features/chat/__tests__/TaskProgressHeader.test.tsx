import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { TaskProgressHeader } from '../ui/TaskProgressHeader';
import type { TaskItem } from '@dorkos/shared/types';

afterEach(cleanup);

const makeTasks = (counts: { done: number; active: number; pending: number }): TaskItem[] => {
  const tasks: TaskItem[] = [];
  let id = 1;
  for (let i = 0; i < counts.done; i++)
    tasks.push({ id: String(id++), subject: `Done ${i}`, status: 'completed' });
  for (let i = 0; i < counts.active; i++)
    tasks.push({ id: String(id++), subject: `Active ${i}`, status: 'in_progress' });
  for (let i = 0; i < counts.pending; i++)
    tasks.push({ id: String(id++), subject: `Pending ${i}`, status: 'pending' });
  return tasks;
};

describe('TaskProgressHeader', () => {
  it('shows correct fraction count', () => {
    render(
      <TaskProgressHeader
        tasks={makeTasks({ done: 3, active: 1, pending: 3 })}
        isCollapsed={false}
        onToggleCollapse={() => {}}
      />
    );
    expect(screen.getByText('3/7 tasks')).toBeDefined();
  });

  it('shows singular for 1 task', () => {
    render(
      <TaskProgressHeader
        tasks={makeTasks({ done: 0, active: 0, pending: 1 })}
        isCollapsed={false}
        onToggleCollapse={() => {}}
      />
    );
    expect(screen.getByText('0/1 task')).toBeDefined();
  });

  it('renders progress bar with correct width', () => {
    const { container } = render(
      <TaskProgressHeader
        tasks={makeTasks({ done: 2, active: 0, pending: 2 })}
        isCollapsed={false}
        onToggleCollapse={() => {}}
      />
    );
    const fill = container.querySelector('[data-slot="progress-fill"]');
    expect(fill).not.toBeNull();
    expect(fill?.getAttribute('style')).toContain('width: 50%');
  });

  it('uses green color when all tasks complete', () => {
    const { container } = render(
      <TaskProgressHeader
        tasks={makeTasks({ done: 5, active: 0, pending: 0 })}
        isCollapsed={false}
        onToggleCollapse={() => {}}
      />
    );
    const fill = container.querySelector('[data-slot="progress-fill"]');
    expect(fill?.className).toContain('bg-green-500');
  });

  it('uses blue color when tasks remain', () => {
    const { container } = render(
      <TaskProgressHeader
        tasks={makeTasks({ done: 2, active: 1, pending: 2 })}
        isCollapsed={false}
        onToggleCollapse={() => {}}
      />
    );
    const fill = container.querySelector('[data-slot="progress-fill"]');
    expect(fill?.className).toContain('bg-blue-500');
  });

  it('calls onToggleCollapse when clicked', () => {
    const onToggle = vi.fn();
    render(
      <TaskProgressHeader
        tasks={makeTasks({ done: 1, active: 0, pending: 1 })}
        isCollapsed={false}
        onToggleCollapse={onToggle}
      />
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
