/**
 * Signing out everywhere else counts only sign-ins really gone, the audit row a
 * devices sign-out writes (F4 part 2, DOR-2969), and the setup sign-in that
 * ends at start rather than hiding in the list (DOR-3097).
 */
import { describe, expect, it, vi } from 'vitest';

import type { Auth } from '../index.js';
import { markSignedOutFromDevices, sessionEndReason } from '../auth-audit.js';
import {
  deviceNameOf,
  endSetupSignIns,
  listSignedInDevices,
  signOutOtherSessions,
} from '../sessions/signed-in-devices.js';

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

describe('deviceNameOf', () => {
  const ELECTRON =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0.0.0 Electron/38.0.0 Safari/537.36';

  it('names browser and platform, or a calm fallback', () => {
    expect(
      deviceNameOf(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
      )
    ).toBe('Safari on iPhone');
    expect(deviceNameOf(null)).toBe('A web browser');
    expect(deviceNameOf('')).toBe('A web browser');
  });

  it('calls only the desktop sign-in the DorkOS app, never a user agent that claims it', () => {
    expect(deviceNameOf(ELECTRON, true)).toBe('DorkOS app on Mac');
    expect(deviceNameOf(ELECTRON)).toBe('Chrome on Mac');
    expect(deviceNameOf('DorkOS/1.0')).toBe('A web browser');
  });
});

describe('listSignedInDevices and endSetupSignIns', () => {
  const SIGNED_UP = new Date(Date.now() - 3_600_000);
  const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0.0.0 Safari/537.36';
  /** A Better Auth stand-in: an account made at `SIGNED_UP`, listing `rows`, whose deletes stick. */
  function authOver(rows: object[]) {
    let full = rows.map((row, i) => ({
      token: `tok-${i}`,
      userId: 'u',
      expiresAt: LATER,
      createdAt: SIGNED_UP,
      updatedAt: SIGNED_UP,
      ...row,
    }));
    const deleteSession = vi.fn(async (token: string) => {
      full = full.filter((row) => row.token !== token);
    });
    const auth = {
      $context: Promise.resolve({
        internalAdapter: {
          listSessions: async () => full,
          findUserById: async () => ({ id: 'u', createdAt: SIGNED_UP }),
          deleteSession,
        },
      }),
    } as unknown as Auth;
    return { auth, deleteSession };
  }

  it('lists every live sign-in, the setup one included, until it is ended', async () => {
    const { auth } = authOver([
      { id: 'sign-up', userAgent: '', createdAt: new Date(SIGNED_UP.getTime() + 3) },
      { id: 'browser', userAgent: UA, updatedAt: new Date() },
    ]);
    const list = await listSignedInDevices(auth, 'u', 'browser');
    expect(list.map((device) => device.name)).toEqual(['Chrome on Mac', 'A web browser']);
  });

  it('ends only the sign-in the sign-up made; a later one with no browser stays', async () => {
    const later = new Date(SIGNED_UP.getTime() + 60_000);
    const { auth, deleteSession } = authOver([
      { id: 'sign-up', userAgent: '', createdAt: new Date(SIGNED_UP.getTime() + 3) },
      { id: 'script', userAgent: '', createdAt: later, updatedAt: later },
      { id: 'browser', userAgent: UA, createdAt: later, updatedAt: new Date() },
    ]);
    expect(await endSetupSignIns(auth, 'u')).toBe(1);
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith('tok-0');
    const list = await listSignedInDevices(auth, 'u', 'browser');
    expect(list.map((device) => device.name)).toEqual(['Chrome on Mac', 'A web browser']);
  });

  it('finds nothing the second time', async () => {
    const { auth, deleteSession } = authOver([{ id: 'sign-up', userAgent: null }]);
    expect(await endSetupSignIns(auth, 'u')).toBe(1);
    expect(await endSetupSignIns(auth, 'u')).toBe(0);
    expect(deleteSession).toHaveBeenCalledOnce();
  });

  it('leaves a sign-in with a browser alone, even one made at sign-up', async () => {
    const { auth, deleteSession } = authOver([{ id: 'web-sign-up', userAgent: UA }]);
    expect(await endSetupSignIns(auth, 'u')).toBe(0);
    expect(deleteSession).not.toHaveBeenCalled();
  });
});
