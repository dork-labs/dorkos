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
  type SettingsDeepLinkTarget,
} from '../use-dialog-deep-link';
import type { SettingsTab } from '../app-store/app-store-panels';

// ── Tiny test router builder ─────────────────────────────────
//
// Mounts a single index route at `/` whose `validateSearch` is the merged dialog
// schema, so the deep-link hooks (which call `useSearch({ strict: false })`) see
// the same shape they would on a real route in `router.tsx`.
//
// `renderHook`'s wrapper renders a <RouterProvider>, but TanStack Router needs
// the hook callsite to live *inside* a route component (otherwise `useSearch`
// and `useNavigate` have no context). We bridge this by injecting the hook's
// children into the route component via a tiny React context.
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

  /**
   * Wait until the router has finished loading the initial location. Without this,
   * `useSearch` returns an empty object on the first render and async updates can
   * race with assertions.
   */
  async function waitForRouterReady(): Promise<void> {
    await waitFor(() => {
      expect(router.state.status).toBe('idle');
    });
  }

  return { router, actions, Wrapper, readSearch, readPathname, waitForRouterReady };
}

type RouterTestHarness = ReturnType<typeof buildHarness>;

// The app store is a module singleton, and `close()` now writes to it — reset
// the dialog flags so one test's open dialog cannot leak into the next.
// `takeProfileOpener`'s own capture is a second module singleton for the same
// reason (DOR-1274) — cleared here so a capture left over from one test's
// `open()` cannot be mistaken for another's.
beforeEach(() => {
  useAppStore.getState().setSettingsOpen(false);
  useAppStore.getState().setTasksOpen(false);
  useAppStore.getState().setProfileOpen(false);
  clearProfileOpener();
});

// ─────────────────────────────────────────────────────────────
// resolveDeepLinkTarget — the route-capable resolution model (DOR-854)
// ─────────────────────────────────────────────────────────────
//
// `useSettingsDeepLink` calls this against the real production map. These
// tests pass their own fixture maps so every branch is exercised in isolation,
// independent of which ids the production map happens to carry today.
describe('resolveDeepLinkTarget', () => {
  const tabOnlyMap: Record<string, SettingsTab | SettingsRouteTarget> = {
    channels: 'integrations',
  };

  it('returns null for an unset value', () => {
    expect(resolveDeepLinkTarget(undefined, tabOnlyMap)).toBeNull();
  });

  it('returns null for the tabless "open" sentinel', () => {
    expect(resolveDeepLinkTarget('open', tabOnlyMap)).toBeNull();
  });

  it('resolves an ordinary tab id (no map entry) to a tab target', () => {
    expect(resolveDeepLinkTarget('tools', tabOnlyMap)).toEqual({ kind: 'tab', tab: 'tools' });
  });

  it('migrates a legacy id mapped to another tab id (channels → integrations)', () => {
    expect(resolveDeepLinkTarget('channels', tabOnlyMap)).toEqual({
      kind: 'tab',
      tab: 'integrations',
    });
  });

  it('resolves an unknown id as a tab target (best-effort — the caller validates it)', () => {
    expect(resolveDeepLinkTarget('not-a-real-tab', tabOnlyMap)).toEqual({
      kind: 'tab',
      tab: 'not-a-real-tab',
    });
  });

  // A plain `legacyMap[raw]` index also returns inherited Object.prototype
  // members for ids like `constructor`, `toString`, `hasOwnProperty` — those
  // would resolve to a function typed as SettingsDeepLinkTarget instead of
  // falling through to the plain-tab case. Object.hasOwn is the guard.
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

  it('resolves a legacy id mapped to a route target unchanged', () => {
    const routeTarget: SettingsRouteTarget = {
      kind: 'route',
      path: '/connections',
      search: { region: 'messaging' },
    };
    const mapWithRoute: Record<string, SettingsTab | SettingsRouteTarget> = {
      integrations: routeTarget,
    };
    expect(resolveDeepLinkTarget('integrations', mapWithRoute)).toEqual(routeTarget);
  });

  // A merge leaves two live links per merged tab, and landing both at the top of
  // the surviving tab loses the half the link was about (DOR-1758).
  it('carries a section from a legacy id that named one half of a merged tab', () => {
    const mapWithSection: Record<string, SettingsTab | SettingsDeepLinkTarget> = {
      account: { kind: 'tab', tab: 'access', section: 'account' },
    };
    expect(resolveDeepLinkTarget('account', mapWithSection)).toEqual({
      kind: 'tab',
      tab: 'access',
      section: 'account',
    });
  });

  it('resolves a route-mapped id with no search params', () => {
    const routeTarget: SettingsRouteTarget = { kind: 'route', path: '/connections' };
    const mapWithRoute: Record<string, SettingsTab | SettingsRouteTarget> = {
      integrations: routeTarget,
    };
    const result = resolveDeepLinkTarget('integrations', mapWithRoute);
    expect(result).toEqual({ kind: 'route', path: '/connections' });
    expect((result as SettingsRouteTarget).search).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// useSettingsDeepLink
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

  it('returns isOpen=true and activeTab=null when settings=open', async () => {
    harness = buildHarness('/?settings=open');
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    expect(result.current.isOpen).toBe(true);
    expect(result.current.activeTab).toBeNull();
  });

  it('returns isOpen=true and activeTab="tools" when settings=tools', async () => {
    harness = buildHarness('/?settings=tools');
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    expect(result.current.isOpen).toBe(true);
    expect(result.current.activeTab).toBe('tools');
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
      expect(harness.readSearch().region).toBe('messaging');
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

  it('replaces the retired link rather than pushing it into history', async () => {
    harness = buildHarness('/?settings=integrations');
    renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      expect(harness.readPathname()).toBe('/connections');
    });
    // Back must not land on the dead link and bounce forward again.
    expect(harness.actions).not.toContain('PUSH');
  });

  it.each([
    ['security', 'security'],
    ['account', 'account'],
  ])(
    'lands the retired settings=%s link on the Access tab, at its own section',
    async (retiredId, section) => {
      harness = buildHarness(`/?settings=${retiredId}`);
      const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
      await harness.waitForRouterReady();

      expect(result.current.isOpen).toBe(true);
      expect(result.current.activeTab).toBe('access');
      expect(result.current.section).toBe(section);
    }
  );

  it('sends the retired settings=advanced link to the Danger zone tab', async () => {
    harness = buildHarness('/?settings=advanced');
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    expect(result.current.activeTab).toBe('danger');
    expect(result.current.section).toBeNull();
  });

  it('lets an explicit settingsSection beat the one a legacy id carries', async () => {
    harness = buildHarness('/?settings=security&settingsSection=account');
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    expect(result.current.activeTab).toBe('access');
    expect(result.current.section).toBe('account');
  });

  it('returns section when settingsSection is set', async () => {
    harness = buildHarness('/?settings=tools&settingsSection=external-mcp');
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    expect(result.current.section).toBe('external-mcp');
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

  it('open("tools") sets settings=tools', async () => {
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    await act(async () => {
      result.current.open('tools');
    });
    await waitFor(() => {
      expect(harness.readSearch().settings).toBe('tools');
    });
  });

  it('open("tools", "external-mcp") sets settings=tools and settingsSection=external-mcp', async () => {
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    await act(async () => {
      result.current.open('tools', 'external-mcp');
    });
    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.settings).toBe('tools');
      expect(search.settingsSection).toBe('external-mcp');
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

  // DOR-839. `DialogHost` renders Settings on `storeOpen || urlIsOpen`, so a
  // close that owns one half is not a close — whichever half it left behind
  // keeps the dialog on screen. Both halves genuinely hold it open here, so
  // either one going unowned turns this red. (The URL-only close is already
  // pinned by "close() clears both settings and settingsSection" above.)
  it('close() clears the store flag as well as the URL, when both hold it open', async () => {
    harness = buildHarness('/?settings=preferences');
    useAppStore.getState().setSettingsOpen(true);
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await act(async () => {
      result.current.close();
    });

    await waitFor(() => {
      expect(harness.readSearch().settings).toBeUndefined();
    });
    expect(useAppStore.getState().settingsOpen).toBe(false);
  });

  it('setTab() updates settings via replace (no new history entry)', async () => {
    harness = buildHarness('/?settings=tools');
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    // Drain any actions emitted during the initial mount.
    harness.actions.length = 0;

    await act(async () => {
      result.current.setTab('appearance');
    });

    await waitFor(() => {
      expect(harness.readSearch().settings).toBe('appearance');
    });
    // The only history action triggered by setTab should be a REPLACE — never a PUSH.
    expect(harness.actions).toContain('REPLACE');
    expect(harness.actions).not.toContain('PUSH');
  });

  it('setSection() updates settingsSection via replace', async () => {
    harness = buildHarness('/?settings=tools');
    const { result } = renderHook(() => useSettingsDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    harness.actions.length = 0;

    await act(async () => {
      result.current.setSection('mcp');
    });

    await waitFor(() => {
      expect(harness.readSearch().settingsSection).toBe('mcp');
    });
    expect(harness.actions).toContain('REPLACE');
    expect(harness.actions).not.toContain('PUSH');
  });
});

// ─────────────────────────────────────────────────────────────
// useTasksDeepLink
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

      it('isOpen reads from corresponding param', async () => {
        const harness = buildHarness(`/?${name}=open`);
        const { result } = renderHook(() => hook(), { wrapper: harness.Wrapper });
        await harness.waitForRouterReady();
        expect(result.current.isOpen).toBe(true);
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

      // Same dual-signal rule as Settings (DOR-839).
      it('close clears the store flag too', async () => {
        const harness = buildHarness(`/?${name}=open`);
        useAppStore.getState().setTasksOpen(true);
        const { result } = renderHook(() => hook(), { wrapper: harness.Wrapper });
        await harness.waitForRouterReady();

        await act(async () => {
          result.current.close();
        });

        await waitFor(() => {
          expect(harness.readSearch()[name]).toBeUndefined();
        });
        expect(useAppStore.getState().tasksOpen).toBe(false);
      });
    });
  }
});

// ─────────────────────────────────────────────────────────────
// useProfileDeepLink — the profile drawer's address
// ─────────────────────────────────────────────────────────────
//
// The one deep link that carries a *subject* rather than a tab: `?profile=<id>`
// names whose profile is open, which is what makes a profile shareable.
describe('useProfileDeepLink', () => {
  it('is closed, and names nobody, with no profile param', async () => {
    const harness = buildHarness('/');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    expect(result.current.isOpen).toBe(false);
    expect(result.current.memberId).toBeNull();
  });

  it('reads the member id straight off the URL', async () => {
    const harness = buildHarness('/?profile=agent-warden');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    expect(result.current.isOpen).toBe(true);
    expect(result.current.memberId).toBe('agent-warden');
  });

  it('open(id) writes that id to the URL', async () => {
    const harness = buildHarness('/');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await act(async () => {
      result.current.open('person-dorian');
    });

    await waitFor(() => {
      expect(harness.readSearch().profile).toBe('person-dorian');
    });
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
    // A REPLACE here would leave nothing to go back to — the back gesture would
    // leave the page instead of closing the drawer, which is the whole reason
    // this state lives in the URL.
    expect(harness.actions).toContain('PUSH');
  });

  it('switching subject keeps one entry per profile', async () => {
    const harness = buildHarness('/?profile=person-dorian');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await act(async () => {
      result.current.open('agent-warden');
    });

    await waitFor(() => {
      expect(harness.readSearch().profile).toBe('agent-warden');
    });
  });

  it('close() clears the param', async () => {
    const harness = buildHarness('/?profile=agent-warden');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await act(async () => {
      result.current.close();
    });

    await waitFor(() => {
      expect(harness.readSearch().profile).toBeUndefined();
    });
    expect(result.current.isOpen).toBe(false);
  });

  // Same dual-signal rule as Settings and Tasks (DOR-839): `DialogHost` renders
  // on `storeOpen || urlIsOpen`, so a close that owns one half is not a close.
  it('close() clears the store half too, when both hold it open', async () => {
    const harness = buildHarness('/?profile=agent-warden');
    useAppStore.getState().openProfileForMember('agent-warden');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await act(async () => {
      result.current.close();
    });

    await waitFor(() => {
      expect(harness.readSearch().profile).toBeUndefined();
    });
    expect(useAppStore.getState().profileOpen).toBe(false);
    expect(useAppStore.getState().profileMemberId).toBeNull();
  });

  // ── the pushed page (`?profilePage=`, spec `profile-unification` §1.6) ──
  //
  // A page of a profile is an address too, so a link can land on Sessions and a
  // reload comes back to it.
  it('reads the pushed page off the URL, and none when there is none', async () => {
    const withPage = buildHarness('/?profile=agent-warden&profilePage=manages');
    const rendered = renderHook(() => useProfileDeepLink(), { wrapper: withPage.Wrapper });
    await withPage.waitForRouterReady();
    expect(rendered.result.current.page).toBe('manages');

    const withoutPage = buildHarness('/?profile=agent-warden');
    const plain = renderHook(() => useProfileDeepLink(), { wrapper: withoutPage.Wrapper });
    await withoutPage.waitForRouterReady();
    expect(plain.result.current.page).toBeNull();
  });

  it('open(id, page) lands straight on that page', async () => {
    const harness = buildHarness('/');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await act(async () => {
      result.current.open('person-dorian', 'manages');
    });

    await waitFor(() => {
      expect(harness.readSearch().profilePage).toBe('manages');
    });
    expect(harness.readSearch().profile).toBe('person-dorian');
  });

  it('open(id) on a new subject drops the page the last one was on', async () => {
    // Pages belong to a profile, not to the panel. Carrying `manages` across to
    // an agent that has no such page is a link to nowhere.
    const harness = buildHarness('/?profile=person-dorian&profilePage=manages');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await act(async () => {
      result.current.open('agent-warden');
    });

    await waitFor(() => {
      expect(harness.readSearch().profile).toBe('agent-warden');
    });
    expect(harness.readSearch().profilePage).toBeUndefined();
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

  it('setPage(null) replaces, so the profile does not stack up against itself', async () => {
    const harness = buildHarness('/?profile=agent-warden&profilePage=manages');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    harness.actions.length = 0;

    await act(async () => {
      result.current.setPage(null);
    });

    await waitFor(() => {
      expect(harness.readSearch().profilePage).toBeUndefined();
    });
    expect(harness.readSearch().profile).toBe('agent-warden');
    expect(harness.actions).toContain('REPLACE');
    expect(harness.actions).not.toContain('PUSH');
  });

  it('close() clears the page along with the subject', async () => {
    const harness = buildHarness('/?profile=agent-warden&profilePage=manages');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await act(async () => {
      result.current.close();
    });

    await waitFor(() => {
      expect(harness.readSearch().profile).toBeUndefined();
    });
    // A page left on the URL with nobody's profile open is a param that reopens
    // nothing and confuses the next link that lands here.
    expect(harness.readSearch().profilePage).toBeUndefined();
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

// ─────────────────────────────────────────────────────────────
// The profile opener capture (DOR-1274, hardened by adversarial review)
// ─────────────────────────────────────────────────────────────
//
// `ProfileSheet`'s `onCloseAutoFocus` consumes this through `takeProfileOpener`
// directly, so the capture/take/clear contract is worth pinning at this level
// rather than only through the full sheet — a mismatch here is exactly what
// let a stale, never-consumed capture (the docked-link path never mounts a
// real sheet) hijack a LATER, unrelated close.
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
    // The scenario the review found: a capture nobody ever consumes (the
    // docked-link path) surviving to answer for a LATER, unrelated close.
    // Asking for the wrong id is the direct pin on that refusal.
    const harness = buildHarness('/');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    focusableButton();

    await act(async () => {
      result.current.open('agent-warden');
    });

    expect(takeProfileOpener('somebody-else')).toBeNull();
  });

  it('is consumed exactly once — asking again for the same id gets nothing', async () => {
    const harness = buildHarness('/');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    focusableButton();

    await act(async () => {
      result.current.open('agent-warden');
    });

    expect(takeProfileOpener('agent-warden')).not.toBeNull();
    expect(takeProfileOpener('agent-warden')).toBeNull();
  });

  it('does not re-capture a chained push — the root stays whoever opened it first', async () => {
    // A chain (`open(A)`, then a "Managed by" link inside the sheet calling
    // `open(B)`) has `document.activeElement` sitting on a row INSIDE the
    // sheet at the moment of the second call — a row that call is about to
    // navigate away from. Capturing it there would hand focus, on the whole
    // chain's eventual close, to a control that no longer exists — the exact
    // DOR-1274 bug, reintroduced by the chain path (adversarial review fix #2).
    const harness = buildHarness('/');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    const original = focusableButton();

    await act(async () => {
      result.current.open('agent-warden');
    });
    await waitFor(() => expect(harness.readSearch().profile).toBe('agent-warden'));

    // Stands in for the in-sheet "Managed by" link the chain push focuses.
    focusableButton();
    await act(async () => {
      result.current.open('person-dorian');
    });
    await waitFor(() => expect(harness.readSearch().profile).toBe('person-dorian'));

    // Asked about the CHAIN's root, `agent-warden` — never re-captured, so
    // still the ORIGINAL control, not the in-sheet link the chain moved
    // through.
    expect(takeProfileOpener('agent-warden')).toBe(original);
  });

  it('clearProfileOpener discards a capture that will never be claimed', async () => {
    const harness = buildHarness('/');
    const { result } = renderHook(() => useProfileDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    focusableButton();

    await act(async () => {
      result.current.open('agent-warden');
    });
    clearProfileOpener();

    expect(takeProfileOpener('agent-warden')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// useOpenConnections — the navigation that replaced ?relay=open
// ─────────────────────────────────────────────────────────────
describe('useOpenConnections', () => {
  it('navigates to the page, at the half it was asked for', async () => {
    const harness = buildHarness('/');
    const { result } = renderHook(() => useOpenConnections(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await act(async () => {
      result.current('messaging');
    });

    await waitFor(() => {
      expect(harness.readSearch().region).toBe('messaging');
    });
  });

  it('leaves the region unset when none is asked for', async () => {
    const harness = buildHarness('/');
    const { result } = renderHook(() => useOpenConnections(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await act(async () => {
      result.current();
    });

    await waitFor(() => {
      expect(harness.readSearch().region).toBeUndefined();
    });
  });
});
