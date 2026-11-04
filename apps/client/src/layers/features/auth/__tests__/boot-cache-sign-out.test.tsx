/** @vitest-environment jsdom */
import type { PropsWithChildren } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { dehydrate, QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthClientProvider } from '../model/auth-client-context';
import { createFakeAuthClient } from './fake-auth-client';
import {
  useAuthSession,
  useSignIn,
  useSignOut,
  usePublicComputerIdleSignOut,
  PUBLIC_COMPUTER_IDLE_MS,
} from '../model/use-auth-session';
import { createBootCache } from '@/layers/shared/lib/query-persister';
import { bootCacheStorageKey } from '@/layers/shared/lib/boot-cache-keys';
import {
  BOOT_CACHE_SESSION_KEY,
  bootCacheSignInCheck,
  resumeBootCacheAfterSignIn,
} from '@/layers/shared/lib/boot-cache-session';
import { HttpTransport } from '@/layers/shared/lib/transport';

const key = bootCacheStorageKey('/api');
const roomsKey = ['rooms', 'list', null];
const reload = vi.fn();
const disconnects: (() => void)[] = [];

function tab(publicComputer = false, connected = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  queryClient.setQueryData(roomsKey, [{ title: 'tern private room' }]);
  const cache = createBootCache({
    transport: new HttpTransport('/api'),
    apiBaseUrl: '/api',
    buster: 'test',
  })!;
  if (connected) disconnects.push(cache.connect(queryClient));
  const auth = createFakeAuthClient({
    getSession: vi.fn().mockResolvedValue({
      data: {
        user: { id: 'tern', name: 'Tern', email: 'tern@example.invalid' },
        session: { id: 'session-tern', userId: 'tern', expiresAt: '2099-01-01', publicComputer },
      },
      error: null,
    }),
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>
      <AuthClientProvider client={auth}>{children}</AuthClientProvider>
    </QueryClientProvider>
  );
  return { queryClient, cache, auth, wrapper };
}

beforeEach(() => {
  localStorage.clear();
  reload.mockReset();
});
afterEach(() => {
  for (const stop of disconnects.splice(0)) stop();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Actual auth hooks and persisters: two independently held query caches sharing
// browser storage, like two tabs. Browser coverage separately drives storage events.
describe('sign-out forgets boot data until the next sign-in', () => {
  it('does not let another tab repopulate storage on pagehide', async () => {
    const first = tab();
    // A suspended tab can flush before its queued storage event is delivered.
    const second = tab(false, false);
    second.cache.flush(second.queryClient);
    expect(localStorage.getItem(key)).toContain('tern private room');
    const { result } = renderHook(() => useSignOut(), { wrapper: first.wrapper });
    await act(async () => {
      await result.current.run();
    });
    window.addEventListener('pagehide', () => second.cache.flush(second.queryClient), {
      once: true,
    });
    window.dispatchEvent(new Event('pagehide'));
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('rejects an already queued non-empty save after signing out', async () => {
    vi.useFakeTimers();
    const first = tab();
    const second = tab(false, false);
    await second.cache.persistOptions.persister.persistClient({
      buster: 'test',
      timestamp: Date.now(),
      clientState: dehydrate(second.queryClient),
    });
    const { result } = renderHook(() => useSignOut(), { wrapper: first.wrapper });
    await act(async () => {
      await result.current.run();
    });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('preserves first-owner setup when there is no previous sign-out', () => {
    const current = tab();
    resumeBootCacheAfterSignIn(current.queryClient);
    expect(current.queryClient.getQueryData(roomsKey)).toEqual([{ title: 'tern private room' }]);
  });

  it('rejects a session read that began before a newer sign-out', async () => {
    const current = tab();
    const out = renderHook(() => useSignOut(), { wrapper: current.wrapper });
    await act(async () => {
      await out.result.current.run();
    });
    const staleResponse = bootCacheSignInCheck(current.queryClient);
    await act(async () => {
      await out.result.current.run();
    });
    staleResponse();
    current.queryClient.setQueryData(roomsKey, [{ title: 'late response' }]);
    current.cache.flush(current.queryClient);
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem(BOOT_CACHE_SESSION_KEY)).toMatch(/^signed-out:/);
  });

  it('sets the barrier on plain HTTP where randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const current = tab();
    const out = renderHook(() => useSignOut(), { wrapper: current.wrapper });
    await act(async () => {
      await out.result.current.run();
    });
    expect(localStorage.getItem(BOOT_CACHE_SESSION_KEY)).toMatch(/^signed-out:/);
  });

  it('frees the old blob and retries the barrier when storage is full', async () => {
    const current = tab();
    const suspended = tab(false, false);
    current.cache.flush(current.queryClient);
    const setItem = Storage.prototype.setItem;
    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementationOnce(() => {
        throw new DOMException('Full', 'QuotaExceededError');
      })
      .mockImplementation(function (this: Storage, name, value) {
        setItem.call(this, name, value);
      });
    try {
      const out = renderHook(() => useSignOut(), { wrapper: current.wrapper });
      await act(async () => {
        await out.result.current.run();
      });
      suspended.cache.flush(suspended.queryClient);
      expect(localStorage.getItem(BOOT_CACHE_SESSION_KEY)).toMatch(/^signed-out:/);
      expect(localStorage.getItem(key)).toBeNull();
    } finally {
      write.mockRestore();
    }
  });

  it('removes a write when another tab signs out between the check and setItem', () => {
    const current = tab();
    const setItem = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      name,
      value
    ) {
      if (name === key) setItem.call(this, BOOT_CACHE_SESSION_KEY, 'signed-out:interleaved');
      setItem.call(this, name, value);
    });
    try {
      current.cache.flush(current.queryClient);
      expect(localStorage.getItem(key)).toBeNull();
    } finally {
      write.mockRestore();
    }
  });

  it('rejects an old queued save even after the next sign-in', async () => {
    vi.useFakeTimers();
    const current = tab();
    const suspended = tab(false, false);
    await suspended.cache.persistOptions.persister.persistClient({
      buster: 'test',
      timestamp: Date.now(),
      clientState: dehydrate(suspended.queryClient),
    });
    const out = renderHook(() => useSignOut(), { wrapper: current.wrapper });
    await act(async () => {
      await out.result.current.run();
    });
    resumeBootCacheAfterSignIn(current.queryClient);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('keeps writes blocked across reload, then resumes after a successful sign-in', async () => {
    const first = tab();
    const { result } = renderHook(() => ({ out: useSignOut(), into: useSignIn() }), {
      wrapper: first.wrapper,
    });
    await act(async () => {
      await result.current.out.run();
    });
    const reloaded = tab();
    reloaded.cache.flush(reloaded.queryClient);
    expect(localStorage.getItem(key)).toBeNull();
    await act(async () => {
      await result.current.into.run('tern@example.invalid', 'made-up-password');
    });
    first.queryClient.setQueryData(roomsKey, [{ title: 'fresh room' }]);
    first.cache.flush(first.queryClient);
    expect(localStorage.getItem(key)).toContain('fresh room');
  });

  it('wipes before the public-computer idle reload can flush stale data', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const idle = tab(true);
    idle.cache.flush(idle.queryClient);
    reload.mockImplementation(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    vi.stubGlobal('location', { ...window.location, reload });
    window.addEventListener('pagehide', () => idle.cache.flush(idle.queryClient), { once: true });
    renderHook(() => usePublicComputerIdleSignOut(), { wrapper: idle.wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PUBLIC_COMPUTER_IDLE_MS + 1);
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(idle.queryClient.getQueryData(roomsKey)).toBeUndefined();
    expect(localStorage.getItem(key)).toBeNull();
  });
  it('clears another tab’s live observer when its storage event arrives', () => {
    const other = tab();
    const observer = new QueryObserver(other.queryClient, { queryKey: roomsKey, enabled: false });
    const stop = observer.subscribe(() => {});
    localStorage.setItem(BOOT_CACHE_SESSION_KEY, 'signed-out:another-tab');
    window.dispatchEvent(
      new StorageEvent('storage', { key: BOOT_CACHE_SESSION_KEY, storageArea: localStorage })
    );
    expect(other.queryClient.getQueryData(roomsKey)).toBeUndefined();
    expect(observer.getCurrentResult().data).toBeUndefined();
    stop();
  });

  it('does not erase or lock the cache when sign-out is refused', async () => {
    const current = tab();
    vi.mocked(current.auth.signOut).mockResolvedValue({
      data: null,
      error: { message: 'Offline', status: 503 },
    });
    const { result } = renderHook(() => useSignOut(), { wrapper: current.wrapper });
    await act(async () => {
      await result.current.run();
    });
    current.cache.flush(current.queryClient);
    expect(localStorage.getItem(key)).toContain('tern private room');
  });

  it('resumes after a redirect sign-in is verified by a fresh session read', async () => {
    const current = tab();
    const out = renderHook(() => useSignOut(), { wrapper: current.wrapper });
    await act(async () => {
      await out.result.current.run();
    });
    // Social sign-in navigates away: the new page verifies the cookie through getSession.
    const session = renderHook(() => useAuthSession(), { wrapper: current.wrapper });
    await act(async () => {
      await session.result.current.refetch();
    });
    current.queryClient.setQueryData(roomsKey, [{ title: 'after redirect' }]);
    current.cache.flush(current.queryClient);
    expect(localStorage.getItem(key)).toContain('after redirect');
  });
});
