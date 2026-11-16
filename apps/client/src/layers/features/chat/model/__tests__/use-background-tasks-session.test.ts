/**
 * @vitest-environment jsdom
 *
 * The strip reads the session-level running set (spec `warm-process-lifecycle`
 * D8, T30): a helper keeps its row through `turn_end` and the history reload
 * after it, and a Monitor shows as an `other` task.
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { BackgroundTaskPart } from '@dorkos/shared/types';
import { useBackgroundTasks, type SessionRunningTasks } from '../use-background-tasks';
import type { ChatMessage } from '../chat-types';

function withParts(parts: BackgroundTaskPart[]): ChatMessage[] {
  return [{ id: 'm1', role: 'assistant', content: '', parts, timestamp: '2026-11-15T00:00:00Z' }];
}

const helper: BackgroundTaskPart = {
  type: 'background_task',
  taskId: 'helper',
  taskType: 'agent',
  status: 'running',
  startedAt: 1,
  description: 'Review the branch',
  toolUses: 3,
};

describe('useBackgroundTasks with the session running set', () => {
  it('keeps a helper after the reload drops its part, from the session set', () => {
    const session: SessionRunningTasks = {
      tasks: [{ taskId: 'helper', taskType: 'agent', description: 'Review the branch' }],
      ambientIds: [],
    };
    const { result, rerender } = renderHook(
      ({ messages }) => useBackgroundTasks(messages, session),
      { initialProps: { messages: withParts([helper]) } }
    );
    expect(result.current.map((t) => t.taskId)).toEqual(['helper']);
    const color = result.current[0]!.color;

    // The turn-end reload replaces the messages; the part is gone.
    rerender({ messages: withParts([]) });

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      taskId: 'helper',
      taskType: 'agent',
      status: 'running',
      description: 'Review the branch',
      color,
    });
  });

  it('shows a Monitor the session runs as an other task with its label', () => {
    const session: SessionRunningTasks = {
      tasks: [{ taskId: 'mon', taskType: 'other', description: 'Watch the deploy' }],
      ambientIds: [],
    };
    const { result } = renderHook(() => useBackgroundTasks([], session));

    expect(result.current).toEqual([
      expect.objectContaining({
        taskId: 'mon',
        taskType: 'other',
        description: 'Watch the deploy',
      }),
    ]);
  });

  it('draws a task whose kind never reached this client as other', () => {
    const { result } = renderHook(() =>
      useBackgroundTasks([], { tasks: [{ taskId: 'from-before' }], ambientIds: [] })
    );
    expect(result.current[0]).toMatchObject({ taskId: 'from-before', taskType: 'other' });
  });

  it('drops a part still saying running for work the session no longer runs', () => {
    const { result } = renderHook(() =>
      useBackgroundTasks(withParts([helper]), { tasks: [], ambientIds: [] })
    );
    expect(result.current).toEqual([]);
  });

  it('keeps a housekeeping part the session still runs', () => {
    const chore: BackgroundTaskPart = { ...helper, taskId: 'chore', ambient: true };
    const { result } = renderHook(() =>
      useBackgroundTasks(withParts([chore]), { tasks: [], ambientIds: ['chore'] })
    );
    expect(result.current).toEqual([expect.objectContaining({ taskId: 'chore', ambient: true })]);
  });

  it("labels a shell's part with the command the session list carries", () => {
    const shell: BackgroundTaskPart = { ...helper, taskId: 'sh', taskType: 'bash' };
    const { result } = renderHook(() =>
      useBackgroundTasks(withParts([shell]), {
        tasks: [{ taskId: 'sh', taskType: 'bash', command: 'pnpm test' }],
        ambientIds: [],
      })
    );
    expect(result.current[0]).toMatchObject({ taskId: 'sh', command: 'pnpm test' });
  });

  it('takes the kind and start from the list when the turn never saw the start', () => {
    // A part folded from a terminal-only update guesses a helper with no clock.
    const guessed: BackgroundTaskPart = {
      ...helper,
      taskId: 'mon',
      taskType: 'agent',
      startedAt: 0,
    };
    const { result } = renderHook(() =>
      useBackgroundTasks(withParts([guessed]), {
        tasks: [{ taskId: 'mon', taskType: 'other', startedAt: 42 }],
        ambientIds: [],
      })
    );
    expect(result.current[0]).toMatchObject({ taskType: 'other', startedAt: 42 });
  });

  it('leaves the parts in charge when the server sent no list', () => {
    const { result } = renderHook(() =>
      useBackgroundTasks(withParts([helper]), { tasks: undefined, ambientIds: [] })
    );
    expect(result.current.map((t) => t.taskId)).toEqual(['helper']);
  });
});
