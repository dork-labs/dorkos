/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

// `redirect()` throws in Next to halt rendering; model that so control flow
// stops exactly like production and the thrown target is assertable.
const redirectSpy = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirectSpy(url),
}));

const getSession = vi.fn();
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({ api: { getSession } }),
}));

import {
  getServerSession,
  isAdminSession,
  requireAdminSession,
  requireServerSession,
} from '../auth-session';

const SESSION = { user: { id: 'u1', email: 'kai' + '@' + 'dork.test' }, session: { id: 's1' } };
const ADMIN_SESSION = {
  user: { id: 'a1', email: 'root' + '@' + 'dork.test', role: 'admin' },
  session: { id: 's2' },
};

describe('getServerSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the session when the request carries a valid cookie', async () => {
    getSession.mockResolvedValue(SESSION);
    await expect(getServerSession()).resolves.toEqual(SESSION);
  });

  it('returns null when there is no session', async () => {
    getSession.mockResolvedValue(null);
    await expect(getServerSession()).resolves.toBeNull();
  });
});

describe('requireServerSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects unauthenticated visitors to /signin with an encoded returnTo', async () => {
    getSession.mockResolvedValue(null);

    await expect(requireServerSession('/account')).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectSpy).toHaveBeenCalledWith('/signin?returnTo=%2Faccount');
  });

  it('returns the session and does not redirect when authenticated', async () => {
    getSession.mockResolvedValue(SESSION);

    await expect(requireServerSession('/account')).resolves.toEqual(SESSION);
    expect(redirectSpy).not.toHaveBeenCalled();
  });
});

describe('isAdminSession', () => {
  // The two trusted admin mechanisms and their negatives — this is the access
  // gate behind /admin, so each branch must be pinned.

  it('is true when the session user carries the admin-plugin role', () => {
    // env.ADMIN_USER_IDS defaults to empty, so the role alone must decide this.
    expect(isAdminSession(ADMIN_SESSION as never)).toBe(true);
  });

  it('is false for a signed-in non-admin whose id is not allowlisted', () => {
    expect(isAdminSession(SESSION as never)).toBe(false);
  });

  it('is false for a null (unauthenticated) session', () => {
    expect(isAdminSession(null)).toBe(false);
  });

  it('is true when the user id is in the ADMIN_USER_IDS break-glass allowlist', async () => {
    // env is parsed from process.env at import time, so seed it and re-import the
    // module (with its mocks intact) to exercise the break-glass path.
    vi.resetModules();
    const prev = process.env.ADMIN_USER_IDS;
    process.env.ADMIN_USER_IDS = 'someone-else, u1 ,another';
    try {
      const mod = await import('../auth-session');
      // Same user, no admin role — only the allowlist can make this true.
      expect(mod.isAdminSession(SESSION as never)).toBe(true);
      // A different, un-allowlisted user is still not an admin under the same env.
      expect(
        mod.isAdminSession({ user: { id: 'not-listed', email: 'x' }, session: {} } as never)
      ).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_USER_IDS;
      else process.env.ADMIN_USER_IDS = prev;
      vi.resetModules();
    }
  });
});

describe('requireAdminSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects unauthenticated visitors to /signin with an encoded returnTo', async () => {
    getSession.mockResolvedValue(null);

    await expect(requireAdminSession('/admin')).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectSpy).toHaveBeenCalledWith('/signin?returnTo=%2Fadmin');
  });

  it('redirects a signed-in non-admin to /account (never acknowledging /admin)', async () => {
    getSession.mockResolvedValue(SESSION);

    await expect(requireAdminSession('/admin')).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectSpy).toHaveBeenCalledWith('/account');
  });

  it('returns the session and does not redirect for an admin', async () => {
    getSession.mockResolvedValue(ADMIN_SESSION);

    await expect(requireAdminSession('/admin')).resolves.toEqual(ADMIN_SESSION);
    expect(redirectSpy).not.toHaveBeenCalled();
  });
});
