/** @vitest-environment jsdom */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  renderHook,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  authenticateExtensionAuthOperation,
  beginExtensionAuthOperation,
  getExtensionLoadAdmission,
  getAuthRequired,
  registerExtensionLoadOwner,
  registerCommunityAuthorityCleanup,
  subscribeCommunityAuthority,
  getCommunityAuthority,
  confirmCommunityAuthority,
  requestExtensionRemount,
  resumeExtensionLoads,
  setAuthRequired,
} from '@/layers/shared/lib';
import { createInitialSlots, useAppStore, useExtensionRegistry } from '@/layers/shared/model';
import { createExtensionAPI } from '@/layers/features/extensions/model/extension-api-factory';
import type { ExtensionAPIDeps } from '@/layers/features/extensions/model/types';
import { eraseCommunityOwnerState, useCommunityDraftStore } from '@/layers/entities/community';
import { AuthGuard } from '../ui/AuthGuard';
import { AuthClientProvider } from '../model/auth-client-context';
import type { AuthClient } from '../model/auth-client';
import { useSignIn, useSignUp, useSignOut, type AuthActionResult } from '../model/use-auth-session';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

type Kind = 'signIn' | 'signUp' | 'signOut';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function makeClient(): AuthClient {
  const success = { data: null, error: null };
  return {
    signIn: { email: vi.fn().mockResolvedValue(success) },
    signUp: { email: vi.fn().mockResolvedValue(success) },
    signOut: vi.fn().mockResolvedValue(success),
    getSession: vi.fn().mockResolvedValue(success),
    apiKey: { create: vi.fn(), list: vi.fn(), delete: vi.fn() },
  };
}
function useActions() {
  return { signIn: useSignIn(), signUp: useSignUp(), signOut: useSignOut() };
}
function harness() {
  const client = makeClient();
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={query}>
      <AuthClientProvider client={client}>{children}</AuthClientProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(useActions, { wrapper });
  return { client, query, hook };
}
function run(h: ReturnType<typeof harness>, kind: Kind): Promise<AuthActionResult> {
  switch (kind) {
    case 'signIn':
      return h.hook.result.current.signIn.run('fixture@example.invalid', 'fixture');
    case 'signUp':
      return h.hook.result.current.signUp.run('fixture@example.invalid', 'fixture', 'Fixture');
    case 'signOut':
      return h.hook.result.current.signOut.run();
  }
}
function method(client: AuthClient, kind: Kind) {
  return kind === 'signOut' ? vi.mocked(client.signOut) : vi.mocked(client[kind].email);
}
const disposals: Array<() => void> = [];
const queries: QueryClient[] = [];
/** Genuine admission + real page registry; this does not substitute for bundle delivery proof. */
function registerPageOwner(fail = false) {
  const snapshot = getExtensionLoadAdmission();
  const owner = {};
  const retired = vi.fn();
  const remount = vi.fn(async () => {});
  const deps: ExtensionAPIDeps = {
    registry: useExtensionRegistry.getState() as unknown as ExtensionAPIDeps['registry'],
    eventBridge: { subscribe: vi.fn(() => () => {}) },
    dispatcherContext: {
      getStore: () => ({}) as ReturnType<ExtensionAPIDeps['dispatcherContext']['getStore']>,
      setTheme: vi.fn(),
    },
    navigate: vi.fn(),
    appStore: useAppStore as unknown as ExtensionAPIDeps['appStore'],
    availableSlots: new Set(),
    registerCommandHandler: vi.fn(),
    unregisterCommandHandler: vi.fn(),
  };
  const { api, cleanups } = createExtensionAPI('auth-fixture', deps, [], () => {
    if (getExtensionLoadAdmission() !== snapshot || snapshot.suspended)
      throw new Error('EXTENSION_RETIRED');
  });
  api.registerPage('', () => null, { title: 'Auth fixture' });
  expect(useExtensionRegistry.getState().slots.pages).toHaveLength(1);
  expect(cleanups).toHaveLength(1);
  disposals.push(
    registerExtensionLoadOwner(
      owner,
      snapshot,
      () => {
        retired();
        for (const dispose of cleanups) dispose();
        if (fail) throw new Error('OWNED_CLEANUP_FAILED');
        return true;
      },
      remount
    )
  );
  return { retired, remount, api };
}
beforeEach(() => {
  setAuthRequired(false);
  const owner = {};
  const attempt = beginExtensionAuthOperation(owner, 'signIn');
  expect(authenticateExtensionAuthOperation(owner, attempt)).toBe(true);
  expect(resumeExtensionLoads(owner, attempt)).not.toBeNull();
  useExtensionRegistry.setState({ slots: createInitialSlots(), tabMarkers: {} });
});
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  for (const query of queries.splice(0)) query.clear();
  vi.restoreAllMocks();
});

describe('auth occurrence owns extension admission', () => {
  it.each<Kind>(['signIn', 'signUp', 'signOut'])(
    '%s retires the genuine registered page before credential entry',
    async (kind) => {
      const page = registerPageOwner();
      const h = harness();
      queries.push(h.query);
      method(h.client, kind).mockImplementation(async () => {
        expect(getExtensionLoadAdmission().suspended).toBe(true);
        expect(useExtensionRegistry.getState().slots.pages).toHaveLength(0);
        expect(page.retired).toHaveBeenCalledOnce();
        return { data: null, error: null };
      });
      await act(async () => {
        expect(await run(h, kind)).toEqual({ ok: true });
      });
      expect(getExtensionLoadAdmission().suspended).toBe(kind === 'signOut');
      expect(() => page.api.registerPage('late', () => null, { title: 'Late' })).toThrow(
        'EXTENSION_RETIRED'
      );
      if (kind !== 'signOut') registerPageOwner();
    }
  );

  it.each<Kind>(['signIn', 'signUp', 'signOut'])(
    '%s old cache rejection cannot suspend a newer pending occurrence',
    async (kind) => {
      const page = registerPageOwner();
      const h = harness();
      queries.push(h.query);
      const cache = deferred<void>();
      const credential = deferred<{ data: null; error: null }>();
      const invalidate = vi
        .spyOn(h.query, 'invalidateQueries')
        .mockReturnValueOnce(cache.promise)
        .mockResolvedValue(undefined);
      let first!: Promise<AuthActionResult>;
      act(() => {
        first = run(h, kind);
      });
      await waitFor(() => expect(invalidate).toHaveBeenCalledOnce());
      method(h.client, kind).mockReturnValueOnce(credential.promise);
      let second!: Promise<AuthActionResult>;
      act(() => {
        second = run(h, kind);
      });
      const newer = getExtensionLoadAdmission();
      await act(async () => {
        cache.reject(new Error('OLD_CACHE_FAILURE'));
        expect(await first).toMatchObject({ error: { code: 'AUTH_SUPERSEDED' } });
      });
      expect(getExtensionLoadAdmission()).toBe(newer);
      expect(h.hook.result.current[kind].error).toBeNull();
      expect(page.retired).toHaveBeenCalledOnce();
      expect(method(h.client, kind)).toHaveBeenCalledTimes(2);
      await act(async () => {
        credential.resolve({ data: null, error: null });
        expect(await second).toEqual({ ok: true });
      });
    }
  );

  it.each<Kind>(['signIn', 'signUp', 'signOut'])(
    '%s current cache rejection closes admission without inventing success',
    async (kind) => {
      registerPageOwner();
      const h = harness();
      queries.push(h.query);
      vi.spyOn(h.query, 'invalidateQueries').mockRejectedValue(new Error('CURRENT_CACHE_FAILURE'));
      await act(async () => {
        expect(await run(h, kind)).toMatchObject({ error: { code: 'AUTH_STATE_FAILED' } });
      });
      expect(getExtensionLoadAdmission().suspended).toBe(true);
      expect(useExtensionRegistry.getState().slots.pages).toHaveLength(0);
    }
  );

  it.each(['signIn', 'signUp'] as const)(
    '%s success after a 401 cannot reopen or refresh the retired lifetime',
    async (kind) => {
      const page = registerPageOwner();
      const h = harness();
      queries.push(h.query);
      const credential = deferred<{ data: null; error: null }>();
      method(h.client, kind).mockReturnValueOnce(credential.promise);
      const invalidate = vi.spyOn(h.query, 'invalidateQueries');
      let pending!: Promise<AuthActionResult>;
      act(() => {
        pending = run(h, kind);
      });
      act(() => setAuthRequired(true));
      const boundary = getExtensionLoadAdmission();
      await act(async () => {
        credential.resolve({ data: null, error: null });
        expect(await pending).toMatchObject({ error: { code: 'AUTH_SUPERSEDED' } });
      });
      expect(getExtensionLoadAdmission()).toBe(boundary);
      expect(getAuthRequired()).toBe(true);
      expect(invalidate).not.toHaveBeenCalled();
      expect(page.retired).toHaveBeenCalledOnce();
    }
  );

  it.each(['signIn', 'signUp'] as const)(
    '%s authenticated completion survives expected login-hook unmount',
    async (kind) => {
      registerPageOwner();
      const h = harness();
      queries.push(h.query);
      const cache = deferred<void>();
      const invalidate = vi.spyOn(h.query, 'invalidateQueries').mockReturnValueOnce(cache.promise);
      let pending!: Promise<AuthActionResult>;
      act(() => {
        pending = run(h, kind);
      });
      await waitFor(() => expect(invalidate).toHaveBeenCalledOnce());
      const resumed = getExtensionLoadAdmission();
      expect(resumed.suspended).toBe(false);
      h.hook.unmount();
      registerPageOwner();
      await act(async () => {
        cache.reject(new Error('LATE_CACHE_FAILURE'));
        expect(await pending).toMatchObject({ error: { code: 'AUTH_SUPERSEDED' } });
      });
      expect(getExtensionLoadAdmission()).toBe(resumed);
      expect(useExtensionRegistry.getState().slots.pages).toHaveLength(1);
    }
  );

  it.each(['resolve', 'reject'] as const)(
    'real login-screen unmount preserves the authenticated page across late cache %s',
    async (settlement) => {
      const original = registerPageOwner();
      act(() => setAuthRequired(true));
      expect(original.retired).toHaveBeenCalledOnce();
      expect(useExtensionRegistry.getState().slots.pages).toHaveLength(0);
      const client = makeClient();
      const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queries.push(query);
      const credential = deferred<{ data: null; error: null }>();
      const cache = deferred<void>();
      vi.mocked(client.signIn.email).mockReturnValueOnce(credential.promise);
      const invalidate = vi.spyOn(query, 'invalidateQueries').mockReturnValueOnce(cache.promise);
      render(
        <QueryClientProvider client={query}>
          <AuthClientProvider client={client}>
            <AuthGuard>
              <div>authenticated fixture</div>
            </AuthGuard>
          </AuthClientProvider>
        </QueryClientProvider>
      );
      fireEvent.change(screen.getByLabelText('Email'), {
        target: { value: 'fixture@example.invalid' },
      });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'fixture' } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      await waitFor(() => expect(client.signIn.email).toHaveBeenCalledOnce());
      await act(async () => {
        credential.resolve({ data: null, error: null });
      });
      await waitFor(() => expect(screen.getByText('authenticated fixture')).toBeInTheDocument());
      expect(screen.queryByText('Sign in to DorkOS')).not.toBeInTheDocument();
      expect(invalidate).toHaveBeenCalledOnce();
      const resumed = getExtensionLoadAdmission();
      expect(resumed.suspended).toBe(false);
      const replacement = registerPageOwner();
      await act(async () => {
        if (settlement === 'reject') cache.reject(new Error('LATE_CACHE_FAILURE'));
        else cache.resolve();
        await Promise.resolve();
      });
      expect(getExtensionLoadAdmission()).toBe(resumed);
      expect(getAuthRequired()).toBe(false);
      expect(useExtensionRegistry.getState().slots.pages).toHaveLength(1);
      expect(replacement.retired).not.toHaveBeenCalled();
    }
  );

  it.each(['cancel-abort', 'remove-notification'] as const)(
    'registered app cleanup fences later owner effects after real %s reentry',
    async (phase) => {
      const h = harness();
      queries.push(h.query);
      const credential = deferred<{ data: null; error: null }>();
      const oldResponse = deferred<string>();
      const newResponse = deferred<string>();
      vi.mocked(h.client.signIn.email).mockReturnValueOnce(credential.promise);
      const oldKey = ['communities', 'old-app-cleanup'];
      const cacheKey = ['communities', 'new-app-cleanup'];
      const transportKey = ['communities', 'new-app-transport'];
      let reentered = false;
      let newer: Promise<AuthActionResult> | undefined;
      let transport: Promise<string> | undefined;
      let signal: AbortSignal | undefined;
      const reenter = () => {
        if (reentered) return;
        reentered = true;
        newer = run(h, 'signIn');
        const authority = getCommunityAuthority();
        expect(confirmCommunityAuthority(authority.epoch, 'newer-owner')).toBe(true);
        h.query.setQueryData(cacheKey, 'newer-cache');
        useCommunityDraftStore.getState().write(
          {
            ownerKey: 'newer-owner',
            epoch: authority.epoch,
            ref: 'fixture-ref',
            generation: 0,
            roomId: 'fixture-room',
          },
          { text: 'newer-draft', files: [] }
        );
        transport = h.query.fetchQuery({
          queryKey: transportKey,
          queryFn: (context) => {
            signal = context.signal;
            return newResponse.promise;
          },
        });
        void transport.catch(() => {});
      };
      const dispose = registerCommunityAuthorityCleanup((requireCurrent) =>
        eraseCommunityOwnerState(h.query, requireCurrent)
      );
      let stop = () => {};
      let oldTransport: Promise<string> | undefined;
      if (phase === 'cancel-abort') {
        oldTransport = h.query.fetchQuery({
          queryKey: oldKey,
          queryFn: ({ signal: oldSignal }) => {
            oldSignal.addEventListener('abort', reenter, { once: true });
            return oldResponse.promise;
          },
        });
        void oldTransport.catch(() => {});
      } else {
        h.query.setQueryData(oldKey, 'old-cache');
        stop = h.query.getQueryCache().subscribe((event) => {
          if (
            event.type === 'removed' &&
            event.query.queryKey[0] === oldKey[0] &&
            event.query.queryKey[1] === oldKey[1]
          )
            reenter();
        });
      }
      let original: Promise<AuthActionResult> | undefined;
      try {
        act(() => {
          original = run(h, 'signOut');
        });
        await act(async () => {
          expect(await original).toMatchObject({ error: { code: 'AUTH_SUPERSEDED' } });
        });
        expect(reentered).toBe(true);
        expect(h.client.signOut).not.toHaveBeenCalled();
        expect(h.client.signIn.email).toHaveBeenCalledOnce();
        expect(h.query.getQueryData(cacheKey)).toBe('newer-cache');
        expect(h.query.getQueryState(transportKey)?.status).toBe('pending');
        expect(signal).toBeDefined();
        if (!signal) throw new Error('NEWER_APP_TRANSPORT_NOT_ENTERED');
        expect(signal.aborted).toBe(false);
        expect(getCommunityAuthority().ownerKey).toBe('newer-owner');
        expect(
          Object.values(useCommunityDraftStore.getState().drafts).map((draft) => draft.text)
        ).toEqual(['newer-draft']);
      } finally {
        stop();
        dispose();
        await act(async () => {
          oldResponse.resolve('old-return');
          newResponse.resolve('new-return');
          credential.resolve({ data: null, error: null });
          await Promise.allSettled(
            [original, newer, oldTransport, transport].filter((value) => value !== undefined)
          );
        });
        useCommunityDraftStore.getState().discardAll();
      }
      await expect(newer).resolves.toEqual({ ok: true });
    }
  );

  it.each<Kind>(['signIn', 'signUp', 'signOut'])(
    '%s cannot erase newer community cache or cancel its original transport after cleanup reentry',
    async (kind) => {
      const h = harness();
      queries.push(h.query);
      const credential = deferred<{ data: null; error: null }>();
      const response = deferred<{ owner: string }>();
      vi.mocked(h.client.signIn.email).mockReturnValueOnce(credential.promise);
      const cacheKey = ['communities', 'newer-cache'];
      const requestKey = ['communities', 'newer-transport'];
      let reentered = false;
      let newer: Promise<AuthActionResult> | undefined;
      let transport: Promise<{ owner: string }> | undefined;
      let signal: AbortSignal | undefined;
      const dispose = registerCommunityAuthorityCleanup(() => {
        if (reentered) return;
        reentered = true;
        newer = run(h, 'signIn');
        const authority = getCommunityAuthority();
        expect(confirmCommunityAuthority(authority.epoch, 'newer-owner')).toBe(true);
        h.query.setQueryData(cacheKey, { owner: 'newer-owner' });
        transport = h.query.fetchQuery({
          queryKey: requestKey,
          queryFn: (context) => {
            signal = context.signal;
            return response.promise;
          },
        });
        void transport.catch(() => {});
      });
      const observed = vi.fn();
      const stop = subscribeCommunityAuthority(observed);
      let original!: Promise<AuthActionResult>;
      try {
        act(() => {
          original = run(h, kind);
        });
        const admission = getExtensionLoadAdmission();
        await act(async () => {
          expect(await original).toMatchObject({ error: { code: 'AUTH_SUPERSEDED' } });
        });
        expect(h.query.getQueryData(cacheKey)).toEqual({ owner: 'newer-owner' });
        expect(h.query.getQueryState(requestKey)?.status).toBe('pending');
        expect(signal).toBeDefined();
        if (!signal) throw new Error('ORIGINAL_NEWER_TRANSPORT_NOT_ENTERED');
        expect(signal.aborted).toBe(false);
        expect(getCommunityAuthority().ownerKey).toBe('newer-owner');
        expect(observed).toHaveBeenCalledTimes(2);
        expect(getExtensionLoadAdmission()).toBe(admission);
        expect(h.client.signIn.email).toHaveBeenCalledOnce();
        if (kind !== 'signIn') expect(method(h.client, kind)).not.toHaveBeenCalled();
      } finally {
        stop();
        dispose();
        await act(async () => {
          response.resolve({ owner: 'newer-owner' });
          credential.resolve({ data: null, error: null });
          await Promise.allSettled(
            [original, newer, transport].filter((value) => value !== undefined)
          );
        });
      }
      await expect(newer).resolves.toEqual({ ok: true });
    }
  );

  it('checks the original run before initial community invalidation after extension retirement reentry', async () => {
    const h = harness();
    queries.push(h.query);
    const credential = deferred<{ data: null; error: null }>();
    vi.mocked(h.client.signIn.email).mockReturnValueOnce(credential.promise);
    const key = ['communities', 'newer-after-extension-retirement'];
    let newer: Promise<AuthActionResult> | undefined;
    const dispose = registerExtensionLoadOwner(
      {},
      getExtensionLoadAdmission(),
      () => {
        newer = run(h, 'signIn');
        const authority = getCommunityAuthority();
        expect(confirmCommunityAuthority(authority.epoch, 'newer-owner')).toBe(true);
        h.query.setQueryData(key, { owner: 'newer-owner' });
        return true;
      },
      async () => {}
    );
    let original!: Promise<AuthActionResult>;
    try {
      act(() => {
        original = run(h, 'signOut');
      });
      await act(async () => {
        expect(await original).toMatchObject({ error: { code: 'AUTH_SUPERSEDED' } });
      });
      expect(h.query.getQueryData(key)).toEqual({ owner: 'newer-owner' });
      expect(getCommunityAuthority().ownerKey).toBe('newer-owner');
      expect(h.client.signOut).not.toHaveBeenCalled();
      expect(h.client.signIn.email).toHaveBeenCalledOnce();
    } finally {
      dispose();
      await act(async () => {
        credential.resolve({ data: null, error: null });
        await Promise.allSettled([original, newer].filter((value) => value !== undefined));
      });
    }
    await expect(newer).resolves.toEqual({ ok: true });
  });

  it.each([
    'start-cancel',
    'start-remove',
    'credential-invalidate',
    'sign-out-set',
    'sign-out-remove',
    'sign-out-invalidate',
  ] as const)(
    'guards the original query effect after captured %s getter reenters newer auth',
    async (phase) => {
      const h = harness();
      queries.push(h.query);
      const credential = deferred<{ data: null; error: null }>();
      const port = phase.endsWith('invalidate')
        ? 'invalidateQueries'
        : phase.endsWith('set')
          ? 'setQueryData'
          : phase.endsWith('cancel')
            ? 'cancelQueries'
            : 'removeQueries';
      const originalMethod = h.query[port];
      const setData = h.query.setQueryData;
      const effect = vi.fn((...args: unknown[]) => Reflect.apply(originalMethod, h.query, args));
      const kind = phase === 'credential-invalidate' ? 'signIn' : 'signOut';
      const communityKey = ['communities', 'newer-getter-owner'];
      let newer: Promise<AuthActionResult> | undefined;
      let entered = false;
      // removeQueries also runs during startRun; only the later boot-cache sweep reenters.
      let lookups = 0;
      Object.defineProperty(h.query, port, {
        configurable: true,
        get: () => {
          lookups++;
          const finishLookup = phase === 'start-remove' || port !== 'removeQueries' || lookups > 1;
          if (!entered && finishLookup) {
            entered = true;
            vi.mocked(h.client.signIn.email).mockReturnValueOnce(credential.promise);
            newer = run(h, 'signIn');
            Reflect.apply(setData, h.query, [communityKey, { owner: 'newer-owner' }]);
            Reflect.apply(setData, h.query, [['auth', 'session'], { user: { id: 'newer-owner' } }]);
            effect.mockClear();
          }
          return effect;
        },
      });
      let original!: Promise<AuthActionResult>;
      try {
        act(() => {
          original = run(h, kind);
        });
        await act(async () => {
          expect(await original).toMatchObject({ error: { code: 'AUTH_SUPERSEDED' } });
        });
        expect(entered).toBe(true);
        expect(effect).not.toHaveBeenCalled();
        expect(h.query.getQueryData(communityKey)).toEqual({ owner: 'newer-owner' });
        expect(h.query.getQueryData(['auth', 'session'])).toEqual({ user: { id: 'newer-owner' } });
      } finally {
        Reflect.deleteProperty(h.query, port);
        await act(async () => {
          credential.resolve({ data: null, error: null });
          await Promise.allSettled([original, newer].filter((value) => value !== undefined));
        });
      }
      await expect(newer).resolves.toEqual({ ok: true });
    }
  );

  // Sticky uncertainty is deliberately last; no test-only reset or forged token clears it.
  it('healthy credentials cannot heal an actual registered-page cleanup failure', async () => {
    const page = registerPageOwner(true);
    const h = harness();
    queries.push(h.query);
    await act(async () => {
      expect(await run(h, 'signIn')).toMatchObject({ error: { code: 'AUTH_SUPERSEDED' } });
    });
    expect(page.retired).toHaveBeenCalledOnce();
    expect(useExtensionRegistry.getState().slots.pages).toHaveLength(0);
    expect(getExtensionLoadAdmission()).toMatchObject({ suspended: true, retirementFailed: true });
    await requestExtensionRemount();
    expect(page.remount).not.toHaveBeenCalled();
  });
});
