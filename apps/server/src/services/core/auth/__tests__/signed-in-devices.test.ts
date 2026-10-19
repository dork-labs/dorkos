/**
 * Signing out everywhere else counts only sign-ins really gone, and the audit
 * row a devices sign-out writes (F4 part 2, DOR-2969).
 */
import { describe, expect, it, vi } from 'vitest';

import type { Auth } from '../index.js';
import { markSignedOutFromDevices, sessionEndReason } from '../auth-audit.js';
import { signOutOtherSessions, userAgentLabel } from '../sessions/signed-in-devices.js';

const LATER = new Date(Date.now() + 60_000);

/** A Better Auth stand-in over rows in memory; `deletes` decides what a delete removes. */
function fakeAuth(ids: string[], deletes: (tokens: string[]) => string[]) {
  let rows = ids.map((id) => ({
    id,
    token: `tok-${id}`,
    userId: 'u',
    expiresAt: LATER,
    createdAt: LATER,
    updatedAt: LATER,
  }));
  const deleteSessions = vi.fn(async (tokens: string[]) => {
    const gone = new Set(deletes(tokens));
    rows = rows.filter((row) => !gone.has(row.token));
  });
  const auth = {
    $context: Promise.resolve({
      internalAdapter: { listSessions: async () => rows, deleteSessions },
    }),
  } as unknown as Auth;
  return { auth, deleteSessions };
}

describe('signOutOtherSessions', () => {
  it('counts what was deleted and keeps the asking one', async () => {
    const { auth } = fakeAuth(['keep', 'a', 'b'], (tokens) => tokens);
    expect(await signOutOtherSessions(auth, 'u', 'keep')).toBe(2);
  });

  it('stops after a pass that deletes nothing, counting nothing', async () => {
    const { auth, deleteSessions } = fakeAuth(['keep', 'a', 'b'], () => []);
    expect(await signOutOtherSessions(auth, 'u', 'keep')).toBe(0);
    expect(deleteSessions).toHaveBeenCalledOnce();
  });

  it('counts a partial delete, then stops when the rest will not go', async () => {
    const { auth, deleteSessions } = fakeAuth(['a', 'b'], (tokens) =>
      tokens.filter((token) => token === 'tok-a')
    );
    expect(await signOutOtherSessions(auth, 'u', undefined)).toBe(1);
    expect(deleteSessions).toHaveBeenCalledTimes(2);
  });
});

describe('the audit row of a devices sign-out', () => {
  it('names a device sign-out once, then reads as any other ended sign-in', () => {
    markSignedOutFromDevices('s1');
    const row = { id: 's1', userId: 'u', expiresAt: LATER };
    expect(sessionEndReason(row, undefined).action).toBe('auth.device_signed_out');
    expect(sessionEndReason(row, undefined).action).toBe('auth.session_ended');
  });
});

describe('userAgentLabel', () => {
  it('names browser and system in a few words', () => {
    expect(
      userAgentLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
      )
    ).toBe('Safari on iPhone');
    expect(userAgentLabel(null)).toBeUndefined();
  });
});
