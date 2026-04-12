/**
 * @vitest-environment jsdom
 */
import { createContext, useContext, type ReactNode } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
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
import { useSettingsDeepLink, useTasksDeepLink, useRelayDeepLink } from '../use-dialog-deep-link';

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
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });

  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(testSearchSchema),
    component: HookSlot,
  });

  const routeTree = rootRoute.addChildren([indexRoute]);
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

  return { router, actions, Wrapper, readSearch, waitForRouterReady };
}

type RouterTestHarness = ReturnType<typeof buildHarness>;

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
// useTasksDeepLink / useRelayDeepLink
// ─────────────────────────────────────────────────────────────
describe('useTasksDeepLink / useRelayDeepLink', () => {
  const cases = [
    { name: 'tasks' as const, hook: useTasksDeepLink },
    { name: 'relay' as const, hook: useRelayDeepLink },
  ];

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
    });
  }
});
