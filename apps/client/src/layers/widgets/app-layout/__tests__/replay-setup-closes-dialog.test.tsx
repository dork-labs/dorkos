/**
 * @vitest-environment jsdom
 *
 * "Replay setup" has to leave the screen clear for the welcome overlay it
 * reopens (DOR-839). The bug only ever showed up on one route in: the
 * skip-setup toast's own "Replay setup" action calls
 * `useSettingsDeepLink().open('preferences')`, which opens the dialog with a
 * `?settings=preferences` URL param and no store flag at all. A close that
 * cleared the store flag therefore closed nothing.
 *
 * So these tests drive the real thing: a real router carrying the real param,
 * the real app store, the real `DialogHost` (which is what actually decides a
 * dialog is open, on `storeOpen || urlIsOpen`), and the real `PreferencesTab`.
 * Only the config mutation is stubbed.
 *
 * It lives beside `DialogHost` rather than beside `PreferencesTab` because
 * `DialogHost` is the thing that owns the open rule, and only the widgets layer
 * may import it (features cannot).
 */
import { createContext, useContext, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
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
import { z } from 'zod';

import { mergeDialogSearch, useAppStore, useExtensionRegistry, TransportProvider } from '@/layers/shared/model';
import { NavigationLayout, NavigationLayoutPanel } from '@/layers/shared/ui';
import { DialogHost } from '../ui/DialogHost';
import { PreferencesTab } from '@/layers/features/settings';

// `mutate` is referenced by the hoisted `vi.mock` factory below.
const { updateConfigMutate } = vi.hoisted(() => ({
  updateConfigMutate: vi.fn(
    (_vars: unknown, opts?: { onSuccess?: () => void }) => void opts?.onSuccess?.()
  ),
}));

// The tab writes config through `useUpdateConfig`; stubbing it keeps the test
// off the Transport without touching anything the close path uses.
vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return { ...actual, useUpdateConfig: () => ({ mutate: updateConfigMutate, isPending: false }) };
});

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

// ── The Settings dialog, reduced to the tab under test ───────
//
// Registered into the real dialog slot so `DialogHost`'s real dual-signal open
// rule decides whether it is on screen. Everything else about the dialog shell
// (tab strip, chrome, the other tabs) is irrelevant to closing it.
function SettingsUnderTest({ open }: { open: boolean }) {
  if (!open) return null;
  return (
    <NavigationLayout value="preferences" onValueChange={() => {}}>
      <NavigationLayoutPanel value="preferences">
        <PreferencesTab />
      </NavigationLayoutPanel>
    </NavigationLayout>
  );
}

// ── Router harness (same shape as use-dialog-deep-link.test) ─
const testSearchSchema = mergeDialogSearch(z.object({}));
const HookSlotContext = createContext<ReactNode>(null);

function RouteSlot() {
  return <>{useContext(HookSlotContext)}</>;
}

function buildHarness(initialUrl: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(testSearchSchema),
    component: RouteSlot,
  });
  const routeTree = rootRoute.addChildren([indexRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={new QueryClient()}>
        {/* WelcomeBackCard (Settings → Preferences) reads config through the
            transport, so the dialog tree needs a provider even though this
            suite never asserts on it. */}
        <TransportProvider transport={createMockTransport()}>
          <HookSlotContext.Provider value={children}>
            <RouterProvider router={router} />
          </HookSlotContext.Provider>
        </TransportProvider>
      </QueryClientProvider>
    );
  }

  return {
    Wrapper,
    readSettingsParam: () =>
      (router.state.location.search as { settings?: string }).settings ?? undefined,
    waitForRouterReady: () =>
      waitFor(() => {
        expect(router.state.status).toBe('idle');
      }),
  };
}

let unregisterDialog: (() => void) | null = null;

beforeEach(() => {
  updateConfigMutate.mockClear();
  useAppStore.getState().setSettingsOpen(false);
  useAppStore.getState().setOnboardingHiddenForSession(true);
  unregisterDialog = useExtensionRegistry.getState().register('dialog', {
    id: 'settings',
    component: SettingsUnderTest,
    openStateKey: 'settingsOpen',
    priority: 1,
    urlParam: 'settings',
  });
});

afterEach(() => {
  unregisterDialog?.();
  unregisterDialog = null;
  cleanup();
});

/** Render the host and wait for the router to settle. */
async function mountHost(harness: ReturnType<typeof buildHarness>) {
  render(<DialogHost />, { wrapper: harness.Wrapper });
  await harness.waitForRouterReady();
}

describe('PreferencesTab — Replay setup', () => {
  it('closes the dialog opened by the toast deep link, clearing both signals', async () => {
    // Exactly what `openSettingsTab('preferences')` produces: URL param set,
    // store flag untouched. This is the case that shipped broken.
    const harness = buildHarness('/?settings=preferences');
    await mountHost(harness);

    const button = await screen.findByRole('button', { name: 'Replay setup' });
    expect(useAppStore.getState().settingsOpen).toBe(false);

    await userEvent.click(button);

    // The signal the URL held.
    await waitFor(() => {
      expect(harness.readSettingsParam()).toBeUndefined();
    });
    // The signal the store held.
    expect(useAppStore.getState().settingsOpen).toBe(false);
    // And the thing the user sees: no dialog left over the welcome screen.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Replay setup' })).not.toBeInTheDocument();
    });
  });

  it('closes the dialog opened by the store flag, clearing both signals', async () => {
    // The other way in — the sidebar/palette store-flag open, no URL param.
    const harness = buildHarness('/');
    useAppStore.getState().setSettingsOpen(true);
    await mountHost(harness);

    await userEvent.click(await screen.findByRole('button', { name: 'Replay setup' }));

    expect(useAppStore.getState().settingsOpen).toBe(false);
    expect(harness.readSettingsParam()).toBeUndefined();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Replay setup' })).not.toBeInTheDocument();
    });
  });

  it('restarts setup as well as closing: config reset and session flag dropped', async () => {
    const harness = buildHarness('/?settings=preferences');
    await mountHost(harness);

    await userEvent.click(await screen.findByRole('button', { name: 'Replay setup' }));

    // Closing the dialog is only half the job — the overlay has to come back.
    expect(updateConfigMutate).toHaveBeenCalledTimes(1);
    expect(updateConfigMutate.mock.calls[0]![0]).toMatchObject({
      onboarding: { completedAt: null, dismissedAt: null },
    });
    expect(useAppStore.getState().onboardingHiddenForSession).toBe(false);
  });
});
