/**
 * @vitest-environment jsdom
 */
import { createContext, useContext, type ReactNode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { createMockTransport } from '@dorkos/test-utils';
import type { ServerConfig } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';

import { onboardingStageSearchSchema } from '../model/onboarding-stage';
import { useOnboarding } from '../model/use-onboarding';
import { useClearOnboardingStageWhenDone } from '../model/use-onboarding-stage';

// ── Router harness (mirrors use-dialog-deep-link.test) ───────
const HookSlotContext = createContext<ReactNode>(null);

function HookSlot() {
  return <>{useContext(HookSlotContext)}</>;
}

function buildHarness(initialUrl = '/') {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(onboardingStageSearchSchema),
    component: HookSlot,
  });
  const routeTree = rootRoute.addChildren([indexRoute]);
  const history = createMemoryHistory({ initialEntries: [initialUrl] });
  const router = createRouter({ routeTree, history });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <HookSlotContext.Provider value={children}>
        <RouterProvider router={router} />
      </HookSlotContext.Provider>
    );
  }
  const readStage = () => (router.state.location.search as { onboarding?: string }).onboarding;
  const waitForRouterReady = () => waitFor(() => expect(router.state.status).toBe('idle'));

  return { router, Wrapper, readStage, waitForRouterReady };
}

describe('useClearOnboardingStageWhenDone', () => {
  let harness: ReturnType<typeof buildHarness>;

  beforeEach(() => {
    harness = buildHarness('/?onboarding=requirements');
  });

  it('leaves the stage param in place while onboarding is not done', async () => {
    renderHook(() => useClearOnboardingStageWhenDone(false), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    // Give any (unwanted) navigation a chance to flush, then assert it stayed.
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.readStage()).toBe('requirements');
  });

  it('strips the stage param once onboarding is done', async () => {
    renderHook(() => useClearOnboardingStageWhenDone(true), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    await waitFor(() => expect(harness.readStage()).toBeUndefined());
  });

  it('is a no-op when there is no stage param to strip', async () => {
    harness = buildHarness('/');
    renderHook(() => useClearOnboardingStageWhenDone(true), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    expect(harness.readStage()).toBeUndefined();
  });
});

// ── Config-loading survival race ─────────────────────────────
//
// This pins the guarantee that a fresh user's stage param survives the window
// where `useOnboarding` is still loading config (and falls back to DEFAULT_STATE,
// which reads as not-done). If that loading default ever changed to read as
// "done", the strip would fire mid-load and wipe the param before the overlay
// could restore the stage — this test would catch it.

/** A minimal promise you resolve by hand, to hold config in the loading state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Drives the real useOnboarding + strip hook, as the app shell wires them. */
function StripProbe() {
  const { isOnboardingComplete, isOnboardingDismissed } = useOnboarding();
  useClearOnboardingStageWhenDone(isOnboardingComplete || isOnboardingDismissed);
  return null;
}

describe('onboarding stage param — config-loading survival race', () => {
  function buildLoadingHarness(getConfig: () => Promise<ServerConfig>) {
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      validateSearch: zodValidator(onboardingStageSearchSchema),
      component: HookSlot,
    });
    const routeTree = rootRoute.addChildren([indexRoute]);
    const history = createMemoryHistory({ initialEntries: ['/?onboarding=welcome'] });
    const router = createRouter({ routeTree, history });
    const transport = createMockTransport({ getConfig: vi.fn(getConfig) });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <HookSlotContext.Provider value={children}>
              <RouterProvider router={router} />
            </HookSlotContext.Provider>
          </TransportProvider>
        </QueryClientProvider>
      );
    }
    const readStage = () => (router.state.location.search as { onboarding?: string }).onboarding;
    return { router, Wrapper, readStage };
  }

  it('keeps the param while config loads, then strips once it resolves to done', async () => {
    const config = deferred<ServerConfig>();
    const harness = buildLoadingHarness(() => config.promise);
    render(<StripProbe />, { wrapper: harness.Wrapper });

    // Config still pending → useOnboarding falls back to DEFAULT_STATE (not
    // done). Let effects flush, then assert the param survived the load window.
    await waitFor(() => expect(harness.router.state.status).toBe('idle'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.readStage()).toBe('welcome');

    // Resolve config as completed → done → the param is stripped. Only the
    // `onboarding` block matters to this hook, so cast a partial config.
    await act(async () => {
      config.resolve({
        onboarding: {
          completedSteps: [],
          skippedSteps: [],
          startedAt: null,
          dismissedAt: null,
          completedAt: new Date().toISOString(),
        },
      } as unknown as ServerConfig);
    });
    await waitFor(() => expect(harness.readStage()).toBeUndefined());
  });
});
