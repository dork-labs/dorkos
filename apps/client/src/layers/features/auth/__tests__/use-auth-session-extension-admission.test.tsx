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
  requestExtensionRemount,
  resumeExtensionLoads,
  setAuthRequired,
} from '@/layers/shared/lib';
import { createInitialSlots, useAppStore, useExtensionRegistry } from '@/layers/shared/model';
import { createExtensionAPI } from '@/layers/features/extensions/model/extension-api-factory';
import type { ExtensionAPIDeps } from '@/layers/features/extensions/model/types';
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
