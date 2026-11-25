/**
 * What a relay turn is sent with because of its sender, and the limits a message carries from its
 * sender's own turns (DOR-5151): they add to the sender's bounds and never lift one, and anything
 * there that can't be read holds the turn at the runtime's default and marks it.
 */
import { describe, expect, it, vi } from 'vitest';
import { UNPROVEN_TEAMMATE_ORIGIN } from '@dorkos/shared/permission-semantics';
import { HTTP_RELAY_SENDER, turnPowerOptions } from '../turn-shaping-sender.js';
import { CARRIED_TURN_LIMITS_FIELD, sealTurnLimits } from '../../../lib/carried-turn-limits.js';
import { extractPayloadContent } from '../../../lib/payload-utils.js';

const TEAMMATE = {
  asks: 'never',
  reach: 'everything',
  teammate: [{ roomId: 'r1', authorId: 'a1' }],
};
const SENDER = 'relay.agent.default.porter';

describe('turnPowerOptions', () => {
  it('holds a sender that may not shape the turn at the runtime default, and nothing else', () => {
    expect(turnPowerOptions(false, false)).toEqual({ permissionCeiling: 'runtime-default' });
    expect(turnPowerOptions(true, false)).toEqual({});
    const unproven = { __untrustedWords: true };
    expect(turnPowerOptions(true, true, unproven)).toEqual({ carriedMarks: { outsider: true } });
    expect(turnPowerOptions(true, false, unproven)).toEqual({});
    // Only a shaping sender's word on itself counts; anyone else is already held.
    expect(turnPowerOptions(false, true, unproven)).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  it('adds what the sender’s own turns carry to its bound', () => {
    const payload = {
      content: 'hi',
      [CARRIED_TURN_LIMITS_FIELD]: sealTurnLimits(SENDER, {
        permissionCeiling: TEAMMATE,
        carriedMarks: { outsider: true },
      }),
    };
    expect(turnPowerOptions(false, false, payload, SENDER)).toEqual({
      permissionCeiling: ['runtime-default', TEAMMATE],
      carriedMarks: { outsider: true },
    });
  });

  describe('a teammate’s chain, which counts the turn against a space’s monthly limit', () => {
    /** The chain as unproven: still a teammate's, held to and counted against every space. */
    const marked = { ...TEAMMATE, teammate: [UNPROVEN_TEAMMATE_ORIGIN] };

    it.each([
      ['written by the caller', { permissionCeiling: TEAMMATE }, SENDER],
      [
        'sealed for another sender',
        sealTurnLimits('relay.external.http', { permissionCeiling: TEAMMATE }),
        SENDER,
      ],
      [
        'changed after it was sealed',
        {
          ...sealTurnLimits(SENDER, { permissionCeiling: { ...TEAMMATE, teammate: [] } }),
          permissionCeiling: TEAMMATE,
        },
        SENDER,
      ],
      ['read with no sender', sealTurnLimits(SENDER, { permissionCeiling: TEAMMATE }), undefined],
    ])(
      'names no room of its own when %s, and still reads as a teammate’s and holds its bound',
      (_name, carried, from) => {
        const payload = { [CARRIED_TURN_LIMITS_FIELD]: carried };
        expect(turnPowerOptions(false, false, payload, from)).toEqual({
          permissionCeiling: ['runtime-default', marked],
        });
      }
    );

    it('names no room of its own for a stamp sealed before a restart, and still reads as a teammate’s', async () => {
      // A fresh copy of the module has a fresh key, as the server has after it restarts.
      vi.resetModules();
      const before = await import('../../../lib/carried-turn-limits.js');
      const stamp = before.sealTurnLimits(SENDER, {
        permissionCeiling: TEAMMATE,
        carriedMarks: { outsider: true },
      });
      expect(before.isSealedTurnLimits(SENDER, stamp)).toBe(true);
      const payload = { [CARRIED_TURN_LIMITS_FIELD]: stamp };
      expect(turnPowerOptions(false, false, payload, SENDER)).toEqual({
        permissionCeiling: ['runtime-default', marked],
        carriedMarks: { outsider: true },
      });
    });

    it('is kept from limits the server sealed for this sender, after a trip through JSON', () => {
      const payload = JSON.parse(
        JSON.stringify({
          [CARRIED_TURN_LIMITS_FIELD]: sealTurnLimits(SENDER, { permissionCeiling: [TEAMMATE] }),
        })
      ) as Record<string, unknown>;
      expect(turnPowerOptions(false, false, payload, SENDER)).toEqual({
        permissionCeiling: ['runtime-default', TEAMMATE],
      });
    });
  });

  describe('a message from the outside HTTP address', () => {
    it.each([
      ['carrying no limits', null],
      ['carrying limits that name no mark', { [CARRIED_TURN_LIMITS_FIELD]: {} }],
      [
        'carrying a sealed stamp that names no mark',
        {
          [CARRIED_TURN_LIMITS_FIELD]: sealTurnLimits(HTTP_RELAY_SENDER, {
            permissionCeiling: 'runtime-default',
          }),
        },
      ],
    ])('is held and marked as an outsider’s when %s', (_name, payload) => {
      expect(turnPowerOptions(false, false, payload, HTTP_RELAY_SENDER)).toMatchObject({
        carriedMarks: { outsider: true },
      });
      expect(
        [turnPowerOptions(false, false, payload, HTTP_RELAY_SENDER).permissionCeiling].flat()
      ).toContain('runtime-default');
    });
  });

  it.each(['relay.external.mcp', 'relay.external.other'])(
    'holds and marks a message from %s, as from every outside sender',
    (from) => {
      expect(turnPowerOptions(false, false, { content: 'hi' }, from)).toEqual({
        permissionCeiling: 'runtime-default',
        carriedMarks: { outsider: true },
      });
    }
  );

  it('leaves a sender outside the family unmarked', () => {
    expect(turnPowerOptions(false, false, { content: 'hi' }, 'relay.externally.agent')).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  it('never lifts a bound: a loose carried level still leaves the runtime default', () => {
    const payload = {
      [CARRIED_TURN_LIMITS_FIELD]: { permissionCeiling: { asks: 'never', reach: 'everything' } },
    };
    const { permissionCeiling } = turnPowerOptions(false, false, payload);
    expect(permissionCeiling).toContain('runtime-default');
  });

  it.each([
    ['a string', 'loose'],
    ['a number', 7],
    ['null', null],
  ])('holds and marks the turn when the carried limits are %s', (_name, value) => {
    expect(turnPowerOptions(true, false, { [CARRIED_TURN_LIMITS_FIELD]: value })).toEqual({
      permissionCeiling: 'runtime-default',
      carriedMarks: { outsider: true },
    });
  });

  it('reads a bound it can’t make sense of as the runtime default', () => {
    const payload = {
      [CARRIED_TURN_LIMITS_FIELD]: {
        permissionCeiling: [{ asks: 'whenever', reach: 'everything' }, { reach: 'read' }],
      },
    };
    expect(turnPowerOptions(true, false, payload)).toEqual({
      permissionCeiling: ['runtime-default', 'runtime-default'],
    });
  });
});

describe('extractPayloadContent', () => {
  it('leaves the carried limits out of the words a payload with no text is read as', () => {
    const words = extractPayloadContent({
      task: 'Run the test suite',
      [CARRIED_TURN_LIMITS_FIELD]: { carriedMarks: { outsider: true } },
    });
    expect(words).toBe('{"task":"Run the test suite"}');
  });
});
