/**
 * The line a Stop leaves (DOR-3285) usually lands after its turn's history
 * reload, so a person's next turn carries it until history has it.
 */
import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { keptWorkLeft, retainOpenSigninCards } from '../live-turn-retention';
import { useSessionStreamStore } from '../session-stream-store';

const LEFT = {
  type: 'work_left_running',
  seq: 5,
  tasks: [{ taskId: 'tail', command: 'tail -f server.log' }],
} as SessionEvent;
const ENDED = {
  type: 'work_left_ended',
  seq: 6,
  taskId: 'tail',
  status: 'completed',
} as SessionEvent;

describe('the line a Stop leaves, across turns', () => {
  it('keeps only the work_left events of an outgoing turn', () => {
    const outgoing = [
      { type: 'turn_start', seq: 1 } as SessionEvent,
      { type: 'text_delta', seq: 2, text: 'hi' } as SessionEvent,
      LEFT,
      ENDED,
    ];
    expect(keptWorkLeft(outgoing)).toEqual([LEFT, ENDED]);
  });

  it('lets them go at a history reload, which has the line by then', () => {
    expect(retainOpenSigninCards([LEFT, ENDED])).toEqual([]);
  });

  it('carries the line into the next turn a person starts', () => {
    const id = 'session-carry';
    const store = useSessionStreamStore.getState();
    store.applyEvent(id, { type: 'turn_start', seq: 1, userMessage: 'deploy' } as SessionEvent);
    store.applyEvent(id, { type: 'turn_end', seq: 2 } as SessionEvent);
    store.applyEvent(id, { ...LEFT, seq: 3 } as SessionEvent);
    store.applyEvent(id, { type: 'turn_start', seq: 4, userMessage: 'what now' } as SessionEvent);

    const turn = useSessionStreamStore.getState().sessions[id]!.inProgressTurn;
    expect(turn.map((event) => event.type)).toEqual(['work_left_running', 'turn_start']);
    useSessionStreamStore.setState((state) => ({ ...state, sessions: {} }));
  });
});
