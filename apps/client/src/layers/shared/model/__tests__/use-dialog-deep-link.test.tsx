/**
 * @vitest-environment jsdom
 */
import { createContext, useContext, type ReactNode } from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
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

import { mergeDialogSearch } from '../dialog-search-schema';
import { useAppStore } from '../app-store';
import {
  useSettingsDeepLink,
  useTasksDeepLink,
  useProfileDeepLink,
  useOpenConnections,
  resolveDeepLinkTarget,
  takeProfileOpener,
  clearProfileOpener,
  type SettingsRouteTarget,
} from '../use-dialog-deep-link';
import type { SettingsTab } from '../app-store/app-store-panels';

// ── Tiny test router builder ───────────────────────────────── Mounts a single index route at
// `/` whose `validateSearch` is the merged dialog schema, so the deep-link hooks (which call
// `useSearch({ strict: false })`) see the same shape they would on a real route in `router.tsx`.
const testSearchSchema = mergeDialogSearch(z.object({}));

const HookSlotContext = createContext<ReactNode>(null);

function HookSlot() {
  return <>{useContext(HookSlotContext)}</>;
}

type HistoryActionType = 'PUSH' | 'REPLACE' | 'GO' | 'FORWARD' | 'BACK';
type SearchRecord = Record<string, unknown>;

function buildHarness(initialUrl = '/') {
  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });

  const indexRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(testSearchSchema),
    component: HookSlot,
  });

  const connectionsRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/connections',
    validateSearch: zodValidator(testSearchSchema),
    component: HookSlot,
  });

  const routeTree = rootRoute.addChildren([indexRoute, connectionsRoute]);
  const history = createMemoryHistory({ initialEntries: [initialUrl] });
  const router = createRouter({ routeTree, history });

  const actions: HistoryActionType[] = [];
  history.subscribe(({ action }) => {
    actions.push(action.type);
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <HookSlotContext.Provider value={children}>
        <RouterProvider router={router} />
      </HookSlotContext.Provider>
    );
  }

  function readPathname(): string {
    return router.state.location.pathname;
  }

  function readSearch(): SearchRecord {
    return router.state.location.search as SearchRecord;
  }

  /** Wait until the router has finished loading the initial location. */
  async function waitForRouterReady(): Promise<void> {
    await waitFor(() => {
      expect(router.state.status).toBe('idle');
    });
  }

  return { router, actions, Wrapper, readSearch, readPathname, waitForRouterReady };
}

type RouterTestHarness = ReturnType<typeof buildHarness>;

// The app store is a module singleton, and `close()` now writes to it — reset the dialog flags so
// one test's open dialog cannot leak into the next.
beforeEach(() => {
  useAppStore.getState().setSettingsOpen(false);
  useAppStore.getState().setTasksOpen(false);
  useAppStore.getState().setProfileOpen(false);
  clearProfileOpener();
});

// ───────────────────────────────────────────────────────────── resolveDeepLinkTarget — the
// route-capable resolution model (DOR-854)
// ───────────────────────────────────────────────────────────── `useSettingsDeepLink` calls this
// against the real production map.
describe('resolveDeepLinkTarget', () => {
  const tabOnlyMap: Record<string, SettingsTab | SettingsRouteTarget> = {
    channels: 'integrations',
  };

  it('migrates a legacy id mapped to another tab id (channels → integrations)', () => {
    expect(resolveDeepLinkTarget('channels', tabOnlyMap)).toEqual({
      kind: 'tab',
      tab: 'integrations',
    });
  });

  // A plain `legacyMap[raw]` index also returns inherited Object.prototype members for ids like
  // `constructor`, `toString`, `hasOwnProperty` — those would resolve to a function typed as
  // SettingsDeepLinkTarget instead of falling through to the plain-tab case.
  it('does not resolve prototype-inherited keys as legacy map entries', () => {
    expect(resolveDeepLinkTarget('constructor', tabOnlyMap)).toEqual({
      kind: 'tab',
      tab: 'constructor',
    });
    expect(resolveDeepLinkTarget('toString', tabOnlyMap)).toEqual({
      kind: 'tab',
      tab: 'toString',
    });
    expect(resolveDeepLinkTarget('hasOwnProperty', tabOnlyMap)).toEqual({
      kind: 'tab',
      tab: 'hasOwnProperty',
    });
  });
});

// ───────────────────────────────────────────────────────────── useSettingsDeepLink
// ─────────────────────────────────────────────────────────────
describe('useSettingsDeepLink', () => {
  let harness: RouterTestHarness;

  beforeEach(() => {
    harness = buildHarness('/');
  });

  it('returns isOpen=false when no settings param', async () => {
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    expect(result.current.isOpen).toBe(false);
    expect(result.current.activeTab).toBeNull();
    expect(result.current.section).toBeNull();
  });

  it.each(['channels', 'integrations'])(
    'sends the retired settings=%s bookmark to the Connections page',
    async (retiredId) => {
      harness = buildHarness(`/?settings=${retiredId}`);
      renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
      await harness.waitForRouterReady();

      await waitFor(() => {
        expect(harness.readPathname()).toBe('/connections');
      });
    }
  );

  it('does not flash the Settings dialog open on the way to the page', async () => {
    harness = buildHarness('/?settings=integrations');
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    // A link whose destination left the dialog should never read as "the
    // dialog is open" — that is a visible flicker on every retired bookmark.
    expect(result.current.isOpen).toBe(false);
    expect(result.current.activeTab).toBeNull();
  });

  it('sends the retired settings=access link to the DorkOS account tab', async () => {
    harness = buildHarness('/?settings=access');
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    expect(result.current.isOpen).toBe(true);
    expect(result.current.activeTab).toBe('account');
  });

  it('open() with no args sets settings=open', async () => {
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    await act(async () => {
      result.current.open();
    });
    await waitFor(() => {
      expect(harness.readSearch().settings).toBe('open');
    });
  });

  it('close() clears both settings and settingsSection', async () => {
    harness = buildHarness('/?settings=tools&settingsSection=external-mcp');
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    await act(async () => {
      result.current.close();
    });
    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.settings).toBeUndefined();
      expect(search.settingsSection).toBeUndefined();
    });
  });
});

// ───────────────────────────────────────────────────────────── useTasksDeepLink
// ─────────────────────────────────────────────────────────────
describe('useTasksDeepLink', () => {
  const cases = [{ name: 'tasks' as const, hook: useTasksDeepLink }];

  for (const { name, hook } of cases) {
    describe(`use${name[0]!.toUpperCase()}${name.slice(1)}DeepLink`, () => {
      it('opens via param=open', async () => {
        const harness = buildHarness('/');
        const { result } = renderHook(() => hook(), { wrapper: harness.Wrapper });
        await harness.waitForRouterReady();

        await act(async () => {
          result.current.open();
        });

        await waitFor(() => {
          expect(harness.readSearch()[name]).toBe('open');
        });
      });

      it('close clears the param', async () => {
        const harness = buildHarness(`/?${name}=open`);
        const { result } = renderHook(() => hook(), { wrapper: harness.Wrapper });
        await harness.waitForRouterReady();

        await act(async () => {
          result.current.close();
        });

        await waitFor(() => {
          expect(harness.readSearch()[name]).toBeUndefined();
        });
      });
    });
  }
});

// ───────────────────────────────────────────────────────────── useProfileDeepLink — the profile
// drawer's address ───────────────────────────────────────────────────────────── The one deep
// link that carries a *subject* rather than a tab: `?profile=<id>` names whose profile is open,
// which is what makes a profile shareable.
describe('useProfileDeepLink', () => {
  it('is closed, and names nobody, with no profile param', async () => {
    const harness = buildHarness('/');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    expect(result.current.isOpen).toBe(false);
    expect(result.current.memberId).toBeNull();
  });

  it('open(id) pushes a history entry, so the phone’s back gesture dismisses it', async () => {
    const harness = buildHarness('/');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    harness.actions.length = 0;

    await act(async () => {
      result.current.open('person-dorian');
    });

    await waitFor(() => {
      expect(harness.readSearch().profile).toBe('person-dorian');
    });
    // A REPLACE here would leave nothing to go back to — the back gesture would leave the page
    // instead of closing the drawer, which is the whole reason this state lives in the URL.
    expect(harness.actions).toContain('PUSH');
  });

  it('setPage(page) pushes, so Back closes the page rather than the profile', async () => {
    const harness = buildHarness('/?profile=agent-warden');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    harness.actions.length = 0;

    await act(async () => {
      result.current.setPage('manages');
    });

    await waitFor(() => {
      expect(harness.readSearch().profilePage).toBe('manages');
    });
    expect(harness.actions).toContain('PUSH');
  });

  it('leaves every other dialog’s params alone', async () => {
    const harness = buildHarness(
      '/?settings=tools&settingsSection=external-mcp&profile=agent-warden'
    );
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await act(async () => {
      result.current.close();
    });

    await waitFor(() => {
      expect(harness.readSearch().profile).toBeUndefined();
    });
    // Adding a param to the shared dialog schema must not turn every other
    // deep link into collateral damage.
    expect(harness.readSearch().settings).toBe('tools');
    expect(harness.readSearch().settingsSection).toBe('external-mcp');
  });
});

// ───────────────────────────────────────────────────────────── The profile opener capture
// (DOR-1274, hardened by adversarial review)
// ───────────────────────────────────────────────────────────── `ProfileSheet`'s
// `onCloseAutoFocus` consumes this through `takeProfileOpener` directly, so the
describe('the profile opener capture', () => {
  /** A real, focusable node in the document — `document.activeElement` needs one. */
  function focusableButton(): HTMLButtonElement {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    return button;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('captures the focused control on a fresh open, returned by take() for that id', async () => {
    const harness = buildHarness('/');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    const button = focusableButton();

    await act(async () => {
      result.current.open('agent-warden');
    });

    expect(takeProfileOpener('agent-warden')).toBe(button);
  });

  it('refuses a capture whose root id does not match — the stale-hijack guard', async () => {
    // The scenario the review found: a capture nobody ever consumes (the docked-link path)
    // surviving to answer for a LATER, unrelated close.
    const harness = buildHarness('/');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    focusableButton();

    await act(async () => {
      result.current.open('agent-warden');
    });

    expect(takeProfileOpener('somebody-else')).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────── useOpenConnections — the
// navigation that replaced ?relay=open
// ─────────────────────────────────────────────────────────────
describe('useOpenConnections', () => {
  it('opens one app’s side panel when asked', async () => {
    const harness = buildHarness('/');
    const { result } = renderHook(() => useOpenConnections(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await act(async () => {
      result.current({ app: 'telegram-1' });
    });

    await waitFor(() => {
      expect(harness.readPathname()).toBe('/connections');
    });
    expect(harness.readSearch().app).toBe('telegram-1');
  });
});
