/**
 * A chat message runs at its receiving agent's own level (DOR-3440). Only a teammate's chain in a
 * shared space rides on it, and a chat such a message opens inherits nothing (DOR-3107).
 */
import { describe, expect, it } from 'vitest';
import { chatMessageOrigin, parseCeiling, senderCeilingJson } from '../chat-message-ceiling.js';
import { permissionSeedForOrigin } from '../../origin/turn-origin.js';

const LEVEL = { asks: 'never', reach: 'everything' } as const;
const CHAIN = { ...LEVEL, teammate: [{ roomId: 'r', authorId: 'a' }] };
const CALLER = { sessionId: 'sender', agentPath: '/agents/ana' };

describe('a chat a message opens', () => {
  it('follows the agent’s own level, whatever older row it reads', () => {
    for (const stored of [
      JSON.stringify(LEVEL),
      JSON.stringify({ ...LEVEL, outsider: true }),
      JSON.stringify('runtime-default'),
      JSON.stringify('none'),
      'not json',
    ]) {
      const origin = chatMessageOrigin(stored);
      expect(origin, stored).toEqual({ kind: 'chat-message' });
      expect(permissionSeedForOrigin(origin), stored).toBe('configured-stop-on-insert');
    }
  });

  it('inherits nothing when a teammate’s chain reached the sending turn', () => {
    const origin = chatMessageOrigin(JSON.stringify(['runtime-default', CHAIN]));
    expect(origin).toEqual({ kind: 'chat-message', marked: true });
    expect(permissionSeedForOrigin(origin)).toBe('none');
  });
});

describe('the bound a message row stores', () => {
  it('is nothing from a plain turn or an unknown one, and a held turn’s hold stays behind', () => {
    for (const level of [LEVEL, undefined]) {
      const json = senderCeilingJson({ turnLevelOf: () => level }, CALLER);
      expect(parseCeiling(json)).toBeUndefined();
    }
  });

  it('carries a teammate’s chain, read back as the runtime default and the chain', () => {
    const json = senderCeilingJson({ turnLevelOf: () => CHAIN }, CALLER);
    expect(parseCeiling(json)).toEqual([
      'runtime-default',
      expect.objectContaining({ teammate: CHAIN.teammate }),
    ]);
  });

  it('reads a bound from an older build as nothing', () => {
    expect(parseCeiling(JSON.stringify(LEVEL))).toBeUndefined();
    expect(parseCeiling(JSON.stringify([LEVEL, 'runtime-default']))).toBeUndefined();
    expect(parseCeiling('{"bound":"carried","marks":{"outsider":true}}')).toBeUndefined();
    expect(parseCeiling('not json')).toBeUndefined();
  });
});
