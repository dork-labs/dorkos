/**
 * A message sent from Wi-Fi counts as an outsider's once its turn starts
 * (DOR-3037), so everything that asks `turnStartedByOutsider` (a connected
 * app's cancel window, the outsider output limit, failure notices) treats the
 * turn as one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  messageTurnStarted,
  noteHeldMessage,
  noteTurnOrigin,
  holdTurnOriginFor,
  resetOutsiderTurns,
  turnStartedByOutsider,
} from '../outsider-turns.js';

afterEach(() => resetOutsiderTurns());

describe('a held message', () => {
  it('makes its turn an outsider’s, though a person sent it', () => {
    holdTurnOriginFor('m-1', () => noteTurnOrigin('chat-1', { kind: 'interactive' }));
    noteHeldMessage('m-1');
    messageTurnStarted('chat-1', 'm-1');
    expect(turnStartedByOutsider('chat-1')).toBe(true);
  });

  it('leaves a person’s message from this computer as theirs', () => {
    holdTurnOriginFor('m-2', () => noteTurnOrigin('chat-2', { kind: 'interactive' }));
    messageTurnStarted('chat-2', 'm-2');
    expect(turnStartedByOutsider('chat-2')).toBe(false);
  });
});
