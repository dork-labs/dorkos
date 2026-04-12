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
    useAgentHubStore.setState({ activeTab: 'overview', agentPath: null });
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
    harness = buildHarness('/?panel=agent-hub&hubTab=personality&agentPath=%2Fagents%2Ftest');
    useAgentHubStore.setState({ activeTab: 'overview', agentPath: null });
    renderHook(() => useAgentHubDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      expect(useAgentHubStore.getState().agentPath).toBe('/agents/test');
      expect(useAgentHubStore.getState().activeTab).toBe('personality');
    });
  });

  it('defaults to overview tab when hubTab is missing', async () => {
    harness = buildHarness('/?panel=agent-hub&agentPath=%2Fagents%2Ftest');
    useAgentHubStore.setState({ activeTab: 'tools', agentPath: null });
    renderHook(() => useAgentHubDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      expect(useAgentHubStore.getState().activeTab).toBe('overview');
    });
  });

  it('defaults to overview tab when hubTab is invalid', async () => {
    harness = buildHarness('/?panel=agent-hub&hubTab=nonexistent&agentPath=%2Fagents%2Ftest');
    renderHook(() => useAgentHubDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      expect(useAgentHubStore.getState().activeTab).toBe('overview');
    });
  });

  it('sets only tab when panel=agent-hub but agentPath is missing', async () => {
    harness = buildHarness('/?panel=agent-hub&hubTab=tools');
    useAgentHubStore.setState({ activeTab: 'overview', agentPath: null });
    renderHook(() => useAgentHubDeepLink(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      expect(useAgentHubStore.getState().activeTab).toBe('tools');
      expect(useAgentHubStore.getState().agentPath).toBeNull();
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

  it('redirects ?agent=identity to ?panel=agent-hub&hubTab=overview', async () => {
    harness = buildHarness('/?agent=identity');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.panel).toBe('agent-hub');
      expect(search.hubTab).toBe('overview');
      expect(search.agent).toBeUndefined();
    });
  });

  it('redirects ?agent=personality to ?panel=agent-hub&hubTab=personality', async () => {
    harness = buildHarness('/?agent=personality');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.panel).toBe('agent-hub');
      expect(search.hubTab).toBe('personality');
      expect(search.agent).toBeUndefined();
    });
  });

  it('redirects ?agent=channels to ?panel=agent-hub&hubTab=channels', async () => {
    harness = buildHarness('/?agent=channels');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.panel).toBe('agent-hub');
      expect(search.hubTab).toBe('channels');
    });
  });

  it('redirects ?agent=tools to ?panel=agent-hub&hubTab=tools', async () => {
    harness = buildHarness('/?agent=tools');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.panel).toBe('agent-hub');
      expect(search.hubTab).toBe('tools');
    });
  });

  it('falls back to overview for unknown agent tab values', async () => {
    harness = buildHarness('/?agent=unknown-tab');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.panel).toBe('agent-hub');
      expect(search.hubTab).toBe('overview');
    });
  });

  it('preserves agentPath during redirect', async () => {
    harness = buildHarness('/?agent=identity&agentPath=%2Ffoo%2Fbar');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.panel).toBe('agent-hub');
      expect(search.hubTab).toBe('overview');
      expect(search.agentPath).toBe('/foo/bar');
      expect(search.agent).toBeUndefined();
    });
  });

  it('redirects ?dialog=agent to ?panel=agent-hub&hubTab=overview', async () => {
    harness = buildHarness('/?dialog=agent');
    renderHook(() => useAgentDialogRedirect(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await waitFor(() => {
      const search = harness.readSearch();
      expect(search.panel).toBe('agent-hub');
      expect(search.hubTab).toBe('overview');
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
