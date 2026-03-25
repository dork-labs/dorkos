/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBackgroundTasks, TASK_COLORS } from '../use-background-tasks';
import type { ChatMessage } from '../chat-types';
import type { BackgroundTaskPart } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function makePart(overrides: Partial<BackgroundTaskPart> = {}): BackgroundTaskPart {
  idCounter += 1;
  return {
    type: 'background_task',
    taskId: `task-${idCounter}`,
    taskType: 'agent',
    status: 'running',
    startedAt: Date.now() - 30_000,
    ...overrides,
  };
}

function wrapMessages(parts: BackgroundTaskPart[]): ChatMessage[] {
  return [
    {
      id: 'msg-1',
      role: 'assistant',
      content: '',
      parts,
      timestamp: new Date().toISOString(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  idCounter = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useBackgroundTasks', () => {
  // === Agent tasks ===

  it('returns running agent tasks immediately', () => {
    const part = makePart({ taskType: 'agent', status: 'running' });
    const { result } = renderHook(() => useBackgroundTasks(wrapMessages([part])));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].taskId).toBe(part.taskId);
    expect(result.current[0].taskType).toBe('agent');
  });

  it('excludes terminal agent tasks that are not celebrating', () => {
    const part = makePart({ taskType: 'agent', status: 'complete' });
    const { result } = renderHook(() => useBackgroundTasks(wrapMessages([part])));

    expect(result.current).toHaveLength(0);
  });

  it('uses the latest status when the same taskId appears across messages', () => {
    const first = makePart({ taskId: 'dup', taskType: 'agent', status: 'running' });
    const second = makePart({ taskId: 'dup', taskType: 'agent', status: 'complete' });

    const messages: ChatMessage[] = [
      { id: 'msg-1', role: 'assistant', content: '', parts: [first], timestamp: '' },
      { id: 'msg-2', role: 'assistant', content: '', parts: [second], timestamp: '' },
    ];

    const { result } = renderHook(() => useBackgroundTasks(messages));

    // 'complete' without prior running render => no celebration, so excluded
    expect(result.current).toHaveLength(0);
  });

  // === Bash tasks below threshold ===

  it('filters bash tasks below 5s threshold', () => {
    const part = makePart({
      taskType: 'bash',
      status: 'running',
      startedAt: Date.now() - 2000, // only 2s old
      command: 'npm install',
    });
    const { result } = renderHook(() => useBackgroundTasks(wrapMessages([part])));

    expect(result.current).toHaveLength(0);
  });

  it('shows bash tasks after crossing 5s threshold', () => {
    const startedAt = Date.now() - 3000; // 3s old — below threshold
    const part = makePart({
      taskType: 'bash',
      status: 'running',
      startedAt,
      command: 'npm install',
    });

    const { result, rerender } = renderHook(
      ({ msgs }: { msgs: ChatMessage[] }) => useBackgroundTasks(msgs),
      { initialProps: { msgs: wrapMessages([part]) } }
    );

    // Initially hidden (only 3s elapsed)
    expect(result.current).toHaveLength(0);

    // Advance time past the 5s threshold — the interval triggers setRenderTick,
    // and we rerender with a new messages reference so useMemo recomputes.
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // Provide a new messages array reference so taskMap useMemo recomputes with
    // the updated Date.now() (now 6s elapsed > 5s threshold).
    rerender({ msgs: wrapMessages([part]) });

    expect(result.current).toHaveLength(1);
    expect(result.current[0].taskType).toBe('bash');
    expect(result.current[0].command).toBe('npm install');
  });

  it('shows bash tasks that started more than 5s ago immediately', () => {
    const part = makePart({
      taskType: 'bash',
      status: 'running',
      startedAt: Date.now() - 10_000, // 10s old
      command: 'make build',
    });
    const { result } = renderHook(() => useBackgroundTasks(wrapMessages([part])));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].command).toBe('make build');
  });

  // === Mixed agent + bash tasks ===

  it('shows agent tasks and long-running bash tasks together', () => {
    const agentPart = makePart({
      taskType: 'agent',
      status: 'running',
      description: 'Refactoring module',
    });
    const bashPart = makePart({
      taskType: 'bash',
      status: 'running',
      startedAt: Date.now() - 10_000,
      command: 'docker build .',
    });

    const { result } = renderHook(() => useBackgroundTasks(wrapMessages([agentPart, bashPart])));

    expect(result.current).toHaveLength(2);

    const types = result.current.map((t) => t.taskType).sort();
    expect(types).toEqual(['agent', 'bash']);
  });

  it('shows agent task but hides short bash task in mixed scenario', () => {
    const agentPart = makePart({
      taskType: 'agent',
      status: 'running',
      description: 'Agent work',
    });
    const bashPart = makePart({
      taskType: 'bash',
      status: 'running',
      startedAt: Date.now() - 1000, // only 1s old
      command: 'echo hello',
    });

    const { result } = renderHook(() => useBackgroundTasks(wrapMessages([agentPart, bashPart])));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].taskType).toBe('agent');
  });

  // === Color assignment ===

  it('assigns colors from the shared pool', () => {
    const parts = Array.from({ length: 3 }, (_, i) =>
      makePart({ taskId: `c-${i}`, taskType: 'agent', status: 'running' })
    );
    const { result } = renderHook(() => useBackgroundTasks(wrapMessages(parts)));

    expect(result.current).toHaveLength(3);
    expect(result.current[0].color).toBe(TASK_COLORS[0]);
    expect(result.current[1].color).toBe(TASK_COLORS[1]);
    expect(result.current[2].color).toBe(TASK_COLORS[2]);
  });

  it('shares color pool across agent and bash tasks', () => {
    const agentPart = makePart({
      taskId: 'mix-agent',
      taskType: 'agent',
      status: 'running',
    });
    const bashPart = makePart({
      taskId: 'mix-bash',
      taskType: 'bash',
      status: 'running',
      startedAt: Date.now() - 10_000,
    });

    const { result } = renderHook(() => useBackgroundTasks(wrapMessages([agentPart, bashPart])));

    expect(result.current).toHaveLength(2);

    const agentTask = result.current.find((t) => t.taskId === 'mix-agent')!;
    const bashTask = result.current.find((t) => t.taskId === 'mix-bash')!;

    // Both should have colors from the pool, and they should differ
    expect(TASK_COLORS).toContain(agentTask.color);
    expect(TASK_COLORS).toContain(bashTask.color);
    expect(agentTask.color).not.toBe(bashTask.color);
  });

  it('wraps around color pool when tasks exceed pool size', () => {
    const parts = Array.from({ length: 6 }, (_, i) =>
      makePart({ taskId: `w-${i}`, taskType: 'agent', status: 'running' })
    );
    const { result } = renderHook(() => useBackgroundTasks(wrapMessages(parts)));

    expect(result.current).toHaveLength(6);
    // 6th task should wrap to the first color
    expect(result.current[5].color).toBe(TASK_COLORS[0]);
  });

  it('maintains stable color across re-renders', () => {
    const part = makePart({ taskId: 'stable', taskType: 'agent', status: 'running' });
    const messages = wrapMessages([part]);

    const { result, rerender } = renderHook(() => useBackgroundTasks(messages));
    const firstColor = result.current[0].color;

    rerender();

    expect(result.current[0].color).toBe(firstColor);
  });

  // === Celebration window ===

  it('keeps a task visible during celebration window after completion', () => {
    const part = makePart({ taskId: 'cel', taskType: 'agent', status: 'running' });

    const { result, rerender } = renderHook(
      ({ msgs }: { msgs: ChatMessage[] }) => useBackgroundTasks(msgs),
      { initialProps: { msgs: wrapMessages([part]) } }
    );

    expect(result.current).toHaveLength(1);

    // Transition to complete — the effect sets celebratingRef after this render
    const completedPart = { ...part, status: 'complete' as const };
    rerender({ msgs: wrapMessages([completedPart]) });

    // celebratingRef was set in the effect (post-render). A second rerender
    // allows useMemo to see the updated ref and include the celebrating task.
    rerender({ msgs: wrapMessages([completedPart]) });

    // Still visible during celebration
    expect(result.current).toHaveLength(1);
    expect(result.current[0].status).toBe('complete');

    // After celebration window expires (1500ms), the setTimeout removes the
    // taskId from celebratingRef and triggers setRenderTick.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // Fresh reference so useMemo recomputes
    rerender({ msgs: wrapMessages([completedPart]) });

    expect(result.current).toHaveLength(0);
  });
});
