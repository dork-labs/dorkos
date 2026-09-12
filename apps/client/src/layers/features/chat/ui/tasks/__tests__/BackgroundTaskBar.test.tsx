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
    ambientTasks = [],
    onStopTask,
  }: {
    tasks: VisibleBackgroundTask[];
    ambientTasks?: VisibleBackgroundTask[];
    onStopTask: (id: string) => void;
  }) => (
    <div data-testid="task-detail-panel" data-ambient-count={ambientTasks.length}>
      {[...tasks, ...ambientTasks].map((t) => (
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
    ambient: false,
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

    // `data-testid`, not a positional sibling query (DOR-1753, adversarial
    // review nit N5) — `badge.nextElementSibling` happened to work only
    // because nothing else sits between the badge and the tooltip today.
    const tooltip = screen.getByTestId('overflow-badge-tooltip');
    expect(tooltip.className).toContain('hidden');
    expect(tooltip.className).toContain('md:block');
    // Sanity: this really is the overflow tooltip, not some other sibling.
    expect(container.textContent).toContain('Agent 4');
  });

  it('renders mixed agent + bash tasks with correct aria-label', () => {
    const agentTask = makeTask({ taskId: 'mx-a', taskType: 'agent' });
    const bashTask = makeTask({ taskId: 'mx-b', taskType: 'bash', command: 'make' });

    render(<BackgroundTaskBar tasks={[agentTask, bashTask]} onStopTask={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-label', '2 background tasks running');
  });

  // === Housekeeping (ambient) tasks ===
  //
  // Spec `ambient-background-tasks`: the runtime marks work it started on its
  // own behalf, and asks hosts to keep it out of activity indicators. The bar is
  // one, so it counts none of them — and when they are all there is, it is not
  // drawn at all. The session still reads as working, because that follows the
  // turn in flight rather than this bar.

  it('empties the row down to the chevron when every running task is housekeeping', () => {
    const tasks = [
      makeTask({ taskId: 'amb-1', ambient: true }),
      makeTask({ taskId: 'amb-2', ambient: true, taskType: 'bash', command: 'git status' }),
    ];

    render(<BackgroundTaskBar tasks={tasks} onStopTask={vi.fn()} />);

    // Nothing that counts as an indicator: no figure, no dot, no tally, no
    // number beside the chevron, and no `role="status"` to announce itself.
    expect(screen.queryByTestId('agent-runner-amb-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-dot-section')).not.toBeInTheDocument();
    expect(screen.queryByText(/task[s]? running/)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();

    // But still a way in — the panel is the only place these can be seen, and a
    // bar that vanished would make them unreachable rather than merely quiet.
    expect(screen.getByLabelText('Expand task details')).toBeInTheDocument();
  });

  it('reaches the housekeeping list through the chevron with nothing else running', async () => {
    const user = userEvent.setup();
    const tasks = [
      makeTask({ taskId: 'amb-1', ambient: true }),
      makeTask({ taskId: 'amb-2', ambient: true }),
    ];

    render(<BackgroundTaskBar tasks={tasks} onStopTask={vi.fn()} />);
    await user.click(screen.getByLabelText('Expand task details'));

    const panel = screen.getByTestId('task-detail-panel');
    expect(panel).toHaveAttribute('data-ambient-count', '2');
    expect(screen.getByRole('button', { name: 'Stop amb-1' })).toBeInTheDocument();
  });

  it('renders nothing when there is no task at all', () => {
    const { container } = render(<BackgroundTaskBar tasks={[]} onStopTask={vi.fn()} />);

    expect(container.innerHTML).toBe('');
  });

  it('leaves housekeeping tasks out of the count, the figures and the dots', async () => {
    const user = userEvent.setup();
    const tasks = [
      makeTask({ taskId: 'work', taskType: 'agent', toolUses: 4 }),
      makeTask({ taskId: 'amb-agent', ambient: true, taskType: 'agent', toolUses: 99 }),
      makeTask({ taskId: 'amb-bash', ambient: true, taskType: 'bash', command: 'git status' }),
    ];

    render(<BackgroundTaskBar tasks={tasks} onStopTask={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-label', '1 background task running');
    expect(screen.getByTestId('agent-runner-work')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-runner-amb-agent')).not.toBeInTheDocument();
    // No bash task is visible, so the dot section is not drawn at all.
    expect(screen.queryByTestId('task-dot-section')).not.toBeInTheDocument();
    // The stats line counts the same tasks the figures do.
    expect(screen.getByText(/4 tools/)).toBeInTheDocument();

    // The count of hidden tasks is stated in the expanded panel and nowhere else.
    await user.click(screen.getByLabelText('Expand task details'));
    expect(screen.getByTestId('task-detail-panel')).toHaveAttribute('data-ambient-count', '2');
  });

  it('keeps housekeeping tasks out of the overflow badge', () => {
    const tasks = [
      ...Array.from({ length: 4 }, (_, i) => makeTask({ taskId: `ov-${i}`, taskType: 'agent' })),
      ...Array.from({ length: 3 }, (_, i) =>
        makeTask({ taskId: `ov-amb-${i}`, ambient: true, taskType: 'agent' })
      ),
    ];

    render(<BackgroundTaskBar tasks={tasks} onStopTask={vi.fn()} />);

    // Four ordinary agents fill the row exactly; the three hidden ones must not
    // push a "+3" badge onto a bar that has nothing more to show.
    expect(screen.queryByText('+3')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', '4 background tasks running');
  });
});
