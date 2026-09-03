/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { BackgroundTaskBar } from '../BackgroundTaskBar';
import type { VisibleBackgroundTask } from '../../../model/use-background-tasks';
import { TASK_COLORS } from '../../../model/use-background-tasks';

// Mock child components to isolate BackgroundTaskBar logic. The stub runner
// only echoes the status it was handed, so nothing here can see what the runner
// actually draws — that lives in AgentRunner.test.tsx, which drives the real
// component and was what a mock like this hid for a whole release (DOR-1119).
vi.mock('../AgentRunner', () => ({
  AgentRunner: ({ agent }: { agent: { taskId: string; description: string; status: string } }) => (
    <div data-testid={`agent-runner-${agent.taskId}`} data-status={agent.status}>
      {agent.description}
    </div>
  ),
}));

vi.mock('../TaskDotSection', () => ({
  TaskDotSection: ({ bashTasks }: { bashTasks: VisibleBackgroundTask[] }) => (
    <div data-testid="task-dot-section">{bashTasks.length} dots</div>
  ),
}));

vi.mock('../TaskDetailPanel', () => ({
  TaskDetailPanel: ({
    tasks,
    onStopTask,
  }: {
    tasks: VisibleBackgroundTask[];
    onStopTask: (id: string) => void;
  }) => (
    <div data-testid="task-detail-panel">
      {tasks.map((t) => (
        <button key={t.taskId} onClick={() => onStopTask(t.taskId)}>
          Stop {t.taskId}
        </button>
      ))}
    </div>
  ),
}));

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<VisibleBackgroundTask> = {}): VisibleBackgroundTask {
  return {
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackgroundTaskBar', () => {
  it('renders nothing when tasks array is empty', () => {
    const { container } = render(<BackgroundTaskBar tasks={[]} onStopTask={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the status bar with correct task count for a single task', () => {
    const task = makeTask({ taskId: 'a-1' });
    render(<BackgroundTaskBar tasks={[task]} onStopTask={vi.fn()} />);

    const status = screen.getByRole('status');
    expect(status).toBeInTheDocument();
    expect(status).toHaveAttribute('aria-label', '1 background task running');
    expect(screen.getByText(/task running/)).toBeInTheDocument();
  });

  // DOR-1108: the runner draws four marks and the task has five statuses, so the
  // collapse decides what a person sees. Only `stopped` may borrow the tick —
  // folding `untracked` in with it drew a task DorkOS merely lost sight of as one
  // that finished successfully.
  it('passes untracked through to the runner instead of collapsing it to complete', () => {
    const tasks = [
      makeTask({ taskId: 'u-1', status: 'untracked' }),
      makeTask({ taskId: 'u-2', status: 'stopped' }),
      makeTask({ taskId: 'u-3', status: 'error' }),
    ];
    render(<BackgroundTaskBar tasks={tasks} onStopTask={vi.fn()} />);

    expect(screen.getByTestId('agent-runner-u-1')).toHaveAttribute('data-status', 'untracked');
    // A stop somebody observed is a real ending, and keeps the tick.
    expect(screen.getByTestId('agent-runner-u-2')).toHaveAttribute('data-status', 'complete');
    expect(screen.getByTestId('agent-runner-u-3')).toHaveAttribute('data-status', 'error');
  });

  it('pluralizes the task count label for multiple tasks', () => {
    const tasks = [makeTask({ taskId: 'p-1' }), makeTask({ taskId: 'p-2' })];
    render(<BackgroundTaskBar tasks={tasks} onStopTask={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-label', '2 background tasks running');
    expect(screen.getByText(/tasks running/)).toBeInTheDocument();
  });

  it('renders AgentRunner for agent tasks', () => {
    const task = makeTask({ taskId: 'agent-1', taskType: 'agent', description: 'Analyzing' });
    render(<BackgroundTaskBar tasks={[task]} onStopTask={vi.fn()} />);

    expect(screen.getByTestId('agent-runner-agent-1')).toBeInTheDocument();
  });

  it('renders TaskDotSection for bash tasks', () => {
    const task = makeTask({
      taskId: 'bash-1',
      taskType: 'bash',
      command: 'npm test',
      description: undefined,
    });
    render(<BackgroundTaskBar tasks={[task]} onStopTask={vi.fn()} />);

    expect(screen.getByTestId('task-dot-section')).toBeInTheDocument();
  });

  it('renders separator when both agent and bash tasks are present', () => {
    const agentTask = makeTask({ taskId: 'sep-a', taskType: 'agent' });
    const bashTask = makeTask({ taskId: 'sep-b', taskType: 'bash', command: 'ls' });

    const { container } = render(
      <BackgroundTaskBar tasks={[agentTask, bashTask]} onStopTask={vi.fn()} />
    );

    // Separator is a div with bg-border class
    const separators = container.querySelectorAll('.bg-border.h-4.w-px');
    expect(separators.length).toBeGreaterThanOrEqual(1);
  });

  it('does not render separator when only agent tasks are present', () => {
    const tasks = [makeTask({ taskId: 'only-a', taskType: 'agent' })];

    render(<BackgroundTaskBar tasks={tasks} onStopTask={vi.fn()} />);

    expect(screen.queryByTestId('task-dot-section')).not.toBeInTheDocument();
  });

  it('shows tool count in stats when agents have tool uses', () => {
    const task = makeTask({ taskId: 't-1', toolUses: 12, durationMs: 45_000 });
    render(<BackgroundTaskBar tasks={[task]} onStopTask={vi.fn()} />);

    expect(screen.getByText(/12 tools/)).toBeInTheDocument();
    expect(screen.getByText(/45s/)).toBeInTheDocument();
  });

  it('toggles expand state on chevron button click', async () => {
    const user = userEvent.setup();
    const task = makeTask({ taskId: 'exp-1' });
    render(<BackgroundTaskBar tasks={[task]} onStopTask={vi.fn()} />);

    const toggle = screen.getByRole('button', { name: /expand task details/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('task-detail-panel')).toBeInTheDocument();
  });

  it('passes onStopTask through to TaskDetailPanel', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const task = makeTask({ taskId: 'stop-1' });
    render(<BackgroundTaskBar tasks={[task]} onStopTask={onStop} />);

    // Expand to show detail panel
    await user.click(screen.getByRole('button', { name: /expand task details/i }));

    // Click the stop button rendered by our mock TaskDetailPanel
    await user.click(screen.getByText('Stop stop-1'));
    expect(onStop).toHaveBeenCalledWith('stop-1');
  });

  it('shows overflow badge when more than 4 agent tasks', () => {
    const tasks = Array.from({ length: 6 }, (_, i) =>
      makeTask({ taskId: `of-${i}`, taskType: 'agent', description: `Agent ${i}` })
    );

    render(<BackgroundTaskBar tasks={tasks} onStopTask={vi.fn()} />);

    // Only first 4 agents get AgentRunner, the rest are in overflow
    expect(screen.getByTestId('agent-runner-of-0')).toBeInTheDocument();
    expect(screen.getByTestId('agent-runner-of-3')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-runner-of-4')).not.toBeInTheDocument();

    // Overflow badge shows +2, pluralized since count > 1
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByLabelText('2 more subagents running')).toBeInTheDocument();
  });

  it('singularizes the overflow badge aria-label when exactly 1 agent overflows', () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ taskId: `so-${i}`, taskType: 'agent', description: `Agent ${i}` })
    );

    render(<BackgroundTaskBar tasks={tasks} onStopTask={vi.fn()} />);

    // Overflow badge shows +1, singular since count === 1
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByLabelText('1 more subagent running')).toBeInTheDocument();
  });

  // DOR-1753: `:hover` never fires on touch, so the overflow badge's tooltip
  // is desktop-only; the tap-to-expand task list already names every task,
  // overflow included, as the touch path to the same names.
  it('keeps the overflow badge tooltip desktop-only (hidden md:block)', () => {
    const tasks = Array.from({ length: 6 }, (_, i) =>
      makeTask({ taskId: `hide-${i}`, taskType: 'agent', description: `Agent ${i}` })
    );

    const { container } = render(<BackgroundTaskBar tasks={tasks} onStopTask={vi.fn()} />);

    const badge = screen.getByText('+2');
    const tooltip = badge.nextElementSibling;
    expect(tooltip?.className).toContain('hidden');
    expect(tooltip?.className).toContain('md:block');
    // Sanity: this really is the overflow tooltip, not some other sibling.
    expect(container.textContent).toContain('Agent 4');
  });

  it('renders mixed agent + bash tasks with correct aria-label', () => {
    const agentTask = makeTask({ taskId: 'mx-a', taskType: 'agent' });
    const bashTask = makeTask({ taskId: 'mx-b', taskType: 'bash', command: 'make' });

    render(<BackgroundTaskBar tasks={[agentTask, bashTask]} onStopTask={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-label', '2 background tasks running');
  });
});
