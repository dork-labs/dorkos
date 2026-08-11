/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AgentRunner, type AgentRunnerStatus } from '../AgentRunner';
import { BackgroundTaskBar } from '../BackgroundTaskBar';
import type { VisibleBackgroundTask } from '../../../model/use-background-tasks';
import { TASK_COLORS } from '../../../model/use-background-tasks';

// The bar animates with motion; the runner itself does not. Stripping motion
// keeps the bar renderable in jsdom without touching the runner under test.
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => {
      const { initial: _i, animate: _a, exit: _e, transition: _t, ...domProps } = props;
      return <div {...domProps}>{children}</div>;
    },
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => false,
}));

/** The celebration burst plays for 350ms before the runner settles into its mark. */
const SETTLE_DELAY_MS = 350;

function makeAgent(status: AgentRunnerStatus) {
  return {
    taskId: 'runner-1',
    description: 'Background agent',
    status,
    color: TASK_COLORS[0],
    toolUses: 3,
    durationMs: 12_000,
  };
}

function makeTask(overrides: Partial<VisibleBackgroundTask> = {}): VisibleBackgroundTask {
  return {
    taskId: 'bar-task',
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

/** The settled mark, or null while the runner is still running or celebrating. */
function finishedMark(container: HTMLElement): SVGElement | null {
  return container.querySelector<SVGElement>('svg[data-status]');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AgentRunner', () => {
  it('runs, then settles into its finished mark once the celebration ends', () => {
    const { container, rerender } = render(<AgentRunner agent={makeAgent('running')} index={0} />);

    expect(finishedMark(container)).toBeNull();
    expect(container.querySelector('svg[aria-label="Background agent"]')).not.toBeNull();

    rerender(<AgentRunner agent={makeAgent('complete')} index={0} />);

    // Still celebrating one tick before the settle delay elapses.
    act(() => {
      vi.advanceTimersByTime(SETTLE_DELAY_MS - 1);
    });
    expect(finishedMark(container)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(finishedMark(container)).not.toBeNull();
  });

  // DOR-1108 gave the runner three endings; DOR-1119 is why a person never saw
  // any of them. Each mark is asserted by the strokes it draws, not just by the
  // status it echoes back.
  it('draws the tick when a task finishes successfully', () => {
    const { container, rerender } = render(<AgentRunner agent={makeAgent('running')} index={0} />);
    rerender(<AgentRunner agent={makeAgent('complete')} index={0} />);
    act(() => {
      vi.advanceTimersByTime(SETTLE_DELAY_MS);
    });

    const mark = finishedMark(container);
    expect(mark).toHaveAttribute('data-status', 'complete');
    expect(mark!.querySelector('polyline')).not.toBeNull();
    expect(mark!.querySelectorAll('line')).toHaveLength(0);
  });

  it('draws the cross when a task fails', () => {
    const { container, rerender } = render(<AgentRunner agent={makeAgent('running')} index={0} />);
    rerender(<AgentRunner agent={makeAgent('error')} index={0} />);
    act(() => {
      vi.advanceTimersByTime(SETTLE_DELAY_MS);
    });

    const mark = finishedMark(container);
    expect(mark).toHaveAttribute('data-status', 'error');
    expect(mark!.querySelectorAll('line')).toHaveLength(2);
    expect(mark!.querySelector('polyline')).toBeNull();
  });

  it('draws the dash when DorkOS lost sight of a task', () => {
    const { container, rerender } = render(<AgentRunner agent={makeAgent('running')} index={0} />);
    rerender(<AgentRunner agent={makeAgent('untracked')} index={0} />);
    act(() => {
      vi.advanceTimersByTime(SETTLE_DELAY_MS);
    });

    const mark = finishedMark(container);
    expect(mark).toHaveAttribute('data-status', 'untracked');
    expect(mark!.querySelectorAll('line')).toHaveLength(1);
    expect(mark!.querySelector('polyline')).toBeNull();
  });

  it('shows the mark straight away for a task that is already finished when it appears', () => {
    const { container } = render(<AgentRunner agent={makeAgent('untracked')} index={0} />);

    expect(finishedMark(container)).toHaveAttribute('data-status', 'untracked');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the settle timer when the runner unmounts', () => {
    const { rerender, unmount } = render(<AgentRunner agent={makeAgent('running')} index={0} />);
    rerender(<AgentRunner agent={makeAgent('complete')} index={0} />);

    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('goes back to running if the task starts again before it settles', () => {
    const { container, rerender } = render(<AgentRunner agent={makeAgent('running')} index={0} />);
    rerender(<AgentRunner agent={makeAgent('complete')} index={0} />);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender(<AgentRunner agent={makeAgent('running')} index={0} />);
    act(() => {
      vi.advanceTimersByTime(SETTLE_DELAY_MS + 100);
    });

    expect(finishedMark(container)).toBeNull();
    expect(container.querySelector('svg[aria-label="Background agent"]')).not.toBeNull();
  });
});

describe('AgentRunner on the background task bar', () => {
  it('shows the finished mark on the bar itself, not just the endless runner', () => {
    const { container, rerender } = render(
      <BackgroundTaskBar tasks={[makeTask({ status: 'running' })]} onStopTask={vi.fn()} />
    );

    expect(finishedMark(container)).toBeNull();

    rerender(
      <BackgroundTaskBar tasks={[makeTask({ status: 'untracked' })]} onStopTask={vi.fn()} />
    );
    act(() => {
      vi.advanceTimersByTime(SETTLE_DELAY_MS);
    });

    expect(finishedMark(container)).toHaveAttribute('data-status', 'untracked');
  });
});
