/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { useTodoEvents } from '../use-todo-events';

const SID = 'sess-1';

function todoUpdate(seq: number, subject: string): SessionEvent {
  return {
    seq,
    type: 'todo_update',
    action: 'snapshot',
    task: { id: '1', subject, status: 'pending' },
    tasks: [{ id: '1', subject, status: 'pending' }],
  };
}

describe('useTodoEvents', () => {
  it('forwards a live todo_update above the snapshot cursor exactly once', () => {
    // Real failure mode (CLI-B4): live todo_update events land in the stream
    // store's inProgressTurn where the bubble projection skips them — without
    // this forwarding the TaskListPanel never updates during a turn.
    const onTaskEvent = vi.fn();
    const { rerender } = renderHook(
      ({ turn }: { turn: SessionEvent[] }) => useTodoEvents(SID, turn, 5, onTaskEvent),
      { initialProps: { turn: [] as SessionEvent[] } }
    );

    const turn: SessionEvent[] = [{ seq: 6, type: 'turn_start' }, todoUpdate(7, 'do it')];
    rerender({ turn });
    expect(onTaskEvent).toHaveBeenCalledTimes(1);
    expect(onTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'snapshot', task: expect.objectContaining({ id: '1' }) })
    );

    // Re-rendering with the same events must not re-fire (watermark advanced).
    rerender({ turn });
    expect(onTaskEvent).toHaveBeenCalledTimes(1);

    // A later event fires once more.
    rerender({ turn: [...turn, todoUpdate(8, 'do it again')] });
    expect(onTaskEvent).toHaveBeenCalledTimes(2);
  });

  it('suppresses snapshot-hydrated events (seq at or below the cursor)', () => {
    // Real failure mode: a mid-turn reconnect replays the turn's todo_updates in
    // the snapshot — re-firing them would pop celebrations for long-finished
    // tasks on every reconnect. The ['tasks'] query covers hydration.
    const onTaskEvent = vi.fn();
    renderHook(() =>
      useTodoEvents(
        SID,
        [{ seq: 3, type: 'turn_start' }, todoUpdate(4, 'replayed')],
        5,
        onTaskEvent
      )
    );
    expect(onTaskEvent).not.toHaveBeenCalled();
  });

  it('re-anchors the watermark when a new snapshot arrives (seq-space reset)', () => {
    // Real failure mode: a server restart resets the seq space; a stale high
    // watermark would suppress every event of the new epoch forever.
    const onTaskEvent = vi.fn();
    const { rerender } = renderHook(
      ({ turn, cursor }: { turn: SessionEvent[]; cursor: number | null }) =>
        useTodoEvents(SID, turn, cursor, onTaskEvent),
      { initialProps: { turn: [todoUpdate(100, 'old epoch')] as SessionEvent[], cursor: 99 } }
    );
    expect(onTaskEvent).toHaveBeenCalledTimes(1); // 100 > cursor 99 → live

    // New epoch: fresh snapshot with cursor 2, then a live event at seq 3.
    rerender({ turn: [todoUpdate(3, 'new epoch')], cursor: 2 });
    expect(onTaskEvent).toHaveBeenCalledTimes(2);
    expect(onTaskEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ task: expect.objectContaining({ subject: 'new epoch' }) })
    );
  });

  it('does nothing without a session id', () => {
    const onTaskEvent = vi.fn();
    renderHook(() => useTodoEvents(null, [todoUpdate(1, 'x')], 0, onTaskEvent));
    expect(onTaskEvent).not.toHaveBeenCalled();
  });
});
