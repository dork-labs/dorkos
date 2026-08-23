/**
 * The per-room limit ladder: room override → user config → schema default
 * (DOR-1429).
 *
 * Every rung is exercised on its own and against the rung below it, because the
 * whole value of a ladder is which answer wins — a test that only ever supplies
 * one rung proves nothing about the order.
 */
import { describe, it, expect } from 'vitest';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { resolveRoomLimits } from '../limits/room-limits.js';

const DEFAULTS = USER_CONFIG_DEFAULTS.rooms;

/** A full install-wide config rung, distinct from the shipped defaults in every field. */
const CONFIG = {
  turnLimitsEnabled: true,
  maxAgentDepth: 7,
  maxTurnsPerAgentPerCascade: 4,
  maxAutomaticTurnsPerRoomPerHour: 55,
};

describe('resolveRoomLimits — the three rungs', () => {
  it('falls all the way to the schema defaults when nothing else answers', () => {
    expect(resolveRoomLimits(null, null)).toEqual({
      turnLimitsEnabled: DEFAULTS.turnLimitsEnabled,
      maxAgentDepth: DEFAULTS.maxAgentDepth,
      maxTurnsPerAgentPerCascade: DEFAULTS.maxTurnsPerAgentPerCascade,
      maxAutoTurnsPerHour: DEFAULTS.maxAutomaticTurnsPerRoomPerHour,
    });
  });

  it('takes user config over the schema defaults', () => {
    // Every field pinned away from its default, so a rung that silently fell
    // through would show up as a shipped number rather than as the one set.
    expect(resolveRoomLimits(null, CONFIG)).toEqual({
      turnLimitsEnabled: true,
      maxAgentDepth: 7,
      maxTurnsPerAgentPerCascade: 4,
      maxAutoTurnsPerHour: 55,
    });
  });

  it('takes the room over user config, field by field', () => {
    const resolved = resolveRoomLimits(
      { maxAgentDepth: 2, maxAutoTurnsPerHour: 9 },
      { ...CONFIG, turnLimitsEnabled: true }
    );
    expect(resolved.maxAgentDepth).toBe(2);
    expect(resolved.maxAutoTurnsPerHour).toBe(9);
    // The two the room said nothing about still come from config, which is the
    // half a whole-object override would get wrong.
    expect(resolved.maxTurnsPerAgentPerCascade).toBe(4);
    expect(resolved.turnLimitsEnabled).toBe(true);
  });

  it('reads an explicit null on the room as "inherit", not as a value', () => {
    // This is what clearing an override through the API leaves behind, so it has
    // to be indistinguishable from a room that never set one.
    const cleared = resolveRoomLimits(
      {
        turnLimitsEnabled: null,
        maxAgentDepth: null,
        maxTurnsPerAgentPerCascade: null,
        maxAutoTurnsPerHour: null,
      },
      CONFIG
    );
    expect(cleared).toEqual(resolveRoomLimits(null, CONFIG));
  });

  it('lets a room mix an override, an inherited field and a default', () => {
    // Config that answers only one of the three numbers — the shape a config
    // file read half-way, or a partial fixture, actually has.
    const resolved = resolveRoomLimits(
      { maxTurnsPerAgentPerCascade: 3 },
      { maxAgentDepth: 7, turnLimitsEnabled: true }
    );
    expect(resolved.maxTurnsPerAgentPerCascade).toBe(3);
    expect(resolved.maxAgentDepth).toBe(7);
    expect(resolved.maxAutoTurnsPerHour).toBe(DEFAULTS.maxAutomaticTurnsPerRoomPerHour);
  });
});

describe('resolveRoomLimits — the per-room toggle, both directions', () => {
  it('makes a room unlimited on an install that limits every other room', () => {
    expect(
      resolveRoomLimits({ turnLimitsEnabled: false }, { ...CONFIG, turnLimitsEnabled: true })
        .turnLimitsEnabled
    ).toBe(false);
  });

  it('keeps a room limited on an install that turned limits off', () => {
    expect(
      resolveRoomLimits({ turnLimitsEnabled: true }, { ...CONFIG, turnLimitsEnabled: false })
        .turnLimitsEnabled
    ).toBe(true);
  });

  it('follows the install when the room has no opinion', () => {
    expect(resolveRoomLimits(null, { ...CONFIG, turnLimitsEnabled: false }).turnLimitsEnabled).toBe(
      false
    );
    expect(resolveRoomLimits(null, { ...CONFIG, turnLimitsEnabled: true }).turnLimitsEnabled).toBe(
      true
    );
  });

  it('keeps the numbers while the toggle is off, so turning it back on restores them', () => {
    // The plan's decision 4: the switch is its own flag rather than a `0` on
    // each number, precisely so nothing is lost while it is off.
    const off = resolveRoomLimits({ turnLimitsEnabled: false, maxAgentDepth: 2 }, CONFIG);
    expect(off.turnLimitsEnabled).toBe(false);
    expect(off.maxAgentDepth).toBe(2);
    expect(off.maxTurnsPerAgentPerCascade).toBe(4);
    expect(off.maxAutoTurnsPerHour).toBe(55);
  });
});

describe('resolveRoomLimits — the asymmetry it deliberately does not resolve', () => {
  it('resolves four values and never the install-wide hourly total', () => {
    // The global cap has no per-room meaning, no per-room column and no rung
    // here — a room opts out of its own bounds, not out of the install's
    // wallet. If a fifth key ever appears in this object, the asymmetry has
    // been quietly reversed and the budget wiring in `services/rooms/index.ts`
    // is no longer the only reader of the install-wide toggle.
    expect(Object.keys(resolveRoomLimits({ turnLimitsEnabled: false }, CONFIG)).sort()).toEqual([
      'maxAgentDepth',
      'maxAutoTurnsPerHour',
      'maxTurnsPerAgentPerCascade',
      'turnLimitsEnabled',
    ]);
  });

  it('still resolves a depth for an unlimited room, because cascades are still stamped', () => {
    // `deriveCascade` stamps an un-provenanced agent post AT the ceiling even
    // while limits are off, so an exchange that ran unlimited is still readable
    // as a chain when they are turned back on.
    expect(resolveRoomLimits({ turnLimitsEnabled: false }, CONFIG).maxAgentDepth).toBe(7);
  });
});
