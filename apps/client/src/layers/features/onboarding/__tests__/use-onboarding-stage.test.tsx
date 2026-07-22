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

import { onboardingStageSearchSchema, type OnboardingStage } from '../model/onboarding-stage';
import { useOnboarding } from '../model/use-onboarding';
import { useClearOnboardingStageWhenDone, useOnboardingStage } from '../model/use-onboarding-stage';

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
    renderHook(() => useClearOnboardingStageWhenDone({ done: false, overlayVisible: false }), {
      wrapper: harness.Wrapper,
    });
    await harness.waitForRouterReady();
    // Give any (unwanted) navigation a chance to flush, then assert it stayed.
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.readStage()).toBe('requirements');
  });

  it('strips the stage param once onboarding is done and the overlay has closed', async () => {
    renderHook(() => useClearOnboardingStageWhenDone({ done: true, overlayVisible: false }), {
      wrapper: harness.Wrapper,
    });
    await harness.waitForRouterReady();
    await waitFor(() => expect(harness.readStage()).toBeUndefined());
  });

  it('is a no-op when there is no stage param to strip', async () => {
    harness = buildHarness('/');
    renderHook(() => useClearOnboardingStageWhenDone({ done: true, overlayVisible: false }), {
      wrapper: harness.Wrapper,
    });
    await harness.waitForRouterReady();
    expect(harness.readStage()).toBeUndefined();
  });

  // ── Mid-flow strip guard (the reproduced regression) ─────────
  //
  // The conversation writes `completedAt` at its handoff beat (so a dissolve
  // into the real session is durable), flipping `done` true while the overlay is
  // deliberately still latched open. Stripping the param then would rewind the
  // derived stage to `welcome` and destroy the in-progress conversation. These
  // probe the real derivation + strip together, as the app shell wires them.

  /** Drives the derived stage and the strip hook together, mirroring AppShell. */
  function useStageStripProbe(input: { done: boolean; overlayVisible: boolean }): OnboardingStage {
    const { stage } = useOnboardingStage();
    useClearOnboardingStageWhenDone(input);
    return stage;
  }

  it('keeps the param and holds the conversation stage while the overlay is open and done flips true', async () => {
    harness = buildHarness('/?onboarding=conversation');
    const { result } = renderHook(() => useStageStripProbe({ done: true, overlayVisible: true }), {
      wrapper: harness.Wrapper,
    });
    await harness.waitForRouterReady();
    // Let any (unwanted) strip navigation flush, then assert nothing rewound.
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.readStage()).toBe('conversation');
    expect(result.current).toBe('conversation');
  });

  it('strips the param once the overlay closes (dissolve/skip), after holding it open', async () => {
    harness = buildHarness('/?onboarding=conversation');
    const { result, rerender } = renderHook(
      ({ overlayVisible }: { overlayVisible: boolean }) =>
        useStageStripProbe({ done: true, overlayVisible }),
      { wrapper: harness.Wrapper, initialProps: { overlayVisible: true } }
    );
    await harness.waitForRouterReady();
    await new Promise((r) => setTimeout(r, 0));
    // Held open: the param and stage survive the mid-flow `completedAt` write.
    expect(harness.readStage()).toBe('conversation');
    expect(result.current).toBe('conversation');

    // Overlay closes (first-message dissolve or Skip setup) → param is stripped.
    rerender({ overlayVisible: false });
    await waitFor(() => expect(harness.readStage()).toBeUndefined());
  });

  it('strips a deep-linked param for a completed user when the overlay is not showing', async () => {
    harness = buildHarness('/?onboarding=conversation');
    renderHook(() => useClearOnboardingStageWhenDone({ done: true, overlayVisible: false }), {
      wrapper: harness.Wrapper,
    });
    await harness.waitForRouterReady();
    await waitFor(() => expect(harness.readStage()).toBeUndefined());
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
  // The overlay is not mounted in this harness, so it is never showing.
  useClearOnboardingStageWhenDone({
    done: isOnboardingComplete || isOnboardingDismissed,
    overlayVisible: false,
  });
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
