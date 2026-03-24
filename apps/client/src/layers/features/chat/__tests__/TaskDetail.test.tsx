import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { TaskDetail } from '../ui/TaskDetail';
import type { TaskItem } from '@dorkos/shared/types';

afterEach(cleanup);

const makeMap = (tasks: TaskItem[]): Map<string, TaskItem> => new Map(tasks.map((t) => [t.id, t]));

const taskA: TaskItem = {
  id: '1',
  subject: 'Task A',
  status: 'in_progress',
  description: 'Doing important work',
};
const taskB: TaskItem = { id: '2', subject: 'Task B', status: 'pending', blockedBy: ['1'] };
const taskC: TaskItem = { id: '3', subject: 'Task C', status: 'pending', owner: 'sub-agent-1' };

describe('TaskDetail', () => {
  it('renders description when present', () => {
    render(
      <TaskDetail
        task={taskA}
        taskMap={makeMap([taskA])}
        statusSince={Date.now() - 5000}
        onScrollToTask={() => {}}
      />
    );
    expect(screen.getByText('Doing important work')).toBeDefined();
  });

  it('omits description section when not present', () => {
    const noDesc: TaskItem = { id: '4', subject: 'No desc', status: 'pending' };
    render(
      <TaskDetail
        task={noDesc}
        taskMap={makeMap([noDesc])}
        statusSince={Date.now()}
        onScrollToTask={() => {}}
      />
    );
    expect(screen.queryByText('Doing important work')).toBeNull();
  });

  it('shows blocked-by dependencies with task subjects', () => {
    const map = makeMap([taskA, taskB]);
    render(
      <TaskDetail task={taskB} taskMap={map} statusSince={Date.now()} onScrollToTask={() => {}} />
    );
    expect(screen.getByText(/Task A/)).toBeDefined();
  });

  it('shows owner when present', () => {
    render(
      <TaskDetail
        task={taskC}
        taskMap={makeMap([taskC])}
        statusSince={Date.now()}
        onScrollToTask={() => {}}
      />
    );
    expect(screen.getByText('sub-agent-1')).toBeDefined();
  });

  it('calls onScrollToTask when dependency is clicked', () => {
    const onScroll = vi.fn();
    const map = makeMap([taskA, taskB]);
    render(
      <TaskDetail task={taskB} taskMap={map} statusSince={Date.now()} onScrollToTask={onScroll} />
    );
    fireEvent.click(screen.getByText('Task A'));
    expect(onScroll).toHaveBeenCalledWith('1');
  });

  it('shows elapsed time', () => {
    render(
      <TaskDetail
        task={taskA}
        taskMap={makeMap([taskA])}
        statusSince={Date.now() - 65000}
        onScrollToTask={() => {}}
      />
    );
    expect(screen.getByText(/1m/)).toBeDefined();
  });
});
