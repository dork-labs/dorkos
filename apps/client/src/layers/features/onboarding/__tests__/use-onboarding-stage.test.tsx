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

// These tests spin a real router + `renderHook` and chain several router-driven
// waits. Under CI's saturated runner a single slow-but-correct wait can approach
// its own budget, so the sum of the internal `waitFor`s must sit comfortably
// UNDER the per-test ceiling — otherwise a slow wait trips vitest's 5000ms
// default test timeout and the whole test fails as "timed out" even though the
// anchor fired. Internal waits are kept at ~2000ms; the per-test ceiling is
// raised well past their sum so a slow run finishes instead of tripping the
// ceiling (DOR-1431 flake, #1241).
vi.setConfig({ testTimeout: 15000 });

// ── Router harness (mirrors use-dialog-deep-link.test) ───────
const HookSlotContext = createContext<ReactNode>(null);

function HookSlot() {
  return <>{useContext(HookSlotContext)}</>;
}

function buildHarness(initialUrl = '/') {
  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });
  const indexRoute = createRoute({
    staticData: { header: null },
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
  // ~2000ms budget for the router-idle wait: comfortably above what a healthy
  // run needs, well below the per-test ceiling set at the top of this file. See
  // that note for why the two budgets are chosen together (DOR-1431 flake).
  const waitForRouterReady = () =>
    waitFor(() => expect(router.state.status).toBe('idle'), { timeout: 2000 });

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

    // Overlay closes (first-message dissolve or Skip all setup) → param is stripped.
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

// ── Initial anchor: deep links hold on a cold load (DOR-1431) ─
//
// The overlay's stage rides `?onboarding=`. A mount-only anchor effect used to
// read the param captured at first render — before the router had parsed it on a
// cold load — and rewrite a deep-linked stage back to `welcome`. The anchor now
// waits for the router to resolve and fires exactly once, so a deep link holds
// while a bare or unknown load still anchors to the first stage.

describe('useOnboardingStage — initial anchor (DOR-1431)', () => {
  it('holds a deep-linked stage instead of rewriting it to welcome', async () => {
    const harness = buildHarness('/?onboarding=requirements');
    const { result } = renderHook(() => useOnboardingStage(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    // Let any (unwanted) anchor navigation flush, then assert nothing rewound.
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.readStage()).toBe('requirements');
    expect(result.current.stage).toBe('requirements');
  });

  it('holds the conversation stage on a deep link', async () => {
    const harness = buildHarness('/?onboarding=conversation');
    const { result } = renderHook(() => useOnboardingStage(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.readStage()).toBe('conversation');
    expect(result.current.stage).toBe('conversation');
  });

  it('anchors a bare load to the first stage without adding a history entry', async () => {
    const harness = buildHarness('/');
    const lengthBefore = harness.router.history.length;
    const { result } = renderHook(() => useOnboardingStage(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    await waitFor(() => expect(harness.readStage()).toBe('welcome'), { timeout: 2000 });
    expect(result.current.stage).toBe('welcome');
    // `replace`, not push: initialization must not leave a history entry that
    // Back could land on before the app.
    expect(harness.router.history.length).toBe(lengthBefore);
  });

  it('anchors an unknown stage value to the first stage', async () => {
    // A value that is NOT a member of ONBOARDING_STAGES — `.catch(undefined)`
    // drops it to "no stage" and the anchor pins the first stage. Deliberately
    // NOT a real stage name: a valid value correctly HOLDS (the anchor never
    // fires), so this wait would hang. (`power` became a real stage on main, so
    // once this branch rebases it must remain a genuinely-unknown value here.)
    const harness = buildHarness('/?onboarding=not-a-real-stage');
    const { result } = renderHook(() => useOnboardingStage(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    await waitFor(() => expect(harness.readStage()).toBe('welcome'), { timeout: 2000 });
    expect(result.current.stage).toBe('welcome');
  });

  it('does not re-anchor once the param is cleared after onboarding ends', async () => {
    // The anchor is a one-time initialization. When onboarding finishes,
    // `useClearOnboardingStageWhenDone` strips the param; the anchor must not
    // fight that by re-adding `?onboarding=welcome`. Guards the run-once ref
    // against a naive "depend on the parsed value" fix that would re-fire.
    const harness = buildHarness('/?onboarding=welcome');
    renderHook(() => useOnboardingStage(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    expect(harness.readStage()).toBe('welcome');

    // Simulate the end-of-onboarding strip (a real navigation that clears it).
    await act(async () => {
      await harness.router.navigate({ to: '/', search: {} });
    });
    await harness.waitForRouterReady();
    // Let any (unwanted) re-anchor flush, then assert it stayed cleared.
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.readStage()).toBeUndefined();
  });
});

// ── History-integrated stage navigation ──────────────────────
//
// Stage moves ride real history entries so browser Back/Forward and the in-UI
// Back walk the same path. `goBack` pops an in-app forward push, but falls back
// to pushing a stage when the user landed on a later stage directly.

describe('useOnboardingStage — navigation', () => {
  it('goToStage pushes a history entry and moves the derived stage forward', async () => {
    const harness = buildHarness('/');
    const lengthBefore = harness.router.history.length;
    const { result } = renderHook(() => useOnboardingStage(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    await waitFor(() => expect(harness.readStage()).toBe('welcome'), { timeout: 2000 });

    await act(async () => {
      result.current.goToStage('requirements');
    });
    await harness.waitForRouterReady();
    expect(harness.readStage()).toBe('requirements');
    expect(result.current.stage).toBe('requirements');
    // A push, so Back can return — the anchor above was a replace (no entry).
    expect(harness.router.history.length).toBe(lengthBefore + 1);
  });

  it('goBack pops the forward push after an in-app step', async () => {
    const harness = buildHarness('/');
    const { result } = renderHook(() => useOnboardingStage(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    await waitFor(() => expect(harness.readStage()).toBe('welcome'), { timeout: 2000 });

    await act(async () => {
      result.current.goToStage('requirements');
    });
    await harness.waitForRouterReady();
    expect(harness.readStage()).toBe('requirements');
    const lengthAfterForward = harness.router.history.length;

    await act(async () => {
      result.current.goBack('welcome');
    });
    await harness.waitForRouterReady();
    expect(harness.readStage()).toBe('welcome');
    expect(result.current.stage).toBe('welcome');
    // Discriminates a real pop from a push-fallback — both land on 'welcome', so
    // the stage alone cannot tell them apart. A history pop moves the index and
    // keeps the entry count; pushing the fallback would ADD an entry. Without
    // `pushedSinceMount`, goBack would push here and this length would grow.
    expect(harness.router.history.length).toBe(lengthAfterForward);
  });

  it('goBack pushes the fallback on a deep-link landing with nothing to pop', async () => {
    const harness = buildHarness('/?onboarding=conversation');
    const { result } = renderHook(() => useOnboardingStage(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    expect(harness.readStage()).toBe('conversation');

    await act(async () => {
      result.current.goBack('requirements');
    });
    await harness.waitForRouterReady();
    expect(harness.readStage()).toBe('requirements');
    expect(result.current.stage).toBe('requirements');
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
    const rootRoute = createRootRoute({
      staticData: { header: null },
      component: () => <Outlet />,
    });
    const indexRoute = createRoute({
      staticData: { header: null },
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

// ── The power stage is URL-synced and refresh-safe ───────────
//
// Adding `'power'` to ONBOARDING_STAGES makes it a member of the search enum for
// free, so `?onboarding=power` validates, derives, and round-trips like every
// other stage. These pin that so a future schema change cannot silently drop it.
describe('useOnboardingStage — the power stage', () => {
  it('derives the power stage from `?onboarding=power` (refresh-safe)', async () => {
    const harness = buildHarness('/?onboarding=power');
    const { result } = renderHook(() => useOnboardingStage(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    expect(result.current.stage).toBe('power');
    // The param is left exactly as the URL carried it — nothing rewrote it.
    expect(harness.readStage()).toBe('power');
  });

  it('round-trips through the URL when navigated to', async () => {
    const harness = buildHarness('/?onboarding=requirements');
    const { result } = renderHook(() => useOnboardingStage(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    act(() => result.current.goToStage('power'));

    await waitFor(() => expect(harness.readStage()).toBe('power'));
    expect(result.current.stage).toBe('power');
  });
});
