/**
 * The pieces of a warm process's ceiling a single turn cannot see (`warm-ceiling.ts`,
 * `turn-permission.ts`): the tool gate and `session_start` keep background work an
 * earlier ceilinged turn left running at that ceiling, and the carried ceiling is
 * dropped only once the process is quiet.
 *
 * The end-to-end half, on a fake warm CLI, is in
 * `sessions/__tests__/persistent-dispatch.test.ts` ("a stranger's turn on a warm process").
 */
import { describe, expect, it } from 'vitest';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { runningPermissionMode } from '../mcp-tools/session-start-permission.js';
import { bothCeilings, gatePermissionMode, heldToACeiling } from '../turn-permission.js';
import { carryCeiling } from '../warm-ceiling.js';

const QUIET = { quietness: () => ({ quiet: true }) };
const BUSY = { quietness: () => ({ quiet: false }) };
const ACCEPT_EDITS: TurnPermissionLevel = { asks: 'when-risky', reach: 'workspace' };

describe('the tool gate under a carried ceiling', () => {
  it("answers a stranger's background work at the ceiling after the owner's turn begins", () => {
    // The owner's turn carries no ceiling of its own; the stranger's helper still runs.
    const session = {
      permissionMode: 'bypassPermissions',
      backgroundPermissionCeiling: 'runtime-default' as const,
    };
    expect(gatePermissionMode(session)).toBe('default');
    expect(heldToACeiling(session)).toBe(true);
  });

  it('answers at the session’s own mode when nothing carries a ceiling', () => {
    expect(gatePermissionMode({ permissionMode: 'bypassPermissions' })).toBe('bypassPermissions');
    expect(heldToACeiling({})).toBe(false);
  });

  it('holds session_start to the carried ceiling too', () => {
    expect(
      runningPermissionMode({
        permissionMode: 'bypassPermissions',
        backgroundPermissionCeiling: 'runtime-default',
      })
    ).toBe('default');
  });
});

describe('the ceiling background work carries', () => {
  it('keeps an earlier ceiling while the process still works, beside this turn’s own', () => {
    const carried = carryCeiling(
      { turnPermissionCeiling: ACCEPT_EDITS, backgroundPermissionCeiling: 'runtime-default' },
      BUSY
    );
    expect(carried).toEqual([ACCEPT_EDITS, 'runtime-default']);
    // A looser later turn never lifts the stranger's bound off running work.
    expect(
      gatePermissionMode({
        permissionMode: 'bypassPermissions',
        backgroundPermissionCeiling: carried,
      })
    ).toBe('default');
  });

  it('drops the earlier ceiling once the process is quiet', () => {
    expect(carryCeiling({ backgroundPermissionCeiling: 'runtime-default' }, QUIET)).toBeUndefined();
  });

  it('keeps one copy of a bound repeated across turns', () => {
    expect(bothCeilings('runtime-default', ['runtime-default'])).toBe('runtime-default');
  });
});
