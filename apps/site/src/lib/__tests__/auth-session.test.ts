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

import { getServerSession, requireServerSession } from '../auth-session';

const SESSION = { user: { id: 'u1', email: 'kai' + '@' + 'dork.test' }, session: { id: 's1' } };

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
