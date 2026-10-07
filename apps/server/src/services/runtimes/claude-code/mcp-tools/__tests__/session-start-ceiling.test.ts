/**
 * `session_start` can never start a chat above the turn it is called from, and a turn somebody
 * from off this machine started runs at its ceiling (spec `official-community-space` D10). So
 * the level a chat may start another at is the ceiling, not the session's own stored mode.
 */
import { describe, expect, it } from 'vitest';
import { runningPermissionMode } from '../session-start-permission.js';

describe('the level a stranger’s turn may start a chat at', () => {
  it('is the turn’s ceiling, not the session’s Full autonomy', () => {
    expect(
      runningPermissionMode({
        permissionMode: 'bypassPermissions',
        turnPermissionCeiling: 'default',
      })
    ).toBe('default');
  });

  it('is the session’s own mode on a turn with no ceiling', () => {
    expect(runningPermissionMode({ permissionMode: 'bypassPermissions' })).toBe(
      'bypassPermissions'
    );
  });

  it('is the background ceiling while a stranger’s helper may still be running', () => {
    expect(
      runningPermissionMode({
        permissionMode: 'bypassPermissions',
        backgroundPermissionCeiling: 'default',
      })
    ).toBe('default');
  });
});
