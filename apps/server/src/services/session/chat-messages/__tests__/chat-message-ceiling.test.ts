/**
 * A chat opened by a message from a marked turn inherits nothing of its agent's
 * own level (DOR-3107, Security).
 */
import { describe, expect, it } from 'vitest';
import { chatMessageOrigin, isMarkedBound, parseCeiling } from '../chat-message-ceiling.js';
import { permissionSeedForOrigin } from '../../origin/turn-origin.js';

const LEVEL = { asks: 'never', reach: 'everything' } as const;

describe('a chat a message opens', () => {
  it('follows the agent’s own level when the sending turn was not marked', () => {
    const origin = chatMessageOrigin(JSON.stringify(LEVEL));
    expect(origin).toEqual({ kind: 'chat-message' });
    expect(permissionSeedForOrigin(origin)).toBe('configured-stop-on-insert');
  });

  it('inherits nothing when the sending turn read a stranger’s words', () => {
    const origin = chatMessageOrigin(JSON.stringify({ ...LEVEL, outsider: true }));
    expect(origin).toEqual({ kind: 'chat-message', marked: true });
    expect(permissionSeedForOrigin(origin)).toBe('none');
  });

  it('inherits nothing when the sender’s level is not known', () => {
    expect(permissionSeedForOrigin(chatMessageOrigin(JSON.stringify('runtime-default')))).toBe(
      'none'
    );
    expect(permissionSeedForOrigin(chatMessageOrigin('not json'))).toBe('none');
  });

  it('reads a stored bound back', () => {
    expect(parseCeiling(JSON.stringify(LEVEL))).toEqual(LEVEL);
    expect(isMarkedBound(parseCeiling('{}'))).toBe(true);
    // Any mark counts, a teammate's chain too (DOR-3107), and a list holds if any bound is marked.
    expect(
      isMarkedBound(
        parseCeiling(JSON.stringify({ ...LEVEL, teammate: [{ roomId: 'r', authorId: 'a' }] }))
      )
    ).toBe(true);
    expect(isMarkedBound(parseCeiling(JSON.stringify([LEVEL, 'runtime-default'])))).toBe(true);
    expect(isMarkedBound(parseCeiling(JSON.stringify(LEVEL)))).toBe(false);
  });
});
