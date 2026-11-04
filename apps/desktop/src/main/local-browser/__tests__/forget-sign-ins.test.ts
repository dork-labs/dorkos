import { expect, it, vi } from 'vitest';
import { forgetGuestSignIns } from '../forget-sign-ins';
it('waits for page destruction before clearing every guest storage and authentication cache', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const guest = {
    cookies: {
      flushStore: vi.fn(async () => {
        calls.push('flush');
      }),
    },
    closeAllConnections: vi.fn(async () => {
      calls.push('connections');
    }),
    clearAuthCache: vi.fn(async () => {
      calls.push('auth');
    }),
    clearStorageData: vi.fn(async () => {
      calls.push('storage');
    }),
    clearCache: vi.fn(async () => {
      calls.push('cache');
    }),
  };
  const cleared = forgetGuestSignIns(guest, async () => {
    await closed;
    calls.push('closed');
  });
  expect(calls).toEqual([]);
  release();
  await cleared;
  expect(calls).toEqual(['closed', 'connections', 'auth', 'storage', 'cache', 'flush']);
});
it('clears nothing when closing a writer fails', async () => {
  const guest = {
    cookies: { flushStore: vi.fn() },
    closeAllConnections: vi.fn(),
    clearAuthCache: vi.fn(),
    clearStorageData: vi.fn(),
    clearCache: vi.fn(),
  };
  await expect(
    forgetGuestSignIns(guest, async () => {
      throw new Error('still open');
    })
  ).rejects.toThrow('still open');
  expect(guest.clearStorageData).not.toHaveBeenCalled();
});

it('does not report completion if flushing cookies to disk fails', async () => {
  const guest = {
    closeAllConnections: vi.fn(),
    clearAuthCache: vi.fn(),
    clearStorageData: vi.fn(),
    clearCache: vi.fn(),
    cookies: { flushStore: vi.fn().mockRejectedValue(new Error('disk unavailable')) },
  };
  await expect(forgetGuestSignIns(guest, async () => {})).rejects.toThrow('disk unavailable');
  expect(guest.cookies.flushStore).toHaveBeenCalledOnce();
});
