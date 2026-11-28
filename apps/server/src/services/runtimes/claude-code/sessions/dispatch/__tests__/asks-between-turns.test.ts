/**
 * Asks raised while no turn is open on a warm process (DOR-2698): the
 * between-turns notifier, and what a new turn's queue keeps.
 */
import { describe, it, expect, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { LOAD_WAIT_STATUS } from '@dorkos/shared/schemas';
import type { PendingInteraction } from '../../../messaging/interaction-wait.js';
import { SessionStore } from '../../session-store.js';
import { openTurnsForAsks } from '../asks-between-turns.js';
import { resetPerTurnState } from '../per-turn-state.js';

/** A real session record, as the store makes one. */
function session() {
  const store = new SessionStore();
  store.ensureSession('sess-asks', { permissionMode: 'default' });
  return store.findSession('sess-asks')!;
}

const approval = (id: string): StreamEvent =>
  ({
    type: 'approval_required',
    data: { toolCallId: id, toolName: 'Bash', input: '{}' },
  }) as StreamEvent;

describe('a new turn keeps the asks no turn has shown yet', () => {
  it('keeps an unshown ask still waiting on a person, and drops the rest', () => {
    const s = session();
    s.pendingInteractions.set('toolu_waiting', {} as PendingInteraction);
    s.eventQueue = [
      approval('toolu_waiting'),
      approval('toolu_already_answered'),
      { type: 'system_status', data: { message: 'from the turn before' } } as StreamEvent,
    ];
    resetPerTurnState(s);
    expect(s.eventQueue).toEqual([approval('toolu_waiting')]);
  });
});

describe('the between-turns notifier', () => {
  it("uses a turn's own notifier while it is set, and opens a window for an ask when none is", () => {
    const s = session();
    const open = vi.fn(() => true);
    openTurnsForAsks(s, open);

    const streaming = vi.fn();
    s.eventQueueNotify = streaming;
    s.eventQueue.push(approval('toolu_1'));
    s.eventQueueNotify?.();
    expect(streaming).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();

    // The turn's stream ends and clears its notifier, as `pump-turn-stream.ts` does.
    if (s.eventQueueNotify === streaming) s.eventQueueNotify = undefined;
    s.eventQueue = [{ type: 'system_status', data: { message: 'just a status' } } as StreamEvent];
    s.eventQueueNotify?.();
    expect(open).not.toHaveBeenCalled();

    s.eventQueue.push({
      type: 'system_status',
      data: { message: 'waiting for a slot', status: LOAD_WAIT_STATUS },
    } as StreamEvent);
    s.eventQueueNotify?.();
    expect(open).toHaveBeenCalledTimes(1);

    // New wiring for the same session swaps the opener, and does not stack.
    const reopened = vi.fn(() => true);
    openTurnsForAsks(s, reopened);
    s.eventQueueNotify?.();
    expect(open).toHaveBeenCalledTimes(1);
    expect(reopened).toHaveBeenCalledTimes(1);
  });
});
