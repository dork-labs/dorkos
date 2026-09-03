/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TaskDetailPanel } from '../TaskDetailPanel';
import type { VisibleBackgroundTask } from '../../../model/use-background-tasks';
import { TASK_COLORS } from '../../../model/use-background-tasks';

afterEach(cleanup);

function makeTask(overrides: Partial<VisibleBackgroundTask> = {}): VisibleBackgroundTask {
  return {
    taskId: `task-${Math.random().toString(36).slice(2)}`,
    taskType: 'agent',
    status: 'running',
    color: TASK_COLORS[0],
    startedAt: Date.now() - 30_000,
    description: 'Background agent',
    toolUses: 5,
    durationMs: 30_000,
    ...overrides,
  };
}

describe('TaskDetailPanel', () => {
  it('renders a row for each task', () => {
    const tasks = [
      makeTask({ taskId: 'a-1', taskType: 'agent', description: 'Refactor auth module' }),
      makeTask({
        taskId: 'b-1',
        taskType: 'bash',
        command: 'npm run dev',
        description: undefined,
      }),
    ];

    render(<TaskDetailPanel tasks={tasks} onStopTask={vi.fn()} />);
    expect(screen.getByText('Refactor auth module')).toBeInTheDocument();
    expect(screen.getByText('npm run dev')).toBeInTheDocument();
  });

  it('shows type badges for agent and bash tasks', () => {
    const tasks = [
      makeTask({ taskId: 'a-1', taskType: 'agent' }),
      makeTask({ taskId: 'b-1', taskType: 'bash', command: 'ls' }),
    ];

    render(<TaskDetailPanel tasks={tasks} onStopTask={vi.fn()} />);
    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByText('bash')).toBeInTheDocument();
  });

  it('renders kill button only for running tasks', () => {
    const tasks = [
      makeTask({ taskId: 'running-1', status: 'running' }),
      makeTask({ taskId: 'complete-1', status: 'complete' }),
    ];

    render(<TaskDetailPanel tasks={tasks} onStopTask={vi.fn()} />);
    const killButtons = screen.getAllByLabelText('Stop task');
    expect(killButtons).toHaveLength(1);
  });

  it('does not render kill button for completed tasks', () => {
    const tasks = [makeTask({ taskId: 'done-1', status: 'complete' })];

    render(<TaskDetailPanel tasks={tasks} onStopTask={vi.fn()} />);
    expect(screen.queryByLabelText('Stop task')).not.toBeInTheDocument();
  });

  it('does not render kill button for error tasks', () => {
    const tasks = [makeTask({ taskId: 'err-1', status: 'error' })];

    render(<TaskDetailPanel tasks={tasks} onStopTask={vi.fn()} />);
    expect(screen.queryByLabelText('Stop task')).not.toBeInTheDocument();
  });

  it('calls onStopTask with correct taskId when bash kill button clicked', async () => {
    const user = userEvent.setup();
    const onStopTask = vi.fn();
    const tasks = [
      makeTask({ taskId: 'bash-1', taskType: 'bash', command: 'npm test', status: 'running' }),
    ];

    render(<TaskDetailPanel tasks={tasks} onStopTask={onStopTask} />);

    await user.click(screen.getByLabelText('Stop task'));
    expect(onStopTask).toHaveBeenCalledWith('bash-1');
  });

  it('renders completed tasks with reduced opacity', () => {
    const tasks = [makeTask({ taskId: 'done-1', status: 'complete', description: 'Done task' })];

    const { container } = render(<TaskDetailPanel tasks={tasks} onStopTask={vi.fn()} />);
    const row = container.querySelector('.opacity-60');
    expect(row).toBeInTheDocument();
  });

  it('renders running tasks without reduced opacity', () => {
    const tasks = [makeTask({ taskId: 'active-1', status: 'running', description: 'Active task' })];

    const { container } = render(<TaskDetailPanel tasks={tasks} onStopTask={vi.fn()} />);
    expect(container.querySelector('.opacity-60')).not.toBeInTheDocument();
  });

  it('shows tool count for agent tasks', () => {
    const tasks = [makeTask({ taskId: 'a-1', taskType: 'agent', toolUses: 12 })];

    render(<TaskDetailPanel tasks={tasks} onStopTask={vi.fn()} />);
    expect(screen.getByText('12 tools')).toBeInTheDocument();
  });

  it('shows duration for tasks with elapsed time', () => {
    const tasks = [makeTask({ taskId: 'a-1', durationMs: 45_000 })];

    render(<TaskDetailPanel tasks={tasks} onStopTask={vi.fn()} />);
    expect(screen.getByText('45s')).toBeInTheDocument();
  });

  // DOR-1753: the runner figure's hover tooltip is desktop-only, so this row
  // is the only place a touch user ever sees the last tool an agent ran.
  it('shows the last tool an agent ran, the touch path to the desktop hover tooltip', () => {
    const tasks = [makeTask({ taskId: 'a-1', taskType: 'agent', lastToolName: 'Read' })];

    render(<TaskDetailPanel tasks={tasks} onStopTask={vi.fn()} />);
    expect(screen.getByText('Last: Read')).toBeInTheDocument();
  });

  it('says nothing about a last tool for a bash task or an agent that has not run one yet', () => {
    const tasks = [
      makeTask({ taskId: 'a-1', taskType: 'agent', lastToolName: undefined }),
      makeTask({ taskId: 'b-1', taskType: 'bash', command: 'ls', lastToolName: 'Read' }),
    ];

    render(<TaskDetailPanel tasks={tasks} onStopTask={vi.fn()} />);
    expect(screen.queryByText(/^Last:/)).not.toBeInTheDocument();
  });
});
