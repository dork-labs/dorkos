/**
 * A chat message runs at its receiving agent's own level (DOR-3440). Only a teammate's chain in a
 * shared space rides on it, as a record for the space's limit that lowers nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Which sending chats hold a Wi-Fi mark, as `marksOf` reads them.
const heldChats = vi.hoisted(() => new Set<string>());
vi.mock('../../../core/turn-power/turn-levels.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../core/turn-power/turn-levels.js')>();
  return {
    ...real,
    marksOf: (sessionId: string | null | undefined, agentPath: string | undefined) =>
      sessionId && heldChats.has(sessionId)
        ? { outsider: true }
        : real.marksOf(sessionId, agentPath),
  };
});

import {
  CHAT_MESSAGE_ORIGIN,
  parseCarriedHold,
  parseCeiling,
  senderCeilingJson,
} from '../chat-message-ceiling.js';
import { permissionSeedForOrigin } from '../../origin/turn-origin.js';
import { ceilingOnlyRecords, marksOfCeiling } from '../../../core/turn-power/turn-marks.js';

const LEVEL = { asks: 'never', reach: 'everything' } as const;
const CHAIN = { ...LEVEL, teammate: [{ roomId: 'r', authorId: 'a' }] };
const CALLER = { sessionId: 'sender', agentPath: '/agents/ana' };

describe('a chat a message opens', () => {
  it('seeds the same stop, whoever the sending turn answered', () => {
    expect(permissionSeedForOrigin(CHAT_MESSAGE_ORIGIN)).toBe('configured-stop-on-insert');
  });
});

describe('the bound a message row stores', () => {
  it('is nothing from a plain turn or an unknown one, and a held turn’s hold stays behind', () => {
    for (const level of [LEVEL, undefined]) {
      const json = senderCeilingJson({ turnLevelOf: () => level }, CALLER);
      expect(parseCeiling(json)).toBeUndefined();
    }
  });

  it('carries a teammate’s chain for the space’s limit, and reads back lowering nothing', () => {
    const json = senderCeilingJson({ turnLevelOf: () => CHAIN }, CALLER);
    const ceiling = parseCeiling(json);
    expect(ceiling).toBeDefined();
    expect(marksOfCeiling(ceiling!)).toEqual({ teammate: CHAIN.teammate });
    expect(ceilingOnlyRecords(ceiling!)).toBe(true);
  });

  it('reads a chain an earlier build stored under the runtime default as lowering nothing', () => {
    const ceiling = parseCeiling(JSON.stringify(['runtime-default', CHAIN]));
    expect(ceiling).toBeDefined();
    expect(ceilingOnlyRecords(ceiling!)).toBe(true);
  });

  it('reads a bound from an older build as nothing', () => {
    expect(parseCeiling(JSON.stringify(LEVEL))).toBeUndefined();
    expect(parseCeiling(JSON.stringify([LEVEL, 'runtime-default']))).toBeUndefined();
    expect(parseCeiling('{"bound":"carried","marks":{"outsider":true}}')).toBeUndefined();
    expect(parseCeiling('not json')).toBeUndefined();
  });
});

describe('the Wi-Fi hold a message row carries on (DOR-3561)', () => {
  afterEach(() => heldChats.clear());

  it('stores a held sender’s hold as a mark, which caps nothing', () => {
    heldChats.add(CALLER.sessionId);
    const json = senderCeilingJson({ turnLevelOf: () => LEVEL }, CALLER);
    expect(parseCarriedHold(json)).toBe(true);
    expect(parseCeiling(json)).toBeUndefined();
  });

  it('keeps a teammate’s chain beside the hold', () => {
    heldChats.add(CALLER.sessionId);
    const json = senderCeilingJson({ turnLevelOf: () => CHAIN }, CALLER);
    expect(parseCarriedHold(json)).toBe(true);
    expect(marksOfCeiling(parseCeiling(json)!)).toEqual({ teammate: CHAIN.teammate });
  });

  it('stores none for a clean sender, and reads none from an older row', () => {
    expect(parseCarriedHold(senderCeilingJson({ turnLevelOf: () => LEVEL }, CALLER))).toBe(false);
    expect(parseCarriedHold(JSON.stringify('runtime-default'))).toBe(false);
    expect(parseCarriedHold(JSON.stringify(['runtime-default', CHAIN]))).toBe(false);
    expect(parseCarriedHold('not json')).toBe(false);
  });
});
