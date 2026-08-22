/**
 * The undo window on a rejected schedule.
 *
 * Rejecting a schedule DELETES it, and a delete has no server-side undo — so
 * the whole design is that the request is simply not sent yet. Both halves of
 * that have to be true, and they fail in opposite directions: a window that
 * never closes silently drops decisions people made, and an undo that does not
 * cancel destroys a schedule somebody just took back.
 *
 * Timers are fake from the first line, because the thing under test IS the
 * clock.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  REJECTION_UNDO_MS,
  cancelRejection,
  discardPendingRejections,
  flushRejections,
  isRejectionPending,
  rejectAfterUndoWindow,
  subscribeToRejections,
} from '../model/deferred-rejection';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  discardPendingRejections();
  vi.useRealTimers();
});

describe('the rejection undo window', () => {
  it('sends nothing at all until the window closes', () => {
    const commit = vi.fn();
    rejectAfterUndoWindow('task-1', commit);

    // One millisecond short. Seeded defect: call `commit()` synchronously in
    // `rejectAfterUndoWindow` instead of inside the timer and this reds — which
    // is exactly the "Undo over an already-sent DELETE" bug the window exists
    // to make impossible.
    vi.advanceTimersByTime(REJECTION_UNDO_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    expect(isRejectionPending('task-1')).toBe(true);
  });

  it('sends it the moment the window closes', () => {
    const commit = vi.fn();
    rejectAfterUndoWindow('task-1', commit);

    vi.advanceTimersByTime(REJECTION_UNDO_MS);

    // The other direction, and the one that loses work rather than data:
    // drop the `commit()` call inside the timer and a person's rejection is
    // silently forgotten, with the proposal reappearing on the next refetch.
    expect(commit).toHaveBeenCalledTimes(1);
    expect(isRejectionPending('task-1')).toBe(false);
  });

  it('cancels a rejection that is taken back, now and forever', () => {
    const commit = vi.fn();
    rejectAfterUndoWindow('task-1', commit);

    expect(cancelRejection('task-1')).toBe(true);
    expect(isRejectionPending('task-1')).toBe(false);

    // Long past the window: the timer is really gone, not merely ignored.
    // Seeded defect: make `cancelRejection` drop the map entry without calling
    // `clearTimeout` and this reds here rather than at the line above.
    vi.advanceTimersByTime(REJECTION_UNDO_MS * 5);
    expect(commit).not.toHaveBeenCalled();
  });

  it('reports nothing to cancel once the window has already closed', () => {
    // The honest answer to "can I still take it back?" after the DELETE is on
    // its way. A `true` here would let a card draw a live Undo over a request
    // that has already gone.
    rejectAfterUndoWindow('task-1', vi.fn());
    vi.advanceTimersByTime(REJECTION_UNDO_MS);

    expect(cancelRejection('task-1')).toBe(false);
  });

  it('keeps two rejections apart', () => {
    const first = vi.fn();
    const second = vi.fn();
    rejectAfterUndoWindow('task-1', first);
    rejectAfterUndoWindow('task-2', second);

    cancelRejection('task-1');
    vi.advanceTimersByTime(REJECTION_UNDO_MS);

    // Undoing one schedule must not spare — or doom — the other. A scheduler
    // holding a single timer instead of a map would fail one of these two.
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('restarts the window when the same schedule is rejected twice', () => {
    const first = vi.fn();
    const second = vi.fn();
    rejectAfterUndoWindow('task-1', first);
    vi.advanceTimersByTime(REJECTION_UNDO_MS - 1);
    rejectAfterUndoWindow('task-1', second);

    // Deciding one card twice is one decision, not two deletes: the first
    // timer must be cleared, or the DELETE fires a millisecond later off a
    // window the reader thinks they just restarted.
    vi.advanceTimersByTime(REJECTION_UNDO_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('sends every pending rejection when the page goes away', () => {
    // Somebody who rejected a schedule and closed the tab made a decision.
    // Discarding it would leave the proposal in their Inbox next time.
    const commit = vi.fn();
    rejectAfterUndoWindow('task-1', commit);

    window.dispatchEvent(new Event('pagehide'));

    expect(commit).toHaveBeenCalledTimes(1);
    expect(isRejectionPending('task-1')).toBe(false);
  });

  it('binds the unload flush only while something is waiting on it', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    rejectAfterUndoWindow('task-1', vi.fn());
    expect(add).toHaveBeenCalledWith('pagehide', flushRejections);

    cancelRejection('task-1');
    // An idle cockpit carries no global handler. Seeded defect: bind at module
    // load instead and the removal never happens, so this reds.
    expect(remove).toHaveBeenCalledWith('pagehide', flushRejections);

    add.mockRestore();
    remove.mockRestore();
  });

  it('tells its subscribers every time the pending set moves', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToRejections(listener);

    rejectAfterUndoWindow('task-1', vi.fn());
    expect(listener).toHaveBeenCalledTimes(1);

    cancelRejection('task-1');
    expect(listener).toHaveBeenCalledTimes(2);

    // This is what a remounted card reads to come back showing its receipt, so
    // a missed notification is a card that draws the wrong state.
    unsubscribe();
    rejectAfterUndoWindow('task-2', vi.fn());
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
