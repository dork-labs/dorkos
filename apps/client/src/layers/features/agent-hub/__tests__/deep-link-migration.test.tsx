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

import { mergeDialogSearch } from '@/layers/shared/model/dialog-search-schema';
import { useAgentHubStore } from '../model/agent-hub-store';
import { useAgentHubDeepLink, useAgentDialogRedirect } from '../model/use-agent-hub-deep-link';

// ── Test router harness ─────────────────────────────────────
//
// Mirrors the harness from use-dialog-deep-link.test.tsx.
// Mounts a single index route at `/` whose `validateSearch` is the merged
// dialog schema plus the hub-specific params, so the deep-link hooks see the
// same shape they would on a real route.

// Extend the base dialog schema with `dialog` — the legacy param consumed by
// `useAgentDialogRedirect`. It is NOT in the production schema (it was removed
// as part of the migration), but the redirect hook still reads it via
// `useSearch({ strict: false })`.  Including it here lets the test router
// preserve it in the URL long enough for the hook to detect and redirect.
const testSearchSchema = mergeDialogSearch(z.object({ dialog: z.string().optional() }));

const HookSlotContext = createContext<ReactNode>(null);

function HookSlot() {
  return <>{useContext(HookSlotContext)}</>;
}

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

  async function waitForRouterReady(): Promise<void> {
    await waitFor(() => {
      expect(router.state.status).toBe('idle');
    });
  }

  return { router, Wrapper, readSearch, waitForRouterReady };
}

type RouterTestHarness = ReturnType<typeof buildHarness>;

// ─────────────────────────────────────────────────────────────
// useAgentHubDeepLink
// ─────────────────────────────────────────────────────────────
describe('useAgentHubDeepLink', () => {
  let harness: RouterTestHarness;

  beforeEach(() => {
    harness = buildHarness('/');
    useAgentHubStore.setState({ activeTab: 'sessions', agentPath: null });
  });

  it('does nothing when panel is not agent-hub', async () => {
    const { result } = renderHook(() => useAgentHubDeepLink(), {
      wrapper: harness.Wrapper,
    });
    await harness.waitForRouterReady();
    // Hook returns void; verify store was not touched
    expect(result.current).toBeUndefined();
    expect(useAgentHubStore.getState().agentPath).toBeNull();
  });

  it('syncs agentPath and hubTab to store when panel=agent-hub', async () => {
    harness = buildHarness('/?panel=agent-hub&hubTab=config&agentPath=%2Fagents%2Ftest');
    useAgentHubStore.setState({ activeTab: 'sessions', agentPath: null });
    renderHook(() => useAgentHubDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      expect(useAgentHubStore.getState().agentPath).toBe('/agents/test');
      expect(useAgentHubStore.getState().activeTab).toBe('config');
    });
  });

  it('defaults to sessions tab when hubTab is missing', async () => {
    harness = buildHarness('/?panel=agent-hub&agentPath=%2Fagents%2Ftest');
    useAgentHubStore.setState({ activeTab: 'config', agentPath: null });
    renderHook(() => useAgentHubDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      expect(useAgentHubStore.getState().activeTab).toBe('sessions');
    });
  });

  it('defaults to sessions tab when hubTab is invalid', async () => {
    harness = buildHarness('/?panel=agent-hub&hubTab=nonexistent&agentPath=%2Fagents%2Ftest');
    renderHook(() => useAgentHubDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      expect(useAgentHubStore.getState().activeTab).toBe('sessions');
    });
  });

  it('sets only tab when panel=agent-hub but agentPath is missing', async () => {
    harness = buildHarness('/?panel=agent-hub&hubTab=sessions');
    useAgentHubStore.setState({ activeTab: 'sessions', agentPath: null });
    renderHook(() => useAgentHubDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      expect(useAgentHubStore.getState().activeTab).toBe('sessions');
      expect(useAgentHubStore.getState().agentPath).toBeNull();
    });
  });

  // TAB_MIGRATION: old 6-tab hub names resolve to new 3-tab equivalents
  it('migrates ?hubTab=overview to sessions', async () => {
    harness = buildHarness('/?panel=agent-hub&hubTab=overview&agentPath=%2Fagents%2Ftest');
    useAgentHubStore.setState({ activeTab: 'sessions', agentPath: null });
    renderHook(() => useAgentHubDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      expect(useAgentHubStore.getState().activeTab).toBe('sessions');
    });
  });

  it('migrates ?hubTab=personality to config', async () => {
    harness = buildHarness('/?panel=agent-hub&hubTab=personality&agentPath=%2Fagents%2Ftest');
    useAgentHubStore.setState({ activeTab: 'sessions', agentPath: null });
    renderHook(() => useAgentHubDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      expect(useAgentHubStore.getState().activeTab).toBe('config');
    });
  });

  it('migrates ?hubTab=channels to config', async () => {
    harness = buildHarness('/?panel=agent-hub&hubTab=channels&agentPath=%2Fagents%2Ftest');
    useAgentHubStore.setState({ activeTab: 'sessions', agentPath: null });
    renderHook(() => useAgentHubDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      expect(useAgentHubStore.getState().activeTab).toBe('config');
    });
  });

  it('migrates ?hubTab=tasks to sessions', async () => {
    harness = buildHarness('/?panel=agent-hub&hubTab=tasks&agentPath=%2Fagents%2Ftest');
    useAgentHubStore.setState({ activeTab: 'sessions', agentPath: null });
    renderHook(() => useAgentHubDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      expect(useAgentHubStore.getState().activeTab).toBe('sessions');
    });
  });

  it('migrates ?hubTab=tools to config', async () => {
    harness = buildHarness('/?panel=agent-hub&hubTab=tools&agentPath=%2Fagents%2Ftest');
    useAgentHubStore.setState({ activeTab: 'sessions', agentPath: null });
    renderHook(() => useAgentHubDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      expect(useAgentHubStore.getState().activeTab).toBe('config');
    });
  });
});

// ─────────────────────────────────────────────────────────────
// useAgentDialogRedirect
// ─────────────────────────────────────────────────────────────
describe('useAgentDialogRedirect', () => {
  let harness: RouterTestHarness;

  beforeEach(() => {
    harness = buildHarness('/');
  });

  it('does nothing when no legacy params are present', async () => {
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    const search = harness.readSearch();
    expect(search.panel).toBeUndefined();
    expect(search.hubTab).toBeUndefined();
  });

  it('redirects ?agent=identity to ?panel=agent-hub&hubTab=sessions', async () => {
    harness = buildHarness('/?agent=identity');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.panel).toBe('agent-hub');
      expect(search.hubTab).toBe('sessions');
      expect(search.agent).toBeUndefined();
    });
  });

  it('redirects ?agent=personality to ?panel=agent-hub&hubTab=config', async () => {
    harness = buildHarness('/?agent=personality');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.panel).toBe('agent-hub');
      expect(search.hubTab).toBe('config');
      expect(search.agent).toBeUndefined();
    });
  });

  it('redirects ?agent=channels to ?panel=agent-hub&hubTab=config', async () => {
    harness = buildHarness('/?agent=channels');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.panel).toBe('agent-hub');
      expect(search.hubTab).toBe('config');
    });
  });

  it('redirects ?agent=tools to ?panel=agent-hub&hubTab=config', async () => {
    harness = buildHarness('/?agent=tools');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.panel).toBe('agent-hub');
      expect(search.hubTab).toBe('config');
    });
  });

  it('falls back to sessions for unknown agent tab values', async () => {
    harness = buildHarness('/?agent=unknown-tab');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.panel).toBe('agent-hub');
      expect(search.hubTab).toBe('sessions');
    });
  });

  it('preserves agentPath during redirect', async () => {
    harness = buildHarness('/?agent=identity&agentPath=%2Ffoo%2Fbar');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.panel).toBe('agent-hub');
      expect(search.hubTab).toBe('sessions');
      expect(search.agentPath).toBe('/foo/bar');
      expect(search.agent).toBeUndefined();
    });
  });

  it('redirects ?dialog=agent to ?panel=agent-hub&hubTab=sessions', async () => {
    harness = buildHarness('/?dialog=agent');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.panel).toBe('agent-hub');
      expect(search.hubTab).toBe('sessions');
      expect(search.dialog).toBeUndefined();
    });
  });

  it('clears both agent and dialog legacy params', async () => {
    harness = buildHarness('/?agent=tools&dialog=agent');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.agent).toBeUndefined();
      expect(search.dialog).toBeUndefined();
      expect(search.panel).toBe('agent-hub');
    });
  });
});
