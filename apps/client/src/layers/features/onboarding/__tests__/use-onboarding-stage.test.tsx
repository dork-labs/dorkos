/**
 * @vitest-environment jsdom
 */
import { createContext, useContext, type ReactNode } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';

import { onboardingStageSearchSchema } from '../model/onboarding-stage';
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
