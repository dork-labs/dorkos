/**
 * What a refused limit change says back.
 *
 * The mapping is tested on its own because the thing it exists to prevent is a
 * property of the mapping: the owner-only refusal arrives written in the OWNER's
 * voice ("Only you can change…") and must not be shown, verbatim, to the person
 * it just refused — who is by definition not that "you".
 */
import { describe, it, expect } from 'vitest';
import { roomLimitsErrorMessage } from '../lib/room-limit-errors';

/** An error shaped the way the HTTP transport throws one. */
function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, status: 403 });
}

describe('roomLimitsErrorMessage', () => {
  it('replaces the owner-only refusal with a sentence naming who can', () => {
    const said = roomLimitsErrorMessage(
      coded('OPERATOR_ONLY', 'Only you can change how much a room may spend on automatic replies')
    );

    expect(said).toBe('Only the person who owns this DorkOS can change a room’s limits.');
    expect(said).not.toMatch(/Only you/);
  });

  it('says what to do about an archived room', () => {
    expect(roomLimitsErrorMessage(coded('ROOM_ARCHIVED', 'Room is archived'))).toBe(
      'This room is archived, so its limits are on hold. Bring it back first.'
    );
  });

  it('passes any other refusal through in the server’s own words', () => {
    expect(roomLimitsErrorMessage(coded('BAD_REQUEST', 'maxAgentDepth must be at most 100'))).toBe(
      'maxAgentDepth must be at most 100'
    );
  });

  it('still says something when the failure carried no sentence at all', () => {
    expect(roomLimitsErrorMessage(new Error('   '))).toBe(
      'That limit could not be saved. Try again.'
    );
    expect(roomLimitsErrorMessage(undefined)).toBe('That limit could not be saved. Try again.');
  });
});
