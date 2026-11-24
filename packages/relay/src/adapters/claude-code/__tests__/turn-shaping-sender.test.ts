/**
 * What a relay turn is sent with because of its sender, and the limits a message carries from its
 * sender's own turns (DOR-5151): they add to the sender's bounds and never lift one, and anything
 * there that can't be read holds the turn at the runtime's default and marks it.
 */
import { describe, expect, it } from 'vitest';
import { CARRIED_TURN_LIMITS_FIELD, turnPowerOptions } from '../turn-shaping-sender.js';

const TEAMMATE = {
  asks: 'never',
  reach: 'everything',
  teammate: [{ roomId: 'r1', authorId: 'a1' }],
};

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
      [CARRIED_TURN_LIMITS_FIELD]: {
        permissionCeiling: TEAMMATE,
        carriedMarks: { outsider: true },
      },
    };
    expect(turnPowerOptions(false, false, payload)).toEqual({
      permissionCeiling: ['runtime-default', TEAMMATE],
      carriedMarks: { outsider: true },
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
