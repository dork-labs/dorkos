/**
 * Security Must 1 for re-seating: a room seat moved to a fresh session starts
 * with the old seat's settings row and never more power. The row is written
 * before the first turn, so the room's new-session seed (the agent's default,
 * the operator's level) never applies to it. Carry-over and re-seat share one
 * computation, {@link carriedSettings}.
 */
import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../../runtimes/codex/runtime-constants.js';
import { carriedSettings, carriedStop, reseatSettings } from '../carry-over-power.js';

const CLAUDE = CLAUDE_CODE_CAPABILITIES.permissionModes;

describe('reseatSettings', () => {
  it('copies the old seat’s model, effort and mode exactly', () => {
    expect(
      reseatSettings({ model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }, CLAUDE)
    ).toEqual({ model: 'opus', effort: 'high', permissionMode: 'acceptEdits' });
  });

  it('pins the mode the old seat ran at when it stored none, never the runtime’s bare default', () => {
    // An unset mode ran at the agent's effective level (the room's unattended
    // resolver). Leaving it unset on the new row would let the room's
    // first-turn seed decide instead; the runtime's own default would drop it.
    expect(reseatSettings({ model: 'sonnet' }, CLAUDE, 'bypassPermissions')).toEqual({
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
    });
    expect(reseatSettings(null, CLAUDE, 'acceptEdits')).toEqual({ permissionMode: 'acceptEdits' });
  });

  it('falls back to the runtime’s own default only when the seat’s level is unknown', () => {
    expect(reseatSettings(null, CLAUDE, undefined)).toEqual({ permissionMode: CLAUDE!.default });
  });

  it('keeps a person-set level below Full where it was, whatever the agent’s level', () => {
    for (const mode of ['default', 'acceptEdits', 'plan']) {
      expect(reseatSettings({ permissionMode: mode }, CLAUDE, 'bypassPermissions')).toEqual({
        permissionMode: mode,
      });
    }
  });

  it('never starts at a higher trust stop than the old seat, for every declared mode', () => {
    for (const mode of CLAUDE!.values) {
      const next = reseatSettings({ permissionMode: mode.id }, CLAUDE);
      expect(carriedStop(next.permissionMode, CLAUDE)).toBe(carriedStop(mode.id, CLAUDE));
      expect(next.permissionMode).toBe(mode.id);
    }
  });

  it('keeps a lower seat lower: Default stays Default, never Full', () => {
    const next = reseatSettings({ permissionMode: 'default' }, CLAUDE);
    expect(next.permissionMode).toBe('default');
    expect(next.permissionMode).not.toBe('bypassPermissions');
  });
});

describe('carriedSettings (carry-over, unchanged)', () => {
  it('same runtime: the source’s model unless one was chosen, its effort and mode', () => {
    const source = { model: 'opus', effort: 'low', permissionMode: 'plan' } as const;
    expect(carriedSettings(source, {})).toEqual(source);
    expect(carriedSettings(source, { model: 'sonnet' })).toEqual({ ...source, model: 'sonnet' });
  });

  it('another runtime: only a chosen model, and the stop capped at act', () => {
    const next = carriedSettings(
      { model: 'opus', effort: 'high', permissionMode: 'bypassPermissions' },
      { crossRuntime: { source: CLAUDE, target: CODEX_CAPABILITIES.permissionModes } }
    );
    expect(next.model).toBeUndefined();
    expect(next.effort).toBeUndefined();
    expect(carriedStop(next.permissionMode, CODEX_CAPABILITIES.permissionModes)).toBe('act');
  });
});
